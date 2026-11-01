import { randomBytes } from "node:crypto"
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, like, ne, notLike } from "drizzle-orm"
import { normalizeUsername, ownerEmail } from "../../shared/auth.ts"
import { challengeRows } from "../auth/cookies.ts"
import { authAccount, authSession, authTwoFactor, authUser, authVerification, devices } from "../db/schema.ts"
import { AppError } from "../errors.ts"
import { getSettings } from "./admin.ts"
import { type By, type Ctx, inAuthTx, type Tx, writeAudit } from "./context.ts"
import { checkSessionIn, endedBy, type LiveSession, policyOf } from "./session-policy.ts"

// The owner's account and sessions, written by Mikud (not by Better Auth): setup, the password change, ending
// sessions and the recovery CLI. Each runs in one transaction that takes the auth lock first (AUTH_LOCK_KEY)
// and writes its audit row in it.

/** Better Auth's password hashing (`(await auth.$context).password`). */
export type PasswordHasher = {
  hash(password: string): Promise<string>
  verify(input: { hash: string; password: string }): Promise<boolean>
}

const newId = () => randomBytes(16).toString("hex")
const CREDENTIAL = "credential"

export async function hasOwner(ctx: Ctx): Promise<boolean> {
  const [row] = await ctx.db.select({ n: count() }).from(authUser)
  return (row?.n ?? 0) > 0
}

/**
 * Creates the owner, only while there is none: the count is taken under the auth lock, so two setups racing
 * create one owner and the other gets `already_set_up`. Stored as Better Auth's username() plugin stores a
 * sign-up: `username` lowercased, `displayUsername` as typed, a credential account whose accountId is the user id.
 */
export async function setupOwner(
  ctx: Ctx,
  hasher: PasswordHasher,
  input: { username: string; password: string },
): Promise<{ id: string; username: string }> {
  const hash = await hasher.hash(input.password)
  const username = normalizeUsername(input.username)
  return inAuthTx(ctx, async (tx) => {
    const [row] = await tx.select({ n: count() }).from(authUser)
    if ((row?.n ?? 0) > 0) throw new AppError("already_set_up", "Mikud already has its owner. Sign in instead.")
    const now = ctx.clock()
    const id = newId()
    await tx.insert(authUser).values({
      id,
      name: input.username,
      email: ownerEmail(username),
      username,
      displayUsername: input.username,
      twoFactorEnabled: false,
      createdAt: now,
      updatedAt: now,
    })
    await tx.insert(authAccount).values({
      id: newId(),
      accountId: id,
      providerId: CREDENTIAL,
      userId: id,
      password: hash,
      createdAt: now,
      updatedAt: now,
    })
    await writeAudit(
      ctx,
      tx,
      { actor: { kind: "owner", label: username }, source: "ui" },
      { action: "account.setup", entityType: "account", entityId: null, after: { username } },
    )
    return { id, username }
  })
}

/** Locks and checks the caller's session: live under the clocks and with TOTP proved. */
async function requireLiveSession(ctx: Ctx, tx: Tx, sessionId: string): Promise<LiveSession> {
  const check = await checkSessionIn(ctx, tx, sessionId, "check")
  if (!check.ok) {
    if (check.reason === "revoked") throw new AppError("unauthorized", "Sign in again.")
    throw new AppError("session_ended", "Your session ended. Sign in again.", { reason: check.reason })
  }
  if (!check.session.twoFactorAt) throw new AppError("totp_required", "Enter the code from your authenticator app.")
  return check.session
}

/**
 * Deletes the user's pending two-factor challenges (identifier 2fa-<random>, value the user id) and their attempt
 * counters (2fa-attempts-<identifier>): a challenge opened with a password that is no longer valid can never be
 * completed. Returns how many challenges there were.
 */
