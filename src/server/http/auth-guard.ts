import { and, eq, inArray, ne } from "drizzle-orm"
import type { Context } from "hono"
import { type Auth, CLIENT_IP_HEADER } from "../auth/auth.ts"
import { challengeRows, cookieNames, signedFromRequest, signedFromSetCookie } from "../auth/cookies.ts"
import { authSession, authUser, authVerification } from "../db/schema.ts"
import { AppError } from "../errors.ts"
import { errorFacts, log } from "../log.ts"
import { type By, type Ctx, writeAudit } from "../services/context.ts"
import { type Clocks, checkSession } from "../services/session-policy.ts"
import { type RateLimiter, REQUEST_HEADER } from "./auth.ts"

/*
 * Mikud's wrapper around Better Auth's handler (/api/auth/*). Better Auth has no hooks; every decision is here.
 *
 * Before the handler: only the routes Mikud uses pass (anything else is 404); every POST must come from the
 * Mikud page (X-Mikud-Request and Origin, before the body is read); sign-in and the TOTP check are rate limited
 * by socket address; options Mikud does not offer are refused; a session the clocks ended is answered
 * session_ended (get-session answers as signed out).
 *
 * Every POST holds the auth lock (AUTH_LOCK_KEY) for the whole request, on a connection of its own, so it never
 * runs across setup, a password change, a session end or the recovery CLI. With the lock held it reads the
 * current session, runs the handler and, only when the final response is 2xx, records the result in one
 * transaction: TOTP proof (two_factor_at) and the clocks on the new session (found by the token in Set-Cookie)
 * or on the current one, the end of the user's other sessions after enrolment, and the audit row. When that
 * transaction fails the sign-in fails closed: the new session and the challenge rows the request created are
 * deleted and the answer is 500 with the session cookie cleared. A sign-out whose audit fails still succeeds.
 *
 * That transaction runs on a pool connection while this request's own connection holds the lock, so it must
 * never take AUTH_LOCK_KEY itself (inAuthTx would wait for the lock this request holds, until lock_timeout):
 * it is a plain ctx.db.transaction.
 */

export type AuthGuardDeps = {
  ctx: Ctx
  auth: Auth
  publicUrl: URL
  /** Sign-in and TOTP attempts per socket address: 5 per 5 minutes per route. */
  attempts: RateLimiter
  clientIp: (c: Context) => string
  lockAuth: () => Promise<() => Promise<void>>
}

type Route = "sign-in" | "sign-out" | "get-session" | "enable" | "verify"

const ROUTES: Record<string, Route> = {
  "POST /sign-in/username": "sign-in",
  "POST /sign-out": "sign-out",
  "GET /get-session": "get-session",
  "POST /two-factor/enable": "enable",
  "POST /two-factor/verify-totp": "verify",
}

const LIMITED: ReadonlySet<Route> = new Set(["sign-in", "verify"])
const MAX_BODY = 16 * 1024

/** Answers on /api/auth have Better Auth's flat shape, which its client reads: {code, message, ...}. */
const answer = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ code, message, ...extra }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })

type Prior = { id: string; userId: string; twoFactorAt: Date | null; clocks: Clocks }

export function authGuard(deps: AuthGuardDeps) {
  return async (c: Context): Promise<Response> => {
    const path = c.req.path.slice("/api/auth".length)
    const route = ROUTES[`${c.req.method} ${path}`]
    if (!route) return answer(404, "not_found", "Nothing is here.")

    if (route === "get-session") return getSession(deps, c)

    // CSRF before anything reads the body.
    if (c.req.header(REQUEST_HEADER) !== "1" || c.req.header("origin") !== deps.publicUrl.origin)
      return answer(403, "forbidden", "The request does not come from the Mikud page.")
    const ip = deps.clientIp(c)
    if (LIMITED.has(route)) {
      const key = `${route}:${ip}`
      if (deps.attempts.blocked(key)) return answer(429, "rate_limited", "Too many attempts. Wait a few minutes.")
      deps.attempts.fail(key)
    }
    const text = await c.req.text()
    if (text.length > MAX_BODY) return answer(413, "validation_failed", "The request body is too large.")
    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = text ? JSON.parse(text) : {}
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>
    } catch {
      // Better Auth answers a body that is not JSON.
    }
    // "Remember me" off ends a session after a day, a clock Settings would not show.
    if (route === "sign-in" && body.rememberMe === false)
      return answer(400, "remember_me_unsupported", "Remember me cannot be off.")
    if (route === "verify" && body.trustDevice === true)
      return answer(400, "trust_device_unsupported", "Mikud does not skip the code on a trusted device.")
    if (route === "enable" && body.method !== undefined && body.method !== "totp")
      return answer(400, "validation_failed", "Only an authenticator app (TOTP) is supported.")

    const headers = new Headers(c.req.raw.headers)
    headers.set(CLIENT_IP_HEADER, ip)
    headers.delete("content-length")
    const request = new Request(c.req.url, { method: "POST", headers, body: text || undefined })
    return runLocked(deps, route, request)
  }
}

