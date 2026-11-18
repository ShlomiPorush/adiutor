import { desc, eq, isNotNull } from "drizzle-orm"
import type { SyncOutcome } from "../../shared/enums.ts"
import { projects, syncRuns } from "../db/schema.ts"
import { AppError } from "../errors.ts"
import { errorFacts, log } from "../log.ts"
import { getSettings, type SettingsEnv } from "../services/admin.ts"
import type { Ctx } from "../services/context.ts"
import { type ApplyResult, applyPull, GITHUB_RUN_KIND } from "./apply.ts"
import type { GitHubGate } from "./gate.ts"
import { type InstallationRead, type PullRead, readGitHub } from "./pull.ts"
import { effectiveGitHub } from "./settings.ts"

// The server's pulls from GitHub: every hour on the hour, at start when the last pull started more than an hour ago,
// and when the owner presses Read now. One at a time in this process (Read now during a pull joins it), each within
// ten minutes. A rate limit holds every pull until it ends; a save of the GitHub settings stops a running pull at once.

const HOUR_MS = 60 * 60 * 1000
/** A pull that takes longer is aborted: nothing of it is written. */
export const PULL_DEADLINE_MS = 10 * 60 * 1000

export type PullSummary =
  | { result: "off" }
  | { result: "stopped"; reason: "superseded" | "aborted" }
  | { result: "written"; runId: string; outcome: SyncOutcome }
  | { result: "not_written"; code: string }

/** What the last pull of this process found that the run row does not keep: each installation's state, renames. */
export type LastPull = {
  finishedAt: Date
  installations: InstallationRead[]
  moved: { projectId: string; to: string }[]
}

export type GitHubRunnerDeps = {
  ctx: Ctx
  env: SettingsEnv
  gate: GitHubGate
  origin: string
  /** Test seam: runs after the reading, before the write transaction. */
  beforeWrite?: () => Promise<void>
  /** Test seam: runs inside the write transaction once it holds the shared GitHub lock. */
  afterLock?: () => Promise<void>
}

export class GitHubRunner {
  private current: Promise<PullSummary> | null = null
  private controller: AbortController | null = null
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private blockedUntil: Date | null = null
  private last: LastPull | null = null
  private readonly unsubscribe: () => void

  constructor(private readonly deps: GitHubRunnerDeps) {
    // A save of the GitHub settings stops the running pull: it would write nothing anyway.
    this.unsubscribe = deps.gate.onSave(() => this.controller?.abort())
  }

  /** What Settings, GitHub shows about the pulls of this process. */
  state() {
    const now = this.deps.ctx.clock()
    return {
      running: this.current !== null,
      rateLimitedUntil: this.blockedUntil && this.blockedUntil > now ? this.blockedUntil : null,
      last: this.last,
    }
  }