async function deleteChallenges(tx: Tx, userId: string): Promise<number> {
  const challenges = await tx
    .select({ identifier: authVerification.identifier })
    .from(authVerification)
    .where(
      and(
        eq(authVerification.value, userId),
        like(authVerification.identifier, "2fa-%"),
        notLike(authVerification.identifier, "2fa-attempts-%"),
      ),
    )
  const rows = challenges.flatMap((c) => challengeRows(c.identifier))
  if (rows.length > 0) await tx.delete(authVerification).where(inArray(authVerification.identifier, rows))
  return challenges.length
}

const ownerBy = (session: LiveSession): By => ({ actor: { kind: "owner", label: session.username }, source: "ui" })

export type PasswordChangeHooks = { afterRead?: () => Promise<void> }

/**
 * Changes the owner's password from a signed-in session. Under the auth lock: the session is re-read and must
 * be live with TOTP proved, the current password is checked against the hash read under the lock, the new hash
 * is written, every other session ends and every pending sign-in challenge (opened with the old password) is
 * deleted; this session keeps its TOTP proof and clocks.
 */
export async function changePassword(
  ctx: Ctx,
  hasher: PasswordHasher,
  sessionId: string,
  input: { currentPassword: string; newPassword: string },
  hooks: PasswordChangeHooks = {},
): Promise<{ endedSessions: number }> {
  const newHash = await hasher.hash(input.newPassword)
  return inAuthTx(ctx, async (tx) => {
    const session = await requireLiveSession(ctx, tx, sessionId)
    const [account] = await tx
      .select({ id: authAccount.id, password: authAccount.password })
      .from(authAccount)
      .where(and(eq(authAccount.userId, session.userId), eq(authAccount.providerId, CREDENTIAL)))
    await hooks.afterRead?.()
    if (!account?.password || !(await hasher.verify({ hash: account.password, password: input.currentPassword })))
      throw new AppError("wrong_password", "The current password is not right.")
    await tx
      .update(authAccount)
      .set({ password: newHash, updatedAt: ctx.clock() })
      .where(eq(authAccount.id, account.id))
    const ended = await tx
      .delete(authSession)
      .where(and(eq(authSession.userId, session.userId), ne(authSession.id, sessionId)))
      .returning({ id: authSession.id })
    const challenges = await deleteChallenges(tx, session.userId)
    await writeAudit(ctx, tx, ownerBy(session), {
      action: "account.password_change",
      entityType: "account",
      entityId: null,
      after: { endedSessions: ended.length, endedChallenges: challenges },
    })
    return { endedSessions: ended.length }
  })
}

export type SessionEntry = {
  id: string
  current: boolean
  signedInAt: Date
  activeAt: Date
  userAgent: string | null
}

/**
 * The owner's signed-in sessions: TOTP proved, not ended, and still allowed by the session clocks now (a browser
 * that went past them without another request is not listed; the sweep ends it), the current one first, then by
 * sign-in.
 */
export async function listSessions(ctx: Ctx, sessionId: string): Promise<SessionEntry[]> {
  const policy = policyOf(await getSettings(ctx.db))
  const now = ctx.clock()
  const [own] = await ctx.db
    .select({ userId: authSession.userId })
    .from(authSession)
    .where(eq(authSession.id, sessionId))
  if (!own) return []
  const rows = await ctx.db
    .select({
      id: authSession.id,
      signedInAt: authSession.authenticatedAt,
      activeAt: authSession.activeAt,
      userAgent: authSession.userAgent,
    })
    .from(authSession)
    .where(
      and(
        eq(authSession.userId, own.userId),
        isNotNull(authSession.twoFactorAt),
        isNull(authSession.endedReason),
        gt(authSession.expiresAt, now),
      ),
    )
    .orderBy(desc(authSession.authenticatedAt))
  return rows
    .filter((row) => !endedBy({ authenticatedAt: row.signedInAt, activeAt: row.activeAt }, policy, now))
    .map((row) => ({ ...row, current: row.id === sessionId }))
    .sort((a, b) => Number(b.current) - Number(a.current))
}