/** get-session: a plain read. A session the clocks ended answers as signed out. */
async function getSession(deps: AuthGuardDeps, c: Context): Promise<Response> {
  const found = await deps.auth.api.getSession({ headers: c.req.raw.headers })
  if (found) {
    const check = await checkSession(deps.ctx, found.session.id, "check")
    if (!check.ok) return new Response("null", { headers: { "content-type": "application/json" } })
  }
  return handle(deps.auth, c.req.raw)
}

/**
 * Runs Better Auth's handler. An error it throws (anything but its own APIError answers, which come back as they
 * are) is logged by errorFacts only, never by its message or query, and answered with a flat, safe 500 whose code
 * the UI turns into its own sentence.
 */
async function handle(auth: Auth, request: Request): Promise<Response> {
  try {
    return await auth.handler(request)
  } catch (error) {
    log.error("a sign-in request failed", errorFacts(error))
    return answer(500, "internal_error", "The server failed. Try again in a moment.")
  }
}

/**
 * Runs one state-changing Better Auth request with the auth lock held (see the comment at the top). Also used by
 * setup to sign the new owner in. The request has passed the checks above.
 */
export async function runLocked(deps: AuthGuardDeps, route: Route, request: Request): Promise<Response> {
  let release: () => Promise<void>
  try {
    release = await deps.lockAuth()
  } catch (error) {
    if (error instanceof AppError && error.code === "busy") return answer(503, "busy", error.message)
    throw error
  }
  try {
    const found = await deps.auth.api.getSession({ headers: request.headers })
    let prior: Prior | null = null
    if (found && route !== "sign-in" && route !== "sign-out") {
      const check = await checkSession(deps.ctx, found.session.id, "check")
      if (!check.ok)
        return check.reason === "revoked"
          ? answer(401, "unauthorized", "Sign in again.")
          : answer(401, "session_ended", "Your session ended. Sign in again.", { reason: check.reason })
      const { id, userId, twoFactorAt, clocks } = check.session
      prior = { id, userId, twoFactorAt, clocks }
    }
    // Enrolment only: a session that proved TOTP already has its factor.
    if (route === "enable" && (!prior || prior.twoFactorAt))
      return answer(403, "forbidden", "Two-factor authentication is set up already.")
    if (route === "verify" && prior?.twoFactorAt)
      return answer(400, "totp_already_proved", "This session has entered its code already.")
    const signOutOf = route === "sign-out" && found ? found : null
    const names = await cookieNames(deps.auth)
    // The challenge this request answers (verify), from its signed two_factor cookie.
    const answered = route === "verify" ? signedFromRequest(request.headers, names.twoFactor, names.secret) : null

    const response = await handle(deps.auth, request)
    if (response.status < 200 || response.status >= 300) return response

    if (route === "enable") return withoutBackupCodes(response)
    if (route === "sign-out") {
      if (signOutOf) await auditSignOut(deps, signOutOf.user.id)
      return response
    }
    const tokenValue = signedFromSetCookie(response, names.sessionToken, names.secret)
    const newToken = tokenValue ? (tokenValue.split(".")[0] ?? null) : null
    const opened = route === "sign-in" ? signedFromSetCookie(response, names.twoFactor, names.secret) : null
    try {
      // Not inAuthTx: this request already holds the auth lock (see the comment at the top).
      await deps.ctx.db.transaction(async (tx) => {
        const [created] = newToken
          ? await tx
              .select({ id: authSession.id, userId: authSession.userId, userAgent: authSession.userAgent })
              .from(authSession)
              .where(eq(authSession.token, newToken))
          : []
        const targetId = created?.id ?? (route === "verify" ? prior?.id : undefined)
        // A password sign-in of an enrolled owner only opens the code challenge: nothing to record yet.
        if (!targetId) return
        const userId = created?.userId ?? prior?.userId ?? ""
        const [user] = await tx
          .select({ username: authUser.username, name: authUser.name })
          .from(authUser)
          .where(eq(authUser.id, userId))
        const by: By = { actor: { kind: "owner", label: user?.username ?? user?.name ?? "owner" }, source: "ui" }
        const now = deps.ctx.clock()
        const facts = { userAgent: created?.userAgent ?? null }
        if (route === "sign-in") {
          // An account without TOTP (new, or after a reset): this session may only enrol.
          await tx.update(authSession).set({ authenticatedAt: now, activeAt: now }).where(eq(authSession.id, targetId))
          await writeAudit(deps.ctx, tx, by, {
            action: "session.sign_in",
            entityType: "session",
            entityId: null,
            after: { ...facts, totp: false },
          })
          return
        }
        // verify-totp: a replacement session keeps the clocks of the one it replaces; a sign-in starts them now.
        const clocks = prior?.clocks ?? { authenticatedAt: now, activeAt: now }
        await tx
          .update(authSession)
          .set({ twoFactorAt: now, authenticatedAt: clocks.authenticatedAt, activeAt: clocks.activeAt })
          .where(eq(authSession.id, targetId))
        if (prior) {
          const ended = await tx
            .delete(authSession)
            .where(and(eq(authSession.userId, userId), ne(authSession.id, targetId)))
            .returning({ id: authSession.id })
          await writeAudit(deps.ctx, tx, by, {
            action: "account.totp_enable",
            entityType: "account",
            entityId: null,
            after: { ...facts, endedSessions: ended.length },
          })
        } else {
          await writeAudit(deps.ctx, tx, by, {
            action: "session.sign_in",
            entityType: "session",
            entityId: null,
            after: { ...facts, totp: true },
          })
        }
      })
    } catch (error) {
      log.error("a sign-in could not be recorded", { route, ...errorFacts(error) })
      return failClosed(deps, names.clearing, newToken, [answered, opened])
    }
    return response
  } finally {
    await release().catch((error: unknown) => log.error("the auth lock was not released", errorFacts(error)))
  }
}

