import { createHash, timingSafeEqual } from "node:crypto"
import type { Context } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import { createMiddleware } from "hono/factory"
import type { Auth as BetterAuth } from "../auth/auth.ts"
import type { ServerConfig } from "../config.ts"
import { AppError, forbidden } from "../errors.ts"
import { ensureBrowser } from "../services/account.ts"
import type { Actor, By, Ctx } from "../services/context.ts"
import { checkSession, type SessionStatus } from "../services/session-policy.ts"

/** Names the browser for "new since your last visit". Not a credential: it never authenticates. */
export const BROWSER_COOKIE = "mikud_browser"
/** Browsers cap cookie lifetimes at 400 days. */
export const BROWSER_COOKIE_MAX_AGE = 400 * 24 * 60 * 60
export const REQUEST_HEADER = "x-mikud-request"
export const AGENT_LABEL_HEADER = "x-mikud-agent"

export type Auth =
  | { actor: Actor; via: "token" }
  | { actor: Actor; via: "session"; sessionId: string; browserId: string; status: SessionStatus }
export type Env = { Variables: { auth: Auth } }

export type AuthDeps = {
  ctx: Ctx
  config: Pick<ServerConfig, "ownerToken" | "agentToken" | "publicUrl">
  /** Better Auth: the owner's browser sessions. */
  auth: BetterAuth
  limiter: RateLimiter
  /** The client's address, for the rate limits. */
  clientIp: (c: Context) => string
}

/** Who a change is made by, from the request's authentication. */
export function byOf(c: Context<Env>, source?: By["source"]): By {
  const auth = c.get("auth")
  return { actor: auth.actor, source: source ?? (auth.via === "session" ? "ui" : "api") }
}

const digest = (text: string) => createHash("sha256").update(text).digest()

/** Which token this is, compared in constant time on SHA-256 digests (both are always compared). */
export function tokenKind(token: string, config: AuthDeps["config"]): "owner" | "agent" | null {
  const given = digest(token)
  const owner = timingSafeEqual(given, digest(config.ownerToken))
  const agent = timingSafeEqual(given, digest(config.agentToken))
  return owner ? "owner" : agent ? "agent" : null
}

/** Failed token attempts per client in a fixed window. In memory: a restart forgets them. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; start: number }>()

  constructor(
    private readonly max = 10,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(key: string): boolean {
    const hit = this.hits.get(key)
    if (!hit) return false
    if (this.now() - hit.start >= this.windowMs) {
      this.hits.delete(key)
      return false
    }
    return hit.count >= this.max
  }

  fail(key: string): void {
    const now = this.now()
    const hit = this.hits.get(key)
    if (!hit || now - hit.start >= this.windowMs) this.hits.set(key, { count: 1, start: now })
    else hit.count++
    if (this.hits.size > 10_000) {
      for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k)
    }
  }
}

const rateLimited = () => new AppError("rate_limited", "Too many failed attempts. Wait a minute and try again.")
const unauthorized = (message = "Sign in, or send a valid token.") => new AppError("unauthorized", message)

/**
 * Browser state-changing requests must name themselves with X-Mikud-Request: 1 and come from the
 * configured public origin. SameSite cookies are not relied on alone.
 */
export function checkBrowserRequest(c: Context, publicUrl: URL): void {
  if (c.req.header(REQUEST_HEADER) !== "1") throw forbidden("The X-Mikud-Request header is missing.")
  if (c.req.header("origin") !== publicUrl.origin) throw forbidden("The request does not come from the Mikud page.")
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

function agentLabel(c: Context): string {
  const raw = c.req.header(AGENT_LABEL_HEADER)?.trim() ?? ""
  const clean = raw.replace(/[^A-Za-z0-9 ._:-]/g, "").slice(0, 60)
  return clean ? `agent:${clean}` : "agent"
}

/**
 * Authenticates a request: `Authorization: Bearer <owner or agent token>`, or (when allowed) the owner's
 * browser session (Better Auth), which must be live under the clocks and have proved TOTP. A session never
 * stands in for a token where a token is required. Failed token attempts count toward the rate limit.
 */
export function authenticate(deps: AuthDeps, options: { allowSession: boolean }) {
  return createMiddleware<Env>(async (c, next) => {
    const ip = deps.clientIp(c)
    if (deps.limiter.blocked(ip)) throw rateLimited()
    const header = c.req.header("authorization")
    if (header !== undefined) {
      const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
      const kind = match?.[1] ? tokenKind(match[1], deps.config) : null
      if (!kind) {
        deps.limiter.fail(ip)
        throw unauthorized("The token is not valid.")
      }
      c.set("auth", {
        actor: kind === "owner" ? { kind: "owner", label: "owner" } : { kind: "agent", label: agentLabel(c) },
        via: "token",
      })
      return next()
    }
    if (!options.allowSession) throw unauthorized("A valid token is required.")
    const found = await deps.auth.api.getSession({ headers: c.req.raw.headers })
    if (!found) throw unauthorized()
    const check = await checkSession(deps.ctx, found.session.id, "check")
    if (!check.ok) {
      if (check.reason === "revoked") throw unauthorized()
      throw new AppError("session_ended", "Your session ended. Sign in again.", { reason: check.reason })
    }
    if (!check.session.twoFactorAt)
      throw new AppError("totp_required", "Enter the code from your authenticator app to finish signing in.")
    if (!SAFE_METHODS.has(c.req.method)) checkBrowserRequest(c, deps.config.publicUrl)
    const browser = await ensureBrowser(deps.ctx, getCookie(c, BROWSER_COOKIE))
    if (browser.created)
      setCookie(c, BROWSER_COOKIE, browser.id, {
        httpOnly: true,
        sameSite: "Lax",
        secure: deps.config.publicUrl.protocol === "https:",
        path: "/",
        maxAge: BROWSER_COOKIE_MAX_AGE,
      })
    c.set("auth", {
      actor: { kind: "owner", label: check.session.username },
      via: "session",
      sessionId: check.session.id,
      browserId: browser.id,
      status: check.session.status,
    })
    return next()
  })
}

/** Refuses anything but the owner (the owner token or the owner's session). */
export const requireOwnerAuth = createMiddleware<Env>(async (c, next) => {
  if (c.get("auth").actor.kind !== "owner") throw forbidden("Only the owner can do this.")
  return next()
})
