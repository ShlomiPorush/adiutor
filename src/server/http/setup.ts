import { Hono } from "hono"
import type { AuthHolder } from "../auth/auth.ts"
import { hasOwner } from "../services/account.ts"
import type { Ctx } from "../services/context.ts"
import { cookieOnly } from "./auth.ts"

/**
 * First run: which screen the UI shows. The owner is created through Better Auth's own `POST /api/auth/sign-up/email`
 * (refused once an owner exists) and enrols TOTP on Better Auth's two-factor routes.
 */
export function setupRoutes(deps: { ctx: Ctx; auth: AuthHolder }) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    await next()
    c.header("Cache-Control", "no-store")
  })

  /** Whether the owner exists, and what this browser's session may do: none, enrol (no two-factor yet), active. */
  app.get("/status", async (c) => {
    const hasUser = await hasOwner(deps.ctx)
    const found = hasUser ? await deps.auth.current.api.getSession({ headers: cookieOnly(c.req.raw.headers) }) : null
    const session = !found ? "none" : found.user.twoFactorEnabled === true ? "active" : "enrol"
    return c.json({ data: { hasUser, session } })
  })

  return app
}