/**
 * Deletes what the failed request created (its new session, and the rows of the two-factor challenge it opened
 * or answered: the challenge and its attempt counter) and answers 500 with the session cookies cleared and no
 * other Set-Cookie. The two-factor row (the enrolled factor) is never touched.
 */
async function failClosed(
  deps: AuthGuardDeps,
  clearing: string[],
  newToken: string | null,
  challenges: (string | null)[],
): Promise<Response> {
  try {
    if (newToken) await deps.ctx.db.delete(authSession).where(eq(authSession.token, newToken))
    const rows = challenges.filter((c): c is string => Boolean(c)).flatMap(challengeRows)
    if (rows.length > 0) await deps.ctx.db.delete(authVerification).where(inArray(authVerification.identifier, rows))
  } catch (error) {
    log.error("a refused sign-in could not be cleaned up", errorFacts(error))
  }
  const failed = answer(500, "internal_error", "The sign-in could not be recorded. Try again.")
  for (const cookie of clearing) failed.headers.append("set-cookie", cookie)
  return failed
}

async function auditSignOut(deps: AuthGuardDeps, userId: string): Promise<void> {
  try {
    await deps.ctx.db.transaction(async (tx) => {
      const [user] = await tx
        .select({ username: authUser.username, name: authUser.name })
        .from(authUser)
        .where(eq(authUser.id, userId))
      await writeAudit(
        deps.ctx,
        tx,
        { actor: { kind: "owner", label: user?.username ?? user?.name ?? "owner" }, source: "ui" },
        { action: "session.sign_out", entityType: "session", entityId: null },
      )
    })
  } catch (error) {
    // The session is gone already, which is the safe direction: the sign-out still succeeds.
    log.error("a sign-out could not be audited", errorFacts(error))
  }
}

/** Backup codes are not offered (recovery is the CLI): they never leave the server. */
async function withoutBackupCodes(response: Response): Promise<Response> {
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (data) delete data.backupCodes
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(JSON.stringify(data), { status: response.status, headers })
}
