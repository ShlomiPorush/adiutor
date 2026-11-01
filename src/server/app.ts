import { getConnInfo } from "@hono/node-server/conninfo"
import { type Context, Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { Auth } from "./auth/auth.ts"
import type { ServerConfig } from "./config.ts"
import { AppError, errorBody } from "./errors.ts"
import { apiRoutes } from "./http/api.ts"
import { RateLimiter } from "./http/auth.ts"
import { authGuard } from "./http/auth-guard.ts"
import { setupRoutes } from "./http/setup.ts"
import { errorFacts, log } from "./log.ts"
import { mcpRoutes } from "./mcp/server.ts"
import type { Ctx } from "./services/context.ts"
import type { TelegramRuntime } from "./telegram/status.ts"
import { webRoutes } from "./web.ts"

export type AppDeps = {
  /** True when the database answers a trivial query. */
  checkDatabase(): Promise<boolean>
  /** The API and MCP; without them only /healthz is served (unit tests of the health check). */
  core?: {
    ctx: Ctx
    config: Pick<ServerConfig, "ownerToken" | "agentToken" | "publicUrl" | "version">
    /** Better Auth: the owner's browser sign-in. */
    auth: Auth
    /** Takes the auth lock for one state-changing /api/auth request (Database.lockAuth). */
    lockAuth: () => Promise<() => Promise<void>>
    /** Failed token attempts: 10 a minute per address. */
    limiter?: RateLimiter
    /** Sign-in, TOTP, setup and password attempts: 5 per 5 minutes per route and address. */
    attempts?: RateLimiter
    clientIp?: (c: Context) => string
    /** The bot, for the status route; off when absent. */
    telegram?: TelegramRuntime
  }
  /** The built web UI (dist/web); without it only the API, MCP and /healthz are served. */
  web?: { root: string }
}

/**
 * The socket's address, never a forwarding header (which a client can forge). Behind the proxy every client
 * shares the proxy's address: the rate limits are then one bucket for everyone, which fails safe for one owner.
 */
function socketAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown"
  } catch {
    return "unknown"
  }
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  // Container health: the process serves and the database answers. No token: it reveals nothing.
  app.get("/healthz", async (c) => {
    const database = await deps.checkDatabase()
    return c.json({ status: database ? "ok" : "unavailable", database: database ? "ok" : "down" }, database ? 200 : 503)
  })

  if (deps.core) {
    const { ctx, config } = deps.core
    const clientIp = deps.core.clientIp ?? socketAddress
    const attempts = deps.core.attempts ?? new RateLimiter(5, 300_000)
    const shared = {
      ctx,
      config,
      auth: deps.core.auth,
      limiter: deps.core.limiter ?? new RateLimiter(),
      attempts,
      clientIp,
      version: config.version,
      telegram: deps.core.telegram,
    }
    const guard = {
      ctx,
      auth: deps.core.auth,
      publicUrl: config.publicUrl,
      attempts,
      clientIp,
      lockAuth: deps.core.lockAuth,
    }
    app.on(["GET", "POST"], "/api/auth/*", authGuard(guard))
    app.all("/api/auth/*", (c) => c.json({ code: "not_found", message: "Nothing is here." }, 404))
    app.route("/api/setup", setupRoutes(guard))
    app.route("/api/v1", apiRoutes(shared))
    app.route("/mcp", mcpRoutes(shared))
  }

  if (deps.web) webRoutes(app, deps.web.root)

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Nothing is here." } }, 404))
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json(errorBody(error), error.status)
    if (error instanceof HTTPException && error.status < 500)
      return c.json({ error: { code: "validation_failed", message: "The request is not valid." } }, error.status)
    // Never log request bodies, headers or the error's message: they may hold tokens, text or a query.
    log.error("request failed", { method: c.req.method, path: c.req.path, ...errorFacts(error) })
    return c.json({ error: { code: "internal_error", message: "Something went wrong on the server." } }, 500)
  })

  return app
}