  /** Starts the hourly schedule, and a pull now when the last one started more than an hour ago (or never). */
  async start(): Promise<void> {
    this.schedule()
    const [last] = await this.deps.ctx.db
      .select({ startedAt: syncRuns.startedAt })
      .from(syncRuns)
      .where(eq(syncRuns.kind, GITHUB_RUN_KIND))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1)
    if (!last || this.deps.ctx.clock().getTime() - last.startedAt.getTime() > HOUR_MS) void this.pull()
  }

  /** Stops the schedule and aborts a running pull (shutdown). */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.unsubscribe()
    this.controller?.abort()
    await this.current?.catch(() => {})
  }

  private schedule() {
    if (this.stopped) return
    const now = this.deps.ctx.clock().getTime()
    // Asia/Jerusalem is a whole number of hours from UTC, so its hour starts with UTC's.
    this.timer = setTimeout(
      () => {
        void this.pull().finally(() => this.schedule())
      },
      HOUR_MS - (now % HOUR_MS),
    )
    this.timer.unref()
  }

  /**
   * Read now: starts a pull, or joins the one running. Refused while GitHub is not set up or a rate limit holds; the
   * answer does not wait for the pull.
   */
  async readNow(): Promise<{ joined: boolean }> {
    if (this.current) return { joined: true }
    const row = await getSettings(this.deps.ctx.db)
    if (!effectiveGitHub(row, this.deps.env.overrides, this.deps.env.cipher).on)
      throw new AppError("github_not_set_up", "Set the App id, its key and an installation first.")
    const until = this.state().rateLimitedUntil
    if (until) throw new AppError("github_rate_limited", "GitHub asked to wait before the next read.", { until })
    void this.pull()
    return { joined: false }
  }

  /** One pull, or the one running. Never throws: a failure is logged with a stable code. */
  pull(): Promise<PullSummary> {
    if (this.current) return this.current
    const run = this.run()
      .catch((error: unknown): PullSummary => {
        log.error("github pull failed", errorFacts(error))
        return { result: "not_written", code: "internal_error" }
      })
      .finally(() => {
        this.current = null
        this.controller = null
      })
    this.current = run
    return run
  }

  private async run(): Promise<PullSummary> {
    const { ctx, env, gate, origin } = this.deps
    if (this.stopped) return { result: "stopped", reason: "aborted" }
    if (this.blockedUntil && this.blockedUntil > ctx.clock()) return { result: "not_written", code: "rate_limited" }
    const row = await getSettings(ctx.db)
    const github = effectiveGitHub(row, env.overrides, env.cipher)
    if (!github.on || !github.appId || !github.privateKey) return { result: "off" }
    const generation = row.githubGeneration
    if (!gate.maySend(generation)) return { result: "stopped", reason: "superseded" }
    const list = await ctx.db
      .select({
        id: projects.id,
        githubRepo: projects.githubRepo,
        githubRepoVersion: projects.githubRepoVersion,
        githubRepoId: projects.githubRepoId,
      })
      .from(projects)
      .where(isNotNull(projects.githubRepo))

    const controller = new AbortController()
    this.controller = controller
    const deadline = setTimeout(() => controller.abort(), PULL_DEADLINE_MS)
    deadline.unref()
    const startedAt = ctx.clock()
    let read: PullRead
    try {
      read = await readGitHub(
        {
          appId: github.appId,
          privateKey: github.privateKey,
          installations: github.installations,
          projects: list.map((p) => ({ ...p, githubRepo: p.githubRepo as string })),
        },
        { origin, signal: controller.signal, maySend: () => gate.maySend(generation), clock: ctx.clock },
      )
    } finally {
      clearTimeout(deadline)
    }
    if (read.stopped?.kind === "rate_limit") this.blockedUntil = read.stopped.until
    if (read.stopped?.kind === "superseded" || read.stopped?.kind === "aborted" || controller.signal.aborted) {
      log.info("github pull stopped", { reason: read.stopped?.kind ?? "aborted" })
      return { result: "stopped", reason: read.stopped?.kind === "superseded" ? "superseded" : "aborted" }
    }
    await this.deps.beforeWrite?.()
    let applied: ApplyResult
    try {
      applied = await applyPull(ctx, {
        read,
        generation,
        startedAt,
        keyStored: env.overrides.githubPrivateKey === undefined,
        afterLock: this.deps.afterLock,
      })
    } catch (error) {
      // A lock or statement timeout, or a conflict: nothing was written; the next pull runs as usual.
      const code = (error as { code?: unknown }).code
      log.warn("github pull not written", { code: typeof code === "string" ? code : "write_failed" })
      return { result: "not_written", code: "write_failed" }
    }
    if (!applied.written) {
      log.info("github pull stopped", { reason: "superseded" })
      return { result: "stopped", reason: "superseded" }
    }
    this.last = {
      finishedAt: ctx.clock(),
      installations: read.installations,
      moved: read.projects.flatMap((p) => (p.movedTo ? [{ projectId: p.projectId, to: p.movedTo }] : [])),
    }
    log.info("github pull", { outcome: applied.outcome, ...applied.counts })
    return { result: "written", runId: applied.runId, outcome: applied.outcome }
  }
}
