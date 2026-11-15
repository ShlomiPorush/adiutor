import type { IncomingMessage } from "node:http"
import { type Context, Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import type { AgentArea, AgentResource } from "../../shared/enums.ts"
import { authUser } from "../db/schema.ts"
import { AppError } from "../errors.ts"
import { BODY_LIMITS, openRouteHandlers, type RouteHandler } from "../http/api.ts"
import { agentLabel, type Env } from "../http/auth.ts"
import { errorFacts, log } from "../log.ts"
import type { ToolGuard, ToolResult } from "../mcp/server.ts"
import type { AgentAccess, Connection, TokenCheck } from "../oauth/access.ts"
import { WindowLimit } from "../oauth/limits.ts"
import { type By, type Ctx, SYSTEM, writeAudit } from "../services/context.ts"
import {
  describeArea,
  HEADERS,
  honoPath,
  type Kind,
  listing,
  mayCall,
  NEVER,
  notGranted,
  OPEN,
  type OpenRoute,
  REVISION,
  TOOLS,
} from "./policy.ts"

/*
 * The agent channel of /api/v1 and the limits and audit it shares with /mcp (the agent-access standard, "The REST
 * channel"). Built only where createApp is given `agentOAuth`; without it /api/v1 and /mcp answer as before (agent keys
 * and the owner's browser session). A request to /api/v1 that carries an Authorization header is an agent's: it goes to
 * an agent router of its own, built from the open map alone, with the owner's cookie and any key header removed, so it
 * never acts through a browser session nor keeps one alive. There the token is checked first (401), the router picks the
 * route, and the policy check runs before the route's code: area (403), policy revision and declared kind (409), a free
 * slot (429). Anything the agent router has no route for is closed (403).
 */

export type ChannelLimits = {
  /** Request bodies: the same caps as the owner's /api/v1 (sync snapshots larger) and /mcp. */
  bodyBytes: { default: number; sync: number }
  /** The largest answer an agent gets (measured; see docs/api.md). */
  answerBytes: number
  /** After this long a call answers 504 outcome_unknown; it may still be running. */
  deadlineMs: number
  /** Calls running at once per connection and in total, REST and MCP together. */
  perConnection: number
  total: number
  /** An audit write gives up waiting after this long; the answer never waits longer for it. */
  auditMs: number
  /** A `busy` refusal is recorded once per connection in this window. */
  busyWindowMs: number
  /** Invalid tokens per client address. */
  badTokens: WindowLimit
}

export function channelLimits(now: () => number = Date.now): ChannelLimits {
  return {
    bodyBytes: { default: BODY_LIMITS.default, sync: BODY_LIMITS.sync },
    answerBytes: 8 * 1024 * 1024,
    deadlineMs: 60_000,
    perConnection: 3,
    total: 6,
    auditMs: 5_000,
    busyWindowMs: 60_000,
    badTokens: new WindowLimit(20, 60_000, now),
  }
}

export type Outcome = "ok" | "error" | "denied" | "unknown"

/** The reserved refusals (the standard's exact bodies) and the channel's own refusals. Messages hold no request value. */
export const REFUSALS = {
  busy: { error: "busy", message: "This connection runs too many calls at once. Nothing was sent; try again." },
  policyChanged: {
    error: "policy_changed",
    message:
      "Adiutor's calls changed, or this path names a different call than the list says, or this skill is older than Adiutor. Nothing ran. Run `adiutor endpoints` and take the path from it.",
  },
  invalidToken: { error: "invalid_token", message: "The token is not valid here, or the connection has ended." },
  invalidRequest: { error: "invalid_request", message: "Send exactly one Authorization: Bearer <token> header." },
  unauthorized: { error: "unauthorized", message: "Connect to Adiutor first: this call needs a token." },
  tooManyTokens: {
    error: "rate_limited",
    message: "Too many invalid tokens from this address. Wait a minute, then connect again.",
  },
  closed: {
    error: "forbidden",
    message: "Agents cannot make this call. Take the path from the endpoints list; never guess one.",
  },
  areaNotGranted: {
    error: "area_not_granted",
    message:
      "The owner did not grant this connection the area of this call. Ask the owner to connect it again with it.",
  },
  unknown: {
    error: "outcome_unknown",
    message:
      "The call took too long, and it may still be running. Read the state it was to change before you try again.",
  },
  connectionEnded: { error: "connection_ended", message: "This connection has ended. Connect again." },
  tooLarge: { error: "too_large", message: "The request body is too large." },
} as const

/** A failure whose outcome may be unknown (a 5xx after an action). */
const INTERNAL = { error: "internal_error", message: "Something went wrong on the server." } as const

/** The answer over the cap: the call ran (an action changed something), only its answer is withheld. */
const answerTooLarge = (cap: number, kind: Kind) => ({
  error: "answer_too_large",
  message: `The answer is larger than ${Math.floor(cap / 1024 / 1024)} MiB. Ask for less (a filter, a smaller limit).${kind === "act" ? " The action ran: read its result before you try again." : ""}`,
})

/** Resolves "late" when the work has not ended within the deadline; the work goes on either way. */
function within<T>(work: Promise<T>, ms: number): Promise<{ late: true } | { late: false; value: T }> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<{ late: true }>((resolve) => {
    timer = setTimeout(() => resolve({ late: true }), ms)
    timer.unref?.()
  })
  return Promise.race([work.then((value) => ({ late: false as const, value })), late]).finally(() =>
    clearTimeout(timer),
  )
}

