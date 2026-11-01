import { Hono } from "hono"
import { setupAccountBody } from "../../shared/auth.ts"
import { CLIENT_IP_HEADER, passwordHasher } from "../auth/auth.ts"
import { AppError, invalid } from "../errors.ts"
import { hasOwner, setupOwner } from "../services/account.ts"
import { checkSession } from "../services/session-policy.ts"
import { checkBrowserRequest, REQUEST_HEADER } from "./auth.ts"
import { type AuthGuardDeps, runLocked } from "./auth-guard.ts"

/**
 * First run, before the owner exists: /api/setup/status tells the UI which screen to show, and
 * /api/setup/account creates the owner once, then signs him in through the same locked path as a browser
 * sign-in. TOTP enrolment follows on Better Auth's routes.
 */
export function setupRoutes(deps: AuthGuardDeps) {
  const { ctx, auth, publicUrl } = deps
  const app = new Hono()
  app.use("*", async (c, next) => {
    await next()
    c.header("Cache-Control", "no-store")
  })

  /** A plain read: whether the owner exists, and what this browser's session may do (none, enrol, active). */
  app.get("/status", async (c) => {
    const hasUser = await hasOwner(ctx)
    let session: "none" | "enrol" | "active" = "none"
    const found = hasUser ? await auth.api.getSession({ headers: c.req.raw.headers }) : null
    if (found) {
      const check = await checkSession(ctx, found.session.id, "check")
      if (check.ok) session = check.session.twoFactorAt ? "active" : "enrol"
    }
    return c.json({ data: { hasUser, session } })
  })

  app.post("/account", async (c) => {
    checkBrowserRequest(c, publicUrl)
    const ip = deps.clientIp(c)
    const key = `setup:${ip}`
    if (deps.attempts.blocked(key))
      throw new AppError("rate_limited", "Too many attempts. Wait a few minutes and try again.")
    deps.attempts.fail(key)
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      throw invalid("The request body must be JSON.")
    }
    const parsed = setupAccountBody.safeParse(raw)
    if (!parsed.success)
      throw invalid("The request body is not valid.", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      })
    const input = parsed.data
    const owner = await setupOwner(ctx, await passwordHasher(auth), input)

    // After the commit. When this sign-in fails the owner exists and the page goes to /login.
    const headers = new Headers({
      "content-type": "application/json",
      origin: publicUrl.origin,
      [REQUEST_HEADER]: "1",
      [CLIENT_IP_HEADER]: ip,
      "user-agent": c.req.header("user-agent") ?? "",
    })
    const request = new Request(`${publicUrl.origin}/api/auth/sign-in/username`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: input.username, password: input.password }),
    })
    const signIn = await runLocked(deps, "sign-in", request).catch(() => null)
    const signedIn = signIn?.ok === true
    const response = c.json({ data: { username: owner.username, signedIn } }, 201)
    if (signIn && signedIn)
      for (const cookie of signIn.headers.getSetCookie()) response.headers.append("set-cookie", cookie)
    return response
  })

  return app
}
