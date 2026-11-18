import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm"
import type { SyncCheckin } from "../../shared/api.ts"
import type { SyncRequestState } from "../../shared/enums.ts"
import { type SyncRequestResult, type SyncRunning, syncClient, syncRequests, syncRuns } from "../db/schema.ts"
import { AppError, notFound } from "../errors.ts"
import { syncConnected } from "../oauth/sync-status.ts"
import { type By, type Ctx, requireOwner, type Tx, writeAudit } from "./context.ts"

/*
 * Syncs the owner asks for from Adiutor ("Sync now"), and the check-in of the sync on the owner's computer (the sync
 * tray plan, section 4, "Adiutor server and UI"). The server never calls the computer: the tray checks in every minute
 * with its state, and takes a waiting request in the answer. One computer for now (owner's decision): `sync_client`
 * keeps a row per connection, and the owner sees the one that checked in last.
 */

/** A claim is the computer's for this long after each check-in; then it is `unknown` (a late result still lands). */
export const SYNC_LEASE_MS = 10 * 60_000
/** The tray checks in every minute; after three missed check-ins the computer counts as silent. */
export const SYNC_CHECKIN_EVERY_MS = 60_000
export const SYNC_SILENT_AFTER_MS = 3 * SYNC_CHECKIN_EVERY_MS

export type SyncRequestRow = typeof syncRequests.$inferSelect
export type SyncClientRow = typeof syncClient.$inferSelect

/**
 * One transaction-level advisory lock, taken as the first statement of every transaction that changes sync_requests or
 * sync_client (Sync now, Cancel, the check-in, and the lease expiry inside each): they run one at a time, so no order
 * of row locks among them can deadlock (as the link structure lock does for thread links, services/context.ts).
 */
export const SYNC_REQUESTS_LOCK_KEY = 0x73796e63

