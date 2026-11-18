import { getConnInfo } from "@hono/node-server/conninfo"
import { type Context, Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import { type AgentChannel, createAgentChannel, REFUSALS } from "./agents/channel.ts"
import type { AuthHolder } from "./auth/auth.ts"
import { DEFAULT_GITHUB_WEB_ORIGIN, type ServerConfig } from "./config.ts"
import { AppError, errorBody } from "./errors.ts"
import { apiRoutes, type SettingsHandle } from "./http/api.ts"
import { RateLimiter } from "./http/auth.ts"
import type { GitHubHandle } from "./http/github.ts"
import { setupRoutes } from "./http/setup.ts"
import { errorFacts, log } from "./log.ts"
import { mcpRoutes } from "./mcp/server.ts"
import type { AgentOAuthMount } from "./oauth/routes.ts"
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
    /** Failed agent keys: 10 a minute per client address. */
    limiter?: RateLimiter
    /** The client's address for that limit; the socket's address when absent (index.ts passes clientAddress). */
    clientIp?: (c: Context) => string
    /** The bot, for the status route; off when absent. */
    telegram?: TelegramRuntime
    /** The server's GitHub reading (http/github.ts); the GitHub routes exist only with it. */
    github?: GitHubHandle
  }
  /** The built web UI (dist/web); without it only the API, MCP and /healthz are served. */
  web?: { root: string }
  /**
   * Agent access by approval (oauth/): the authorization server's addresses, the protected resource documents, the
   * approval API and the owner's agent connections. Mounted only when given (it needs `core`); index.ts always passes
   * it, and only tests build an app without it.
   */
  agentOAuth?: AgentOAuthMount
}

/** The socket's address: the peer that clientAddress (http/auth.ts) trusts as a proxy or keys the limit by. */
export function socketAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * A transport fix, not a Better Auth change: a request without content reaches Better Auth with a null body.
 * - Better Auth's client sends its session refresh (`POST /get-session`, after `needsRefresh`) without a body
 *   (better-auth `client/session-atom.mjs`).
 * - @hono/node-server attaches a body stream to every request that is not GET or HEAD, even an empty one
 *   (`@hono/node-server` `dist/index.mjs`, its request builder).
 * - better-call's `getBody` then requires a Content-Type for any request whose body is not null and answers 415
 *   (better-call `dist/utils.mjs`, `getBody`).
 * Only a request that is not GET or HEAD, has `Content-Length: 0` and no `Transfer-Encoding` is rebuilt with the same
 * URL, method, headers and signal; everything else passes through unchanged, so a real body still gets Better
 * Auth's own Content-Type checks. Remove when upstream sends no body for empty requests.
 */
export function withoutEmptyBody(raw: Request): Request {
  const empty =
    raw.method !== "GET" &&
    raw.method !== "HEAD" &&
    raw.headers.get("content-length") === "0" &&
    !raw.headers.has("transfer-encoding")
  return empty ? new Request(raw.url, { method: raw.method, headers: raw.headers, signal: raw.signal }) : raw
}

/** Better Auth's routes take small JSON bodies only. */
const AUTH_BODY_LIMIT = 16 * 1024

/** The agent channel of /api/v1: every request there with an Authorization header. */
const AGENT_API = /^\/api\/v1(\/|$)/
/**
 * The only paths where a request may carry a Bearer token for a check of their own (the agent-access standard, "Keep
 * exceptions explicit, by path"): /mcp (the MCP dispatcher's token check) and the approval API (which refuses it
 * itself).
 */
const ownBearerCheck = (path: string) =>
  /^\/mcp(\/|$)/.test(path) || /^\/connect\/approve\/[^/]+\/(details|decision)$/.test(path)

/**
 * Agent access mounted: a request to /api/v1 with an Authorization header is an agent's, answered by the agent router
 * (people's credentials removed, the token checked, then the policy core). A Bearer token anywhere else but the paths
 * with checks of their own is refused before any route runs, the health check, the authorization server, its documents
 * and every page or file of the app included.
 */
function agentGate(agents: AgentChannel): MiddlewareHandler {
  return async (c, next) => {
    const authorization = c.req.header("authorization")
    if (authorization !== undefined && AGENT_API.test(c.req.path)) return agents.fetchRest(c)
    if (authorization !== undefined && /bearer/i.test(authorization) && !ownBearerCheck(c.req.path))
      return c.json(REFUSALS.closed, 403)
    await next()
  }
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  // Agent access by approval: agents' requests go through the agent channel's policy core (agents/channel.ts), before
  // any other route of the app. Without it (an app only tests build) /api/v1 and /mcp still take agent keys.
  const agents =
    deps.core && deps.agentOAuth
      ? createAgentChannel({
          ctx: deps.core.ctx,
          access: deps.agentOAuth.access,
          version: deps.core.config.version,
          clientIp: deps.core.clientIp ?? socketAddress,
          ...(deps.agentOAuth.channel ? { limits: deps.agentOAuth.channel } : {}),
          skillVersion: deps.agentOAuth.skillVersion,
        })
      : undefined
  if (agents) {
    deps.agentOAuth?.attach(agents)
    app.use("*", agentGate(agents))
  }

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
      github: deps.core.github,
    }
    // Better Auth as it is: its own handler, read from the holder on each request (Settings may rebuild it).
    app.use(
      "/api/auth/*",
      bodyLimit({ maxSize: AUTH_BODY_LIMIT, onError: (c) => c.json({ message: "Too large" }, 413) }),
    )
    app.on(["GET", "POST"], "/api/auth/*", (c) => auth.current.handler(withoutEmptyBody(c.req.raw)))
    // Before /api/v1, which would otherwise answer /api/v1/agents/*; no middleware here reads a body before the
    // authorization server's hand-off.
    if (deps.agentOAuth) app.route("/", deps.agentOAuth.routes(shared))
    app.route("/api/setup", setupRoutes({ ctx, auth }))
    app.route("/api/v1", apiRoutes(shared))
    app.route("/mcp", mcpRoutes(shared, agents))
  }

  if (deps.web) webRoutes(app, deps.web.root, deps.core?.github?.webOrigin ?? DEFAULT_GITHUB_WEB_ORIGIN)

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