/** Calls running now, per connection and in total, shared by the REST channel and MCP. Never waits: full is `busy`. */
function slots(limits: ChannelLimits) {
  const per = new Map<string, number>()
  let total = 0
  return {
    take(id: string): boolean {
      const mine = per.get(id) ?? 0
      if (mine >= limits.perConnection || total >= limits.total) return false
      per.set(id, mine + 1)
      total++
      return true
    },
    give(id: string): void {
      const mine = (per.get(id) ?? 1) - 1
      if (mine > 0) per.set(id, mine)
      else per.delete(id)
      total = Math.max(0, total - 1)
    },
  }
}

/** What one agent call is, for its audit entry. */
export type CallEntry = {
  connection: Connection
  by: By
  channel: "rest" | "mcp"
  /** `GET /api/v1/items/{id}` or the MCP tool's name; null for a REST call the agent router had no route for. */
  name: string | null
  method?: string
  kind: Kind | null
}

export type AgentChannelOptions = {
  ctx: Ctx
  access: AgentAccess
  version: string
  clientIp: (c: Context) => string
  limits?: ChannelLimits
}

type Bindings = { incoming?: IncomingMessage }

/** A request's checked token: the token and what agent access answered for it. */
export type AgentToken = { token: string; check: Extract<TokenCheck, { ok: true }> }

/** The number of header lines named `name` as the client sent them, when the Node request is at hand. */
function headerLines(c: Context, name: string): number | null {
  const raw = (c.env as Bindings | undefined)?.incoming?.rawHeaders
  if (!raw) return null
  let count = 0
  for (let i = 0; i < raw.length; i += 2) if (raw[i]?.toLowerCase() === name) count++
  return count
}

/** An RFC 6750 token after exactly one `Bearer` and one space. */
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i

/** A request whose headers people's credentials were removed from: the Cookie and any API key header. */
export function withoutPeoplesCredentials(raw: Request): Request {
  const headers = new Headers(raw.headers)
  headers.delete("cookie")
  headers.delete("x-api-key")
  const bodyless = raw.method === "GET" || raw.method === "HEAD"
  return new Request(raw.url, {
    method: raw.method,
    headers,
    signal: raw.signal,
    ...(bodyless ? {} : { body: raw.body, duplex: "half" }),
  } as RequestInit)
}

/**
 * The agent channel: the token check and its refusals, the limits shared by REST and MCP, the audit of every call, and
 * the agent router of /api/v1.
 */
