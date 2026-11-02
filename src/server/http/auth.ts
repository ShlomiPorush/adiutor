import type { Context } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import { createMiddleware } from "hono/factory"
import type { AuthHolder } from "../auth/auth.ts"
import { AppError, forbidden } from "../errors.ts"
import { ensureBrowser } from "../services/account.ts"
import type { Actor, By, Ctx } from "../services/context.ts"

/** Names the browser for "new since your last visit". Not a credential: it never authenticates. */
export const BROWSER_COOKIE = "mikud_browser"
/** Browsers cap cookie lifetimes at 400 days. */
export const BROWSER_COOKIE_MAX_AGE = 400 * 24 * 60 * 60
export const REQUEST_HEADER = "x-mikud-request"
export const AGENT_LABEL_HEADER = "x-mikud-agent"

export type Auth =
  | { actor: Actor; via: "token"; keyId: string }
  | { actor: Actor; via: "session"; sessionId: string; browserId: string; expiresAt: Date }
export type Env = { Variables: { auth: Auth } }

export type AuthDeps = {
  ctx: Ctx
  config: { publicUrl: URL }
  /** Better Auth: the owner's browser sessions and the agent keys. */
  auth: AuthHolder
  limiter: RateLimiter
  /** The client's address, for the failed-key limit. */
  clientIp: (c: Context) => string
}

/** Who a change is made by, from the request's authentication. */
export function byOf(c: Context<Env>, source?: By["source"]): By {
  const auth = c.get("auth")
  return { actor: auth.actor, source: source ?? (auth.via === "session" ? "ui" : "api") }
}

/** Failed key attempts per client in a fixed window. In memory: a restart forgets them. */
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
const unauthorized = (message = "Sign in, or send a valid key.") => new AppError("unauthorized", message)

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
 * Authenticates a request: `Authorization: Bearer <agent key>` (Better Auth's api-key plugin, verified with the
 * server-only verifyApiKey), or (when allowed) the owner's browser session (Better Auth's getSession, which never
 * extends it: deferSessionRefresh). Better Auth has no option that requires two-factor, so a session counts only when
 * the account has two-factor on; otherwise the answer is `totp_required` and the UI shows enrolment. A key never
 * becomes a session and a session never stands in for a key. Failed keys count toward the rate limit.
 */
export function authenticate(deps: AuthDeps, options: { allowSession: boolean }) {
  return createMiddleware<Env>(async (c, next) => {
    const ip = deps.clientIp(c)
    if (deps.limiter.blocked(ip)) throw rateLimited()
    const header = c.req.header("authorization")
    if (header !== undefined) {
      const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
      const result = match?.[1] ? await deps.auth.current.api.verifyApiKey({ body: { key: match[1] } }) : null
      if (!result?.valid || !result.key) {
        deps.limiter.fail(ip)
        throw unauthorized("The key is not valid.")
      }
      c.set("auth", { actor: { kind: "agent", label: agentLabel(c) }, via: "token", keyId: result.key.id })
      return next()
    }
    if (!options.allowSession) throw unauthorized("A valid key is required.")
    const found = await deps.auth.current.api.getSession({ headers: c.req.raw.headers })
    if (!found) throw unauthorized()
    if (found.user.twoFactorEnabled !== true)
      throw new AppError("totp_required", "Set up two-factor authentication to use Mikud.")
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
    const user = found.user as { username?: string | null; name: string }
    c.set("auth", {
      actor: { kind: "owner", label: user.username ?? user.name },
      via: "session",
      sessionId: found.session.id,
      browserId: browser.id,
      expiresAt: new Date(found.session.expiresAt),
    })
    return next()
  })
}

/** Refuses anything but the owner's signed-in browser. */
export const requireOwnerAuth = createMiddleware<Env>(async (c, next) => {
  if (c.get("auth").actor.kind !== "owner") throw forbidden("Only the owner can do this.")
  return next()
})
