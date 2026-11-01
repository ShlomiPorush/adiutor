import { and, desc, eq } from "drizzle-orm"
import type { JobState } from "../../shared/enums.ts"
import { jobRuns } from "../db/schema.ts"
import { AppError } from "../errors.ts"
import { log } from "../log.ts"
import { getSettings, lastVisitAnyDevice } from "../services/admin.ts"
import { type By, type Ctx, requireOwner, writeAudit } from "../services/context.ts"
import { morning } from "../services/reads.ts"
import { TelegramError } from "../telegram/api.ts"
import type { TelegramHtml } from "../telegram/html.ts"
import { buildMorningMessage, type MorningSummary } from "./morning-message.ts"
import { localTime } from "./time.ts"

export const MORNING_JOB = "morning"
/** 08:00 Asia/Jerusalem, Sunday to Friday. Fixed: it must stay after the reconciler's fixed T3 schedule. */
export const MORNING_HOUR = 8
/** A missed morning is sent late until 3 hours after its time; after that the day is skipped. */
export const CUTOFF_HOUR = 11
const SATURDAY = 6
export const TICK_MS = 30_000

export type JobRunRow = typeof jobRuns.$inferSelect

export type MorningDecision =
  | { action: "none"; reason: "saturday" | "too_early" | "done" | "in_progress" }
  | { action: "send"; localDate: string; retry: boolean }
  | { action: "skip"; localDate: string }

/** What the job does at `now`, given today's run (null when there is none). Pure. */
export function decideMorning(now: Date, run: Pick<JobRunRow, "state"> | null): MorningDecision {
  const local = localTime(now)
  if (local.weekday === SATURDAY) return { action: "none", reason: "saturday" }
  if (local.hour < MORNING_HOUR) return { action: "none", reason: "too_early" }
  const late = local.hour >= CUTOFF_HOUR
  switch (run?.state) {
    case undefined:
      return late ? { action: "skip", localDate: local.date } : { action: "send", localDate: local.date, retry: false }
    case "failed":
      return late ? { action: "skip", localDate: local.date } : { action: "send", localDate: local.date, retry: true }
    case "sending":
      return { action: "none", reason: "in_progress" }
    default:
      return { action: "none", reason: "done" }
  }
}

export async function readRun(ctx: Ctx, localDate: string): Promise<JobRunRow | null> {
  const [row] = await ctx.db
    .select()
    .from(jobRuns)
    .where(and(eq(jobRuns.job, MORNING_JOB), eq(jobRuns.localDate, localDate)))
  return row ?? null
}

/** The latest morning run, for the status route. */
export async function lastRun(ctx: Ctx): Promise<JobRunRow | null> {
  const [row] = await ctx.db
    .select()
    .from(jobRuns)
    .where(eq(jobRuns.job, MORNING_JOB))
    .orderBy(desc(jobRuns.localDate))
    .limit(1)
  return row ?? null
}

/**
 * At start-up: a run left in `sending` was interrupted while its message may have gone out. It becomes
 * `unknown` and is never sent again: at most once, never twice.
 */
export async function recoverInterrupted(ctx: Ctx): Promise<number> {
  const rows = await ctx.db
    .update(jobRuns)
    .set({ state: "unknown", detail: "interrupted", at: ctx.clock() })
    .where(and(eq(jobRuns.job, MORNING_JOB), eq(jobRuns.state, "sending")))
    .returning({ id: jobRuns.id })
  return rows.length
}

/**
 * Takes the day's run as `sending`: a new row (the unique job and date keep a second process or tick out),
 * or a `failed` row by compare-and-set. Null when someone else holds it.
 */
async function claim(ctx: Ctx, localDate: string, retry: boolean): Promise<JobRunRow | null> {
  const now = ctx.clock()
  if (retry) {
    const [row] = await ctx.db
      .update(jobRuns)
      .set({ state: "sending", at: now })
      .where(and(eq(jobRuns.job, MORNING_JOB), eq(jobRuns.localDate, localDate), eq(jobRuns.state, "failed")))
      .returning()
    return row ?? null
  }
  const [row] = await ctx.db
    .insert(jobRuns)
    .values({ job: MORNING_JOB, localDate, state: "sending", at: now })
    .onConflictDoNothing()
    .returning()
  return row ?? null
}

async function finish(ctx: Ctx, id: string, state: JobState, detail: string | null): Promise<void> {
  await ctx.db.update(jobRuns).set({ state, detail, at: ctx.clock() }).where(eq(jobRuns.id, id))
}

/** Marks the day skipped: no row yet, or a failed one. A run in progress or finished is left alone. */
async function skip(ctx: Ctx, localDate: string): Promise<boolean> {
  const now = ctx.clock()
  const inserted = await ctx.db
    .insert(jobRuns)
    .values({ job: MORNING_JOB, localDate, state: "skipped", at: now, detail: "late" })
    .onConflictDoNothing()
    .returning({ id: jobRuns.id })
  if (inserted.length > 0) return true
  const updated = await ctx.db
    .update(jobRuns)
    .set({ state: "skipped", at: now })
    .where(and(eq(jobRuns.job, MORNING_JOB), eq(jobRuns.localDate, localDate), eq(jobRuns.state, "failed")))
    .returning({ id: jobRuns.id })
  return updated.length > 0
}