/** Ends every session of the owner except this one. */
export async function endOtherSessions(ctx: Ctx, sessionId: string): Promise<number> {
  return inAuthTx(ctx, async (tx) => {
    const session = await requireLiveSession(ctx, tx, sessionId)
    const ended = await tx
      .delete(authSession)
      .where(and(eq(authSession.userId, session.userId), ne(authSession.id, sessionId)))
      .returning({ id: authSession.id })
    await writeAudit(ctx, tx, ownerBy(session), {
      action: "session.end_others",
      entityType: "session",
      entityId: null,
      after: { count: ended.length },
    })
    return ended.length
  })
}

/** Ends every session of the owner, this one too ("Sign out everywhere"). */
export async function endAllSessions(ctx: Ctx, sessionId: string): Promise<number> {
  return inAuthTx(ctx, async (tx) => {
    const session = await requireLiveSession(ctx, tx, sessionId)
    const ended = await tx
      .delete(authSession)
      .where(eq(authSession.userId, session.userId))
      .returning({ id: authSession.id })
    await writeAudit(ctx, tx, ownerBy(session), {
      action: "session.end_all",
      entityType: "session",
      entityId: null,
      after: { count: ended.length },
    })
    return ended.length
  })
}

export type ResetHooks = { afterLock?: () => Promise<void> }

/** A random password the CLI prints once: 24 characters of base64url. */
export const randomPassword = () => randomBytes(18).toString("base64url")

/**
 * The recovery command (cli.ts): under the auth lock, one transaction sets a new random password, removes TOTP
 * (it must be set up again after signing in), ends every session, deletes pending two-factor challenges and
 * writes the audit row with actor `system`, label `cli`. The auth lock also serializes it with every
 * state-changing Better Auth request (http/auth-guard.ts holds it for the whole request), so no sign-in or
 * verification runs across a reset. Returns the username and the new password, shown once.
 */
export async function resetPassword(
  ctx: Ctx,
  hasher: PasswordHasher,
  hooks: ResetHooks = {},
): Promise<{ username: string; password: string } | null> {
  const password = randomPassword()
  const hash = await hasher.hash(password)
  return inAuthTx(ctx, async (tx) => {
    await hooks.afterLock?.()
    const [user] = await tx.select().from(authUser).limit(1)
    if (!user) return null
    const now = ctx.clock()
    await tx
      .update(authAccount)
      .set({ password: hash, updatedAt: now })
      .where(and(eq(authAccount.userId, user.id), eq(authAccount.providerId, CREDENTIAL)))
    await tx.delete(authTwoFactor).where(eq(authTwoFactor.userId, user.id))
    await tx.update(authUser).set({ twoFactorEnabled: false, updatedAt: now }).where(eq(authUser.id, user.id))
    const sessions = await tx
      .delete(authSession)
      .where(eq(authSession.userId, user.id))
      .returning({ id: authSession.id })
    await deleteChallenges(tx, user.id)
    const username = user.username ?? user.name
    await writeAudit(
      ctx,
      tx,
      { actor: { kind: "system", label: "cli" }, source: "cli" },
      {
        action: "account.password_reset",
        entityType: "account",
        entityId: null,
        after: { username, endedSessions: sessions.length, totpRemoved: true },
      },
    )
    return { username, password }
  })
}

// --- Browser identity (the mikud_browser cookie): "new since your last visit" per browser, never a credential ---

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The browser row the cookie names, or a new one when it names none (first signed-in request, or a cookie of
 * another installation). Records when it was last seen, once a minute. Bookkeeping, not a change: no audit row.
 */
export async function ensureBrowser(ctx: Ctx, cookie: string | undefined): Promise<{ id: string; created: boolean }> {
  const now = ctx.clock()
  if (cookie && UUID.test(cookie)) {
    const [row] = await ctx.db.select().from(devices).where(eq(devices.id, cookie))
    if (row) {
      if (!row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() > 60_000)
        await ctx.db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, row.id))
      return { id: row.id, created: false }
    }
  }
  const [row] = await ctx.db
    .insert(devices)
    .values({ label: "Browser", createdAt: now, lastSeenAt: now })
    .returning({ id: devices.id })
  if (!row) throw new Error("insert returned no row")
  return { id: row.id, created: true }
}