function inRequestsTx<T>(ctx: Ctx, run: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(SYNC_REQUESTS_LOCK_KEY))})`)
    return run(tx)
  })
}

/** The kinds of the runs the sync on the PC pushes (`security` only before the server read GitHub). */
const PC_RUN_KINDS = ["t3", "security"]

/** The states a request can still leave: at most one request is in one of them (sync_requests_one_open_idx). */
const OPEN: SyncRequestState[] = ["waiting", "claimed"]

/**
 * The state a request ends in, from its parts: done when every part was accepted, failed when none got through. The
 * server reads GitHub itself, so a sync that no longer collects security reports that part `not_run`: it is not this
 * computer's part, and T3 alone decides.
 */
export function finishedState(result: SyncRequestResult): "done" | "partial" | "failed" {
  const parts = result.security === "not_run" ? [result.t3] : [result.t3, result.security]
  if (parts.every((p) => p === "accepted")) return "done"
  if (parts.some((p) => p === "accepted" || p === "partial")) return "partial"
  return "failed"
}

/** A claim whose lease passed without a check-in: the computer stopped answering. */
async function expireLeases(ctx: Ctx, tx: Tx): Promise<void> {
  await tx
    .update(syncRequests)
    .set({ state: "unknown" })
    .where(and(eq(syncRequests.state, "claimed"), lt(syncRequests.leaseUntil, ctx.clock())))
}

/** A request as the owner reads it: a claim whose lease passed reads `unknown` before any check-in writes it. */
export function requestView(ctx: Ctx, row: SyncRequestRow) {
  const expired = row.state === "claimed" && row.leaseUntil !== null && row.leaseUntil < ctx.clock()
  return {
    id: row.id,
    requestedAt: row.requestedAt,
    state: expired ? ("unknown" as const) : row.state,
    claimedAt: row.claimedAt,
    leaseUntil: row.leaseUntil,
    finishedAt: row.finishedAt,
    result: row.result,
  }
}

/**
 * "Sync now": a new waiting request, or the one already waiting or claimed (a second press answers it). A claim whose
 * lease passed is `unknown` first, so a computer that stopped answering never holds the next press.
 */
export async function requestSync(ctx: Ctx, by: By) {
  requireOwner(by, "ask for a sync")
  return inRequestsTx(ctx, async (tx) => {
    await expireLeases(ctx, tx)
    const [created] = await tx
      .insert(syncRequests)
      .values({ requestedAt: ctx.clock(), requestedBy: by.actor.kind, state: "waiting" })
      .onConflictDoNothing()
      .returning()
    if (created) {
      await writeAudit(ctx, tx, by, {
        action: "sync_request.create",
        entityType: "sync_request",
        entityId: created.id,
        after: created,
      })
      return { request: requestView(ctx, created), created: true }
    }
    const [open] = await tx.select().from(syncRequests).where(inArray(syncRequests.state, OPEN)).limit(1)
    if (!open) throw new AppError("conflict", "Another request was made at the same time. Try again.")
    return { request: requestView(ctx, open), created: false }
  })
}

/** Cancels a request that still waits for the computer; one it claimed runs to its end. */
export async function cancelSyncRequest(ctx: Ctx, by: By, id: string) {
  requireOwner(by, "cancel a sync")
  return inRequestsTx(ctx, async (tx) => {
    await expireLeases(ctx, tx)
    const [cancelled] = await tx
      .update(syncRequests)
      .set({ state: "cancelled", finishedAt: ctx.clock() })
      .where(and(eq(syncRequests.id, id), eq(syncRequests.state, "waiting")))
      .returning()
    if (!cancelled) {
      const [row] = await tx.select({ state: syncRequests.state }).from(syncRequests).where(eq(syncRequests.id, id))
      if (!row) throw notFound("The sync request")
      throw new AppError("conflict", "Only a sync that still waits for the computer can be cancelled.", {
        state: row.state,
      })
    }
    await writeAudit(ctx, tx, by, {
      action: "sync_request.cancel",
      entityType: "sync_request",
      entityId: id,
      before: { state: "waiting" },
      after: cancelled,
    })
    return requestView(ctx, cancelled)
  })
}

/** Whether a pause the computer reported holds now: until a time, or until resumed. */
const pausedNow = (ctx: Ctx, report: Pick<SyncCheckin, "paused" | "pausedUntil">) =>
  report.paused && (report.pausedUntil === null || report.pausedUntil > ctx.clock())

/**
 * A check-in of the sync on the owner's computer, made by the agent connection `connectionId`. A state report: sent
 * twice, it changes nothing more, so a check-in whose answer was lost is safe to send again. In one transaction:
 * claims whose lease passed become `unknown`; each finished request this connection claimed takes its result
 * (`claimed` or `unknown` only: the final states ignore later reports); the reported running request's lease is
 * renewed; the answer is the claim this connection holds and has not finished, or else, when the computer is not paused
 * and nothing runs, the oldest waiting request, claimed atomically; and last the client's state is recorded. Under the
 * sync requests lock (inRequestsTx), so check-ins, Sync now and Cancel run one at a time. `afterFinished` and
 * `beforeClientState` are test seams: they run once the finished requests, and once all request rows, are written.
 */
export async function checkIn(
  ctx: Ctx,
  connectionId: string,
  report: SyncCheckin,
  hooks: { afterFinished?: () => Promise<void>; beforeClientState?: () => Promise<void> } = {},
) {
  return inRequestsTx(ctx, async (tx) => {
    const now = ctx.clock()
    const leaseUntil = new Date(now.getTime() + SYNC_LEASE_MS)
    await expireLeases(ctx, tx)
    const running: SyncRunning =
      report.running === null
        ? null
        : report.running.kind === "request"
          ? { kind: "request", requestId: report.running.requestId }
          : { kind: "local", startedAt: report.running.startedAt.toISOString() }

    // In the order of their ids, whatever order the computer sent them in: two check-ins at once lock the same rows
    // in the same order, so neither waits for the other in a circle.
    const finished = [...report.finished].sort((a, b) =>
      a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0,
    )
    for (const { requestId, result } of finished) {
      await tx
        .update(syncRequests)
        .set({ state: finishedState(result), result, finishedAt: now })
        .where(
          and(
            eq(syncRequests.id, requestId),
            eq(syncRequests.claimedBy, connectionId),
            inArray(syncRequests.state, ["claimed", "unknown"]),
          ),
        )
    }

    await hooks.afterFinished?.()
    if (running?.kind === "request")
      await tx
        .update(syncRequests)
        .set({ leaseUntil })
        .where(
          and(
            eq(syncRequests.id, running.requestId),
            eq(syncRequests.claimedBy, connectionId),
            eq(syncRequests.state, "claimed"),
          ),
        )

    const [held] = await tx
      .select()
      .from(syncRequests)
      .where(and(eq(syncRequests.claimedBy, connectionId), eq(syncRequests.state, "claimed")))
      .orderBy(asc(syncRequests.claimedAt))
      .limit(1)
    let claim = held
    if (!claim && running === null && !pausedNow(ctx, report)) {
      // One UPDATE ... WHERE state = 'waiting': of two check-ins at once, the second finds the row claimed.
      const oldest = tx
        .select({ id: syncRequests.id })
        .from(syncRequests)
        .where(eq(syncRequests.state, "waiting"))
        .orderBy(asc(syncRequests.requestedAt))
        .limit(1)
      ;[claim] = await tx
        .update(syncRequests)
        .set({ state: "claimed", claimedBy: connectionId, claimedAt: now, leaseUntil })
        .where(and(inArray(syncRequests.id, oldest), eq(syncRequests.state, "waiting")))
        .returning()
    }

    await hooks.beforeClientState?.()
    const state = {
      lastCheckinAt: now,
      version: report.version,
      paused: report.paused,
      pausedUntil: report.paused ? report.pausedUntil : null,
      nextRunAt: report.nextRunAt,
      running,
    }
    await tx
      .insert(syncClient)
      .values({ connectionId, ...state })
      .onConflictDoUpdate({ target: syncClient.connectionId, set: state })
    return {
      claim: claim ? { requestId: claim.id, claimedAt: claim.claimedAt, leaseUntil: claim.leaseUntil } : null,
    }
  })
}

/**
 * What Settings, Sync and the sync card show: the latest request and the computer that checked in last, with whether
 * it went silent, and why "Sync now" cannot be used. No computer ever checked in: `no_client` when no sync was ever
 * seen (get the tray app), `older_client` when a sync is connected or has pushed without checking in (it does not take
 * requests from Adiutor).
 */
export async function syncRequestsView(ctx: Ctx) {
  const now = ctx.clock()
  const [[latest], [client]] = await Promise.all([
    ctx.db.select().from(syncRequests).orderBy(desc(syncRequests.requestedAt)).limit(1),
    ctx.db.select().from(syncClient).orderBy(desc(syncClient.lastCheckinAt)).limit(1),
  ])
  let unavailable: "no_client" | "older_client" | null = null
  if (!client) {
    const [[run], connected] = await Promise.all([
      // Only the PC's runs tell of a sync: the server's own GitHub pulls are not one.
      ctx.db.select({ id: syncRuns.id }).from(syncRuns).where(inArray(syncRuns.kind, PC_RUN_KINDS)).limit(1),
      syncConnected(ctx.db, now),
    ])
    unavailable = run || connected ? "older_client" : "no_client"
  }
  return {
    request: latest ? requestView(ctx, latest) : null,
    client: client
      ? {
          lastCheckinAt: client.lastCheckinAt,
          version: client.version,
          paused: client.paused && (client.pausedUntil === null || client.pausedUntil > now),
          pausedUntil: client.pausedUntil,
          nextRunAt: client.nextRunAt,
          running: client.running,
          silent: now.getTime() - client.lastCheckinAt.getTime() > SYNC_SILENT_AFTER_MS,
        }
      : null,
    unavailable,
  }
}