/** The time of the last morning message that went out, or null. */
async function lastSentAt(ctx: Ctx): Promise<Date | null> {
  const [row] = await ctx.db
    .select({ at: jobRuns.at })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, MORNING_JOB), eq(jobRuns.state, "sent")))
    .orderBy(desc(jobRuns.at))
    .limit(1)
  return row?.at ?? null
}

/**
 * The message's content: the morning read model since the owner's last visit on any device, or since the
 * last morning message when that is later (24 hours back when there is neither).
 */
export async function morningSummary(ctx: Ctx): Promise<MorningSummary> {
  const times = [await lastVisitAnyDevice(ctx), await lastSentAt(ctx)].filter((d): d is Date => d !== null)
  const since = times.length > 0 ? new Date(Math.max(...times.map((d) => d.getTime()))) : undefined
  const view = await morning(ctx, { since })
  return { waiting: view.waiting, newCount: view.new.length, security: view.security, sync: view.sync }
}

export async function buildTodaysMessage(ctx: Ctx, publicUrl: URL): Promise<TelegramHtml> {
  const settings = await getSettings(ctx.db)
  return buildMorningMessage(await morningSummary(ctx), {
    language: settings.language,
    publicUrl,
    dateFormat: settings.dateFormat,
    timeFormat: settings.timeFormat,
  })
}

/**
 * The owner's test of the morning message: today's message, built exactly as the job builds it, sent to
 * the owner's chat now. It never touches job_runs, so the 08:00 message still goes out. Audited.
 */
export async function sendTestMorningMessage(
  ctx: Ctx,
  by: By,
  publicUrl: URL,
  send: ((text: TelegramHtml) => Promise<void>) | undefined,
): Promise<{ sent: true }> {
  requireOwner(by, "send a test morning message")
  if (!send)
    throw new AppError(
      "conflict",
      "Telegram is not configured: set MIKUD_TELEGRAM_BOT_TOKEN and MIKUD_TELEGRAM_CHAT_ID on the server.",
    )
  const text = await buildTodaysMessage(ctx, publicUrl)
  let outcome = "sent"
  try {
    await send(text)
  } catch (error) {
    outcome = error instanceof TelegramError ? error.code : "unexpected"
  }
  await writeAudit(ctx, ctx.db, by, {
    action: "telegram.test_message",
    entityType: "settings",
    entityId: null,
    after: { outcome },
  })
  if (outcome !== "sent") {
    log.warn("test morning message failed", { code: outcome })
    throw new AppError("telegram_failed", `Telegram did not take the message (${outcome}). Check the bot settings.`)
  }
  return { sent: true }
}

export type MorningJobDeps = {
  ctx: Ctx
  publicUrl: URL
  /** Sends the message to the owner's chat. Throws TelegramError on failure. */
  send(text: TelegramHtml, signal: AbortSignal): Promise<void>
}

export type TickResult = MorningDecision | { action: "sent" | "failed" | "unknown" | "lost"; localDate: string }

/** The morning message: a tick every 30 seconds decides from the clock and the day's durable run. */
export class MorningJob {
  private timer: NodeJS.Timeout | undefined
  private running: Promise<unknown> | undefined
  private readonly stopping = new AbortController()

  constructor(private readonly deps: MorningJobDeps) {}

  async start(): Promise<void> {
    const recovered = await recoverInterrupted(this.deps.ctx)
    if (recovered > 0) log.warn("morning message: an interrupted run is marked unknown and not resent", { recovered })
    this.timer = setInterval(() => void this.safeTick(), TICK_MS)
    void this.safeTick()
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    this.stopping.abort()
    await this.running
  }

  private async safeTick() {
    if (this.running || this.stopping.signal.aborted) return
    const run = this.tick().catch((error) => {
      log.error("morning message: tick failed", { error: error instanceof Error ? error.name : "unknown" })
    })
    this.running = run
    await run
    this.running = undefined
  }

  /** One decision and, when due, one send. Exposed for tests. */
  async tick(): Promise<TickResult> {
    const { ctx } = this.deps
    const now = ctx.clock()
    const decision = decideMorning(now, await readRun(ctx, localTime(now).date))
    if (decision.action === "none") return decision
    if (decision.action === "skip") {
      if (await skip(ctx, decision.localDate)) log.warn("morning message skipped: too late", decision)
      return decision
    }

    const run = await claim(ctx, decision.localDate, decision.retry)
    if (!run) return { action: "lost", localDate: decision.localDate }
    const localDate = decision.localDate

    let text: TelegramHtml
    try {
      text = await buildTodaysMessage(ctx, this.deps.publicUrl)
    } catch (error) {
      // Nothing went out: retried on the next tick until the cutoff.
      await finish(ctx, run.id, "failed", "build_failed")
      log.error("morning message: building failed", { localDate, error: error instanceof Error ? error.name : "" })
      return { action: "failed", localDate }
    }

    try {
      await this.deps.send(text, this.stopping.signal)
    } catch (error) {
      const definite = error instanceof TelegramError && (error.failure === "answer" || error.failure === "not_sent")
      const code = error instanceof TelegramError ? error.code : "unexpected"
      // A definite failure is retried; anything else may have gone out and is never resent.
      await finish(ctx, run.id, definite ? "failed" : "unknown", code)
      log.warn(definite ? "morning message failed; retrying" : "morning message may not have arrived", {
        localDate,
        code,
      })
      return { action: definite ? "failed" : "unknown", localDate }
    }

    await finish(ctx, run.id, "sent", null)
    log.info("morning message sent", { localDate })
    return { action: "sent", localDate }
  }
}