export function createAgentChannel(options: AgentChannelOptions) {
  const { ctx, access } = options
  const limits = options.limits ?? channelLimits()
  const running = slots(limits)
  const busySeen = new Map<string, number>()
  const issuer = access.issuer ?? ""
  const metadata = (resource: AgentResource) =>
    `${issuer}/.well-known/oauth-protected-resource${resource === "mcp" ? "/mcp" : "/api/v1"}`

  /** A 401 with where to start (RFC 9728) and, for a token that was sent, why (RFC 6750). */
  function challenge(c: Context, resource: AgentResource, error?: "invalid_token" | "invalid_request") {
    const parts = [`resource_metadata="${metadata(resource)}"`, ...(error ? [`error="${error}"`] : [])]
    c.header("WWW-Authenticate", `Bearer ${parts.join(", ")}`)
    c.header("Access-Control-Expose-Headers", "WWW-Authenticate")
    c.header("Cache-Control", "no-store")
    const body =
      error === "invalid_token"
        ? REFUSALS.invalidToken
        : error === "invalid_request"
          ? REFUSALS.invalidRequest
          : REFUSALS.unauthorized
    return c.json(body, 401)
  }

  /** Writes an audit row; never throws, never waits longer than its own deadline. */
  async function audit(by: By, entry: Parameters<typeof writeAudit>[3]): Promise<void> {
    const write = writeAudit(ctx, ctx.db, by, entry).catch((error: unknown) => {
      log.error("an agent call was not audited", errorFacts(error))
    })
    let timer: NodeJS.Timeout | undefined
    const gaveUp = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.error("an agent call's audit row is late", {})
        resolve()
      }, limits.auditMs)
      timer.unref?.()
    })
    await Promise.race([write, gaveUp]).finally(() => clearTimeout(timer))
  }

  /** The one audit entry of an agent call, with its outcome. */
  function record(call: CallEntry, outcome: Outcome, details: Record<string, unknown> = {}): Promise<void> {
    return audit(call.by, {
      action: call.channel === "rest" ? "agent.api_call" : "agent.tool_call",
      entityType: "agent_connection",
      entityId: call.connection.id,
      after: {
        name: call.connection.name,
        ...(call.channel === "rest" ? { route: call.name, method: call.method } : { tool: call.name }),
        kind: call.kind,
        outcome,
        ...details,
      },
    })
  }

  /** `busy` is recorded once per window per connection. */
  function busyOnce(connectionId: string): boolean {
    const now = Date.now()
    const last = busySeen.get(connectionId)
    if (last !== undefined && now - last < limits.busyWindowMs) return false
    busySeen.set(connectionId, now)
    if (busySeen.size > 10_000) for (const [k, at] of busySeen) if (now - at >= limits.busyWindowMs) busySeen.delete(k)
    return true
  }

  /**
   * The token of an agent request for `resource`: exactly one `Authorization: Bearer <token>`, checked by agent access
   * (oauth/access.ts checkToken). Invalid tokens count per client address; past the limit an address is refused before
   * its token is read, and the first refusal of a window is logged and audited once.
   */
  async function authenticate(
    c: Context,
    resource: AgentResource,
  ): Promise<{ refusal: Response } | { token: string; check: Extract<TokenCheck, { ok: true }> }> {
    const header = c.req.header("authorization")
    if (header === undefined) return { refusal: challenge(c, resource) }
    const lines = headerLines(c, "authorization")
    const match = BEARER.exec(header)
    if (!match?.[1] || (lines !== null && lines !== 1)) return { refusal: challenge(c, resource, "invalid_request") }
    const address = options.clientIp(c)
    if (limits.badTokens.blocked(address))
      return { refusal: c.json(REFUSALS.tooManyTokens, 429, { "Retry-After": "60", "Cache-Control": "no-store" }) }
    const check = await access.checkToken(match[1], resource)
    if (!check.ok) {
      limits.badTokens.take(address)
      if (limits.badTokens.firstOver(address)) {
        log.warn("agent tokens refused: too many invalid tokens from one address", { resource })
        await audit(SYSTEM, {
          action: "agent.blocked",
          entityType: "agent_connection",
          entityId: null,
          after: { limit: resource === "mcp" ? "mcp_token" : "api_token", address },
        })
      }
      return { refusal: challenge(c, resource, "invalid_token") }
    }
    return { token: match[1], check }
  }

  /** What `access` and the MCP tool get_access answer. */
  async function accessAnswer(check: Extract<TokenCheck, { ok: true }>, resource: AgentResource) {
    const { connection, areas } = check
    const [owner] = await ctx.db.select({ username: authUser.username, name: authUser.name }).from(authUser).limit(1)
    const { idleDays } = await access.agentSettings()
    const since = connection.lastUsedAt ?? connection.approvedAt
    return {
      account: owner?.username ?? owner?.name ?? null,
      name: connection.name,
      connection: { via: connection.connectedVia, resource, approvedAt: connection.approvedAt.toISOString() },
      areas: areas.map(describeArea),
      notGranted: notGranted(resource, areas).map(describeArea),
      never: NEVER,
      ends: {
        rule: `After ${idleDays} days without a real API or MCP call, or when the owner disconnects it or turns agents off.`,
        lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
        endsAt: new Date(since.getTime() + idleDays * 86_400_000).toISOString(),
      },
      version: options.version,
      // PR 5: `update_skill`, from the X-Adiutor-Skill header (HEADERS.skill), when the skill is older than Adiutor.
    }
  }

  /**
   * Runs one call under the limits: a slot (taken by the caller), the deadline and the audit entry, written once before
   * the answer leaves; the slot is given back once both the work and the entry are done. A call past its deadline is
   * recorded `unknown` and answered at once; its work goes on in its slot.
   */
  async function guarded<T>(
    call: CallEntry,
    work: Promise<T>,
    judge: (value: T) => Promise<{ outcome: Outcome; details?: Record<string, unknown> }>,
  ): Promise<{ late: true } | { late: false; value: T }> {
    const id = call.connection.id
    work.catch(() => undefined)
    let done: Awaited<ReturnType<typeof within<T>>>
    try {
      done = await within(work, limits.deadlineMs)
    } catch (error) {
      await record(call, "error")
      running.give(id)
      throw error
    }
    if (done.late) {
      await record(call, "unknown")
      void work.then(
        () => running.give(id),
        () => running.give(id),
      )
      return done
    }
    try {
      const { outcome, details } = await judge(done.value)
      await record(call, outcome, details)
    } finally {
      running.give(id)
    }
    return done
  }

  // --- The agent router of /api/v1 ---

  const handlers: Record<string, RouteHandler> = {
    ...openRouteHandlers({ ctx }),
    "GET /api/v1/agent/access": async (c) => c.json(await accessAnswer(callOf(c).check, "rest")),
    "GET /api/v1/agent/endpoints": async (c) => {
      const only = c.req.query("area")
      if (only !== undefined && !(["read", "write", "sync"] as string[]).includes(only))
        return c.json({ error: "validation_failed", message: "area must be read, write or sync." }, 400)
      return c.json(listing(callOf(c).check.areas, only as AgentArea | undefined))
    },
  }

  type AgentCall = { token: string; check: Extract<TokenCheck, { ok: true }>; by: By }
  type AgentEnv = { Variables: Env["Variables"] & { agent: AgentCall } }
  const callOf = (c: Context) => (c as Context<AgentEnv>).get("agent")

  /** The policy check of one open route, then its code under the limits, and its audit entry. */
  const policy =
    (route: OpenRoute): MiddlewareHandler<AgentEnv> =>
    async (c, next) => {
      const { check, by } = c.get("agent")
      const call: CallEntry = {
        connection: check.connection,
        by,
        channel: "rest",
        name: `${route.method} ${route.path}`,
        method: c.req.method,
        kind: route.kind,
      }
      if (!mayCall(check.areas, route.area)) {
        await record(call, "denied", { status: 403 })
        return c.json({ ...REFUSALS.areaNotGranted, area: route.area }, 403)
      }
      if (!route.exempt) {
        const revision = c.req.header(HEADERS.policy)
        const kind = c.req.header(HEADERS.kind)
        const once = (name: string) => {
          const lines = headerLines(c, name)
          return lines === null || lines === 1
        }
        if (revision !== REVISION || kind !== route.kind || !once(HEADERS.policy) || !once(HEADERS.kind)) {
          await record(call, "denied", { status: 409 })
          return c.json(REFUSALS.policyChanged, 409)
        }
      }
      if (!running.take(check.connection.id)) {
        if (busyOnce(check.connection.id)) await record(call, "denied", { status: 429 })
        return c.json(REFUSALS.busy, 429)
      }
      const work = (async () => {
        // A real call counts as use (the idle rule); `access` and `endpoints` do not. A connection that ended since its
        // token was checked runs nothing.
        if (!route.exempt && !(await access.recordUse(check.connection))) return "ended" as const
        await next()
        return "ran" as const
      })()
      let tooLarge = false
      const done = await guarded(call, work, async (ran) => {
        if (ran === "ended") return { outcome: "denied", details: { status: 401 } }
        const status = c.res.status
        tooLarge = (await c.res.clone().arrayBuffer()).byteLength > limits.answerBytes
        if (tooLarge) return { outcome: "error", details: { status, answerTooLarge: true } }
        return { outcome: status < 400 ? "ok" : "error", details: { status } }
      })
      if (done.late) return c.json(REFUSALS.unknown, 504)
      if (done.value === "ended") return challenge(c, "rest", "invalid_token")
      if (tooLarge) replace(c, answerTooLarge(limits.answerBytes, route.kind), 422)
      else if (c.res.status === 401 || c.res.status === 429) c.res = reservedSafe(c.res, c)
    }

  const tooLarge = (c: Context) => c.json(REFUSALS.tooLarge, 413)
  const syncLimit = bodyLimit({ maxSize: limits.bodyBytes.sync, onError: tooLarge })
  const defaultLimit = bodyLimit({ maxSize: limits.bodyBytes.default, onError: tooLarge })

  const rest = new Hono<AgentEnv>()
  // The token first, for every request: a request without a valid one is refused before any route is looked at.
  rest.use("*", async (c, next) => {
    const found = await authenticate(c, "rest")
    if ("refusal" in found) return found.refusal
    const { check } = found
    const actor = { kind: "agent" as const, label: agentLabel(c, check.connection.name) }
    c.set("auth", { actor, via: "agent", connectionId: check.connection.id, areas: check.areas })
    c.set("agent", { ...found, by: { actor, source: "api" } })
    await next()
    c.header("Cache-Control", "no-store")
  })
  for (const route of OPEN) {
    const handler = handlers[`${route.method} ${route.path}`]
    if (!handler) throw new Error(`no handler for the open route ${route.method} ${route.path}`)
    const limit = route.area === "sync" ? syncLimit : defaultLimit
    rest.on(route.method, honoPath(route.path), policy(route), limit, handler as never)
  }
  // Anything else is closed to agents: the router picked no open route.
  const closed = async (c: Context<AgentEnv>) => {
    const agent = c.get("agent")
    if (agent)
      await record(
        {
          connection: agent.check.connection,
          by: agent.by,
          channel: "rest",
          name: null,
          method: c.req.method,
          kind: null,
        },
        "denied",
        { status: 403 },
      )
    return c.json(REFUSALS.closed, 403)
  }
  rest.all("*", closed)
  rest.notFound(closed)
  rest.onError((error, c) => {
    if (error instanceof AppError) return c.json(agentErrorBody(error), agentStatus(error.status))
    if (error instanceof HTTPException && error.status < 500)
      return c.json({ error: "validation_failed", message: "The request is not valid." }, agentStatus(error.status))
    // Never log request bodies, headers or the error's message: they may hold tokens, text or a query.
    log.error("an agent request failed", { method: c.req.method, ...errorFacts(error) })
    return c.json(INTERNAL, 500)
  })

  /**
   * Runs one MCP tool call through the same policy core as a REST call: a free slot, the connection checked again (the
   * call may have waited, and the token been refused or the connection ended meanwhile; a real tool call counts as use,
   * get_access does not), the tool's area, then the tool under the deadline and the answer cap, with its audit entry.
   */
  function toolGuard(found: AgentToken, by: By): ToolGuard {
    const id = found.check.connection.id
    return async (tool, run) => {
      const rule = TOOLS[tool]
      const call: CallEntry = {
        connection: found.check.connection,
        by,
        channel: "mcp",
        name: tool,
        kind: rule?.kind ?? null,
      }
      const fail = (body: object): ToolResult => ({
        content: [{ type: "text", text: JSON.stringify(body) }],
        isError: true,
      })
      if (!running.take(id)) {
        if (busyOnce(id)) await record(call, "denied", { refusal: "busy" })
        return fail(REFUSALS.busy)
      }
      const refuse = async (refusal: string, body: object) => {
        try {
          await record(call, "denied", { refusal })
        } finally {
          running.give(id)
        }
        return fail(body)
      }
      let again: TokenCheck
      try {
        again = await access.checkToken(found.token, "mcp", { use: tool !== "get_access" })
      } catch (error) {
        log.error("an agent's connection could not be checked", errorFacts(error))
        return refuse("check_failed", INTERNAL)
      }
      if (!again.ok || again.connection.id !== id) return refuse("connection_ended", REFUSALS.connectionEnded)
      if (!rule || !mayCall(again.areas, rule.area)) return refuse("area_not_granted", REFUSALS.areaNotGranted)
      const work = run().catch((error: unknown): ToolResult => {
        // Never the error's message: it may hold a query or the owner's text.
        log.error("an agent's tool call failed", { tool, ...errorFacts(error) })
        return fail(INTERNAL)
      })
      let tooLarge = false
      const done = await guarded(call, work, async (result) => {
        tooLarge = result.content.reduce((n, part) => n + Buffer.byteLength(part.text), 0) > limits.answerBytes
        return { outcome: tooLarge || result.isError ? "error" : "ok" }
      })
      if (done.late) return fail(REFUSALS.unknown)
      if (tooLarge) return fail(answerTooLarge(limits.answerBytes, rule.kind))
      return done.value
    }
  }

  return {
    issuer,
    limits,
    slots: running,
    toolGuard,
    authenticate,
    accessAnswer,
    record,
    busyOnce,
    guarded,
    challenge,
    /** The routes of the agent router, for the exposure test. */
    restRoutes: rest.routes,
    /** Answers an agent request to /api/v1 (one with an Authorization header), people's credentials removed first. */
    fetchRest: (c: Context) => rest.fetch(withoutPeoplesCredentials(c.req.raw), c.env),
  }
}

export type AgentChannel = ReturnType<typeof createAgentChannel>

/** An AppError as the agent contract has it (D9): `{error: code, message, ...details}`. */
export function agentErrorBody(error: AppError) {
  return { error: error.code, message: error.message, ...error.details }
}

/**
 * A route's own refusal never looks like a reserved one (401 with a token challenge, 429 busy, 409 policy_changed): a
 * route's 401 answers 403 and its 429 answers 409, each with its own code. No open route answers either today.
 */
export function agentStatus<S extends number>(status: S): S | 403 | 409 {
  if (status === 401) return 403
  if (status === 429) return 409
  return status
}

/**
 * A route's answer that would read as a reserved refusal is answered with its own body under another status, without a
 * token challenge. Hono's `c.res` setter merges the previous answer's headers, so the previous one is dropped first.
 */
function reservedSafe(res: Response, c: Context): Response {
  const headers = new Headers(res.headers)
  headers.delete("www-authenticate")
  c.res = undefined as unknown as Response
  return new Response(res.body, { status: agentStatus(res.status), headers })
}

/** Replaces the route's answer after it ran with an answer of the channel's own (the previous one dropped whole). */
function replace(c: Context, body: object, status: number): void {
  c.res = undefined as unknown as Response
  c.res = new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}
