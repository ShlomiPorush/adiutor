import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm"
import type { SessionEndReason } from "../../shared/auth.ts"
import { authSession, authUser } from "../db/schema.ts"
import { getSettings, type SettingsRow } from "./admin.ts"
import { type Ctx, inAuthTx, type Tx, writeAudit } from "./context.ts"

/*
 * The two clocks of a browser session, set in Settings:
 * - max: it ends sessionMaxDays after sign-in (authenticated_at), whatever its activity;
 * - idle (off by default): it ends sessionIdleMinutes after the last real input the page reported (active_at).
 * Polling and page refreshes never count as input. Better Auth keeps every session SESSION_LIBRARY_DAYS and
 * never extends it, so these clocks always decide first. A session that ended keeps its row and reason, so every
 * later request, also from another tab, is answered with that reason; the hourly sweep removes it.
 */

export type Policy = { maxDays: number; idle: boolean; idleMinutes: number }
export type Clocks = { authenticatedAt: Date; activeAt: Date }

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export const policyOf = (row: SettingsRow): Policy => ({
  maxDays: row.sessionMaxDays,
  idle: row.sessionIdle,
  idleMinutes: row.sessionIdleMinutes,
})

export function deadlines(clocks: Clocks, policy: Policy): { max: Date; idle: Date | null } {
  return {
    max: new Date(clocks.authenticatedAt.getTime() + policy.maxDays * DAY),
    idle: policy.idle ? new Date(clocks.activeAt.getTime() + policy.idleMinutes * MINUTE) : null,
  }
}

/** The clock that ended the session by `now` (the one that passed first; a tie goes to max), or null. */
export function endedBy(
  clocks: Clocks,
  policy: Policy,
  now: Date,
): { reason: SessionEndReason; deadline: Date } | null {
  const d = deadlines(clocks, policy)
  let found: { reason: SessionEndReason; deadline: Date } | null = null
  for (const reason of ["max", "idle"] as const) {
    const deadline = d[reason]
    if (!deadline || deadline.getTime() > now.getTime()) continue
    if (!found || deadline.getTime() < found.deadline.getTime()) found = { reason, deadline }
  }
  return found
}

/** Seconds left on each clock, rounded up so a live session never reads as zero. */
export type SessionStatus = { max: { remainingSec: number }; idle: { timeoutSec: number; remainingSec: number } | null }

export function statusOf(clocks: Clocks, policy: Policy, now: Date): SessionStatus {
  const d = deadlines(clocks, policy)
  const left = (at: Date) => Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 1000))
  return {
    max: { remainingSec: left(d.max) },
    idle: d.idle ? { timeoutSec: policy.idleMinutes * 60, remainingSec: left(d.idle) } : null,
  }
}

/** `check` only decides; `activity` also records real input (restarts the idle clock). */
export type CheckMode = "check" | "activity"

export type LiveSession = {
  id: string
  userId: string
  username: string
  twoFactorAt: Date | null
  clocks: Clocks
  status: SessionStatus
}

export type CheckResult = { ok: true; session: LiveSession } | { ok: false; reason: SessionEndReason | "revoked" }

/**
 * Decides, inside `tx`, whether a session may go on. The row is locked for the decision and the time is read
 * once the lock is held, so input reported by another tab is never overtaken by an older check, and only the
 * request that ends a session writes its audit row (in the same transaction).
 */
