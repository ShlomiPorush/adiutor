import { getConnInfo } from "@hono/node-server/conninfo"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import type { AuthHolder } from "./auth/auth.ts"
import type { ServerConfig } from "./config.ts"
import { AppError, errorBody } from "./errors.ts"
import { apiRoutes, type SettingsHandle } from "./http/api.ts"
import { RateLimiter } from "./http/auth.ts"
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
    config: Pick<ServerConfig, "publicUrl" | "version">
    /** Better Auth: the owner's sign-in, sessions and agent keys. */
    auth: AuthHolder
    /** The owner's settings that the environment may set, and how a save takes effect. */
    settings: SettingsHandle
    /** Failed agent keys: 10 a minute per address. */
    limiter?: RateLimiter
    clientIp?: (c: Context) => string
    /** The bot, for the status route; off when absent. */
    telegram?: TelegramRuntime
  }
  /** The built web UI (dist/web); without it only the API, MCP and /healthz are served. */
  web?: { root: string }
}

/** The socket's address: the key of Mikud's own limit on failed agent keys (Better Auth limits its own routes). */
function socketAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown"
  } catch {
    return "unknown"
  }
}

/** Better Auth's routes take small JSON bodies only. */
const AUTH_BODY_LIMIT = 16 * 1024

export function createApp(deps: AppDeps) {
  const app = new Hono()

  // Container health: the process serves and the database answers. No token: it reveals nothing.
  app.get("/healthz", async (c) => {
    const database = await deps.checkDatabase()
    return c.json({ status: database ? "ok" : "unavailable", database: database ? "ok" : "down" }, database ? 200 : 503)
  })

  if (deps.core) {
    const { ctx, config, auth } = deps.core
    const shared = {
      ctx,
      config,
      auth,
      limiter: deps.core.limiter ?? new RateLimiter(),
      clientIp: deps.core.clientIp ?? socketAddress,
      version: config.version,
      telegram: deps.core.telegram,
      settings: deps.core.settings,
    }
    // Better Auth as it is: its own handler, read from the holder on each request (Settings may rebuild it).
    app.use("/api/auth/*", bodyLimit({ maxSize: AUTH_BODY_LIMIT, onError: (c) => c.json({ message: "Too large" }, 413) }))
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.current.handler(c.req.raw))
    app.route("/api/setup", setupRoutes({ ctx, auth }))
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
