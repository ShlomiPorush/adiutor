import { getConnInfo } from "@hono/node-server/conninfo"
import { type Context, Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ServerConfig } from "./config.ts"
import { AppError, errorBody } from "./errors.ts"
import { apiRoutes } from "./http/api.ts"
import { RateLimiter } from "./http/auth.ts"
import { log } from "./log.ts"
import { mcpRoutes } from "./mcp/server.ts"
import type { Ctx } from "./services/context.ts"
import type { TelegramRuntime } from "./telegram/status.ts"

export type AppDeps = {
  /** True when the database answers a trivial query. */
  checkDatabase(): Promise<boolean>
  /** The API and MCP; without them only /healthz is served (unit tests of the health check). */
  core?: {
    ctx: Ctx
    config: Pick<ServerConfig, "ownerToken" | "agentToken" | "publicUrl" | "version">
    limiter?: RateLimiter
    clientIp?: (c: Context) => string
    /** The bot, for the status route; off when absent. */
    telegram?: TelegramRuntime
  }
}

/** The socket's address. Behind a proxy every client shares the proxy's address, which is acceptable here. */
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
    const auth = {
      ctx,
      config,
      limiter: deps.core.limiter ?? new RateLimiter(),
      clientIp: deps.core.clientIp ?? socketAddress,
      version: config.version,
      telegram: deps.core.telegram,
    }
    app.route("/api/v1", apiRoutes(auth))
    app.route("/mcp", mcpRoutes(auth))
  }

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Nothing is here." } }, 404))
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json(errorBody(error), error.status)
    if (error instanceof HTTPException && error.status < 500)
      return c.json({ error: { code: "validation_failed", message: "The request is not valid." } }, error.status)
    // Never log request bodies or headers: they may hold tokens or text.
    log.error("request failed", { method: c.req.method, path: c.req.path, error: String(error) })
    return c.json({ error: { code: "internal_error", message: "Something went wrong on the server." } }, 500)
  })

  return app
}