export async function checkSessionIn(ctx: Ctx, tx: Tx, sessionId: string, mode: CheckMode): Promise<CheckResult> {
  const [row] = await tx
    .select({
      id: authSession.id,
      userId: authSession.userId,
      authenticatedAt: authSession.authenticatedAt,
      activeAt: authSession.activeAt,
      twoFactorAt: authSession.twoFactorAt,
      endedReason: authSession.endedReason,
      sessionEpoch: authSession.authEpoch,
      userEpoch: authUser.authEpoch,
      username: authUser.username,
      name: authUser.name,
    })
    .from(authSession)
    .innerJoin(authUser, eq(authUser.id, authSession.userId))
    .where(eq(authSession.id, sessionId))
    .for("update", { of: authSession })
  if (!row) return { ok: false, reason: "revoked" }
  // A session Mikud never recorded, or one from before a credentials reset, is not valid (see auth_epoch).
  if (row.sessionEpoch === null || row.sessionEpoch !== row.userEpoch) return { ok: false, reason: "revoked" }
  if (row.endedReason) return { ok: false, reason: row.endedReason === "idle" ? "idle" : "max" }
  const policy = policyOf(await getSettings(tx))
  const now = ctx.clock()
  const username = row.username ?? row.name
  const ended = endedBy(row, policy, now)
  if (ended) {
    await tx.update(authSession).set({ endedReason: ended.reason, endedAt: now }).where(eq(authSession.id, sessionId))
    await writeAudit(
      ctx,
      tx,
      { actor: { kind: "owner", label: username }, source: "ui" },
      {
        action: "session.end",
        entityType: "session",
        entityId: null,
        after: { reason: ended.reason, deadline: ended.deadline, noticed: now },
      },
    )
    return { ok: false, reason: ended.reason }
  }
  const clocks: Clocks = { authenticatedAt: row.authenticatedAt, activeAt: row.activeAt }
  if (mode === "activity") {
    clocks.activeAt = now
    await tx.update(authSession).set({ activeAt: now }).where(eq(authSession.id, sessionId))
  }
  return {
    ok: true,
    session: {
      id: row.id,
      userId: row.userId,
      username,
      twoFactorAt: row.twoFactorAt,
      clocks,
      status: statusOf(clocks, policy, now),
    },
  }
}

/** checkSessionIn in a transaction of its own. Not under the auth lock: it touches only this session's row. */
export function checkSession(ctx: Ctx, sessionId: string, mode: CheckMode): Promise<CheckResult> {
  return ctx.db.transaction((tx) => checkSessionIn(ctx, tx, sessionId, mode))
}

/** Sessions that ended a day ago or more stay that long so other tabs learn the reason. */
export const ENDED_KEPT_MS = DAY

/**
 * The hourly sweep, in one transaction under the auth lock. First it ends every session the clocks ended without
 * another request noticing (a closed browser past its maximum length or idle limit), each with its audit row
 * `session.end`, as a request would have. Then it removes sessions that ended a day ago or more and those past
 * Better Auth's own expiry, with one audit row for the batch. Returns how many it ended and removed.
 */
export async function sweepSessions(ctx: Ctx): Promise<{ ended: number; removed: number }> {
  return inAuthTx(ctx, async (tx) => {
    const now = ctx.clock()
    const policy = policyOf(await getSettings(tx))
    const live = await tx
      .select({
        id: authSession.id,
        authenticatedAt: authSession.authenticatedAt,
        activeAt: authSession.activeAt,
        username: authUser.username,
        name: authUser.name,
      })
      .from(authSession)
      .innerJoin(authUser, eq(authUser.id, authSession.userId))
      .where(isNull(authSession.endedReason))
      .for("update", { of: authSession })
    let ended = 0
    for (const row of live) {
      const end = endedBy(row, policy, now)
      if (!end) continue
      await tx.update(authSession).set({ endedReason: end.reason, endedAt: now }).where(eq(authSession.id, row.id))
      await writeAudit(
        ctx,
        tx,
        { actor: { kind: "system", label: "system" }, source: "api" },
        {
          action: "session.end",
          entityType: "session",
          entityId: null,
          after: {
            reason: end.reason,
            deadline: end.deadline,
            noticed: now,
            by: "sweep",
            user: row.username ?? row.name,
          },
        },
      )
      ended++
    }
    const removed = await tx
      .delete(authSession)
      .where(
        or(
          and(isNotNull(authSession.endedAt), lt(authSession.endedAt, new Date(now.getTime() - ENDED_KEPT_MS))),
          lt(authSession.expiresAt, now),
        ),
      )
      .returning({ id: authSession.id })
    if (removed.length > 0)
      await writeAudit(
        ctx,
        tx,
        { actor: { kind: "system", label: "system" }, source: "api" },
        { action: "session.sweep", entityType: "session", entityId: null, after: { count: removed.length } },
      )
    return { ended, removed: removed.length }
  })
}
