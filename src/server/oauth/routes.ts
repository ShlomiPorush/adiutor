import type { IncomingMessage, ServerResponse } from "node:http"
import type { TLSSocket } from "node:tls"
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response"
import { type Context, Hono, type MiddlewareHandler } from "hono"
import type { Interaction } from "oidc-provider"
import { z } from "zod"
import { AGENT_AREAS, type AgentResource } from "../../shared/enums.ts"
import { AGENT_IDLE_DAYS_MAX, AGENT_IDLE_DAYS_MIN } from "../../shared/settings.ts"
import type { AgentChannel, ChannelLimits } from "../agents/channel.ts"
import { AppError, errorBody, invalid, notFound } from "../errors.ts"
import { type AuthDeps, authenticate, byOf, cookieOnly, type Env, requireOwnerAuth } from "../http/auth.ts"
import { errorFacts, log } from "../log.ts"
import { SYSTEM, writeAudit } from "../services/context.ts"
import { CONTENT_SECURITY_POLICY } from "../web.ts"
import { type AgentAccess, offeredAreas, type PendingRequest } from "./access.ts"
import { LOOPBACK_HOSTNAMES } from "./issuer.ts"
import { Mutex, WindowLimit } from "./limits.ts"
import { agentName, CLI_CLIENT_ID, PROVIDER_ROUTES, RESOURCE_AREAS, resourceUrls } from "./provider.ts"
import { servedSkillVersion, skillRoutes } from "./skill.ts"
import { openDeviceRequests, roomForClient, sha256 } from "./store.ts"

type Bindings = { incoming: IncomingMessage; outgoing: ServerResponse }
/** The Node request and response under @hono/node-server; absent when the app is driven without a server. */
const node = (c: Context): Bindings | null => {
  const env = c.env as Partial<Bindings> | undefined
  return env?.incoming && env.outgoing ? (env as Bindings) : null
}

/**
 * The provider's own addresses, exactly as configured: the library would also take a trailing slash or another letter
 * case, which would slip past the checks in front of it (lesson 16). A uid follows authorize and the code page on resume.
 */
export const PROVIDER_PATHS =
  /^(\/oauth\/(authorize(\/[A-Za-z0-9_-]+)?|token|device|revoke|register|jwks)|\/connect\/code(\/[A-Za-z0-9_-]+)?|\/\.well-known\/oauth-authorization-server)$/

/** Registrations kept at most; unapproved ones are cleared after a day. */
export const MAX_CLIENTS = 500
/** Device requests open at once, at most. */
export const MAX_DEVICE_REQUESTS = 100
/** Approvals answered at once: each holds a connection of the main pool while the library stores its grant. */
const DECISIONS_AT_ONCE = 2

/** Per address (S20), counted before anything is awaited. */
export function agentLimits(now: () => number = Date.now) {
  return {
    register: new WindowLimit(20, 3_600_000, now),
    device: new WindowLimit(30, 600_000, now),
    authorize: new WindowLimit(60, 600_000, now),
    // A script polls every 5 seconds; a poll whose code is waiting or approved is given back, so the quota of
    // refresh and revoke is never spent by waiting agents.
    token: new WindowLimit(600, 600_000, now),
    code: new WindowLimit(60, 600_000, now),
    codeSession: new WindowLimit(30, 600_000, now),
  }
}
export type AgentLimits = ReturnType<typeof agentLimits>

/** Bearer tokens and agent keys never see or answer an approval: only the owner's signed-in browser. */
const PEOPLE_ONLY = ["authorization", "x-api-key"]

const notConfigured = {
  error: "not_configured",
  message: "Agents connect by approval once agents are on and the public URL allows it.",
}
const gone = { error: "gone", message: "This request is no longer open. Start the connection again in your agent." }

/** At most `n` at a time; the others wait their turn. */
function semaphore(n: number) {
  let free = n
  const waiting: (() => void)[] = []
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (free > 0) free--
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await run()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else free++
    }
  }
}

/** The origin Koa builds the library's URLs from (its `ctx.protocol` and `ctx.host`), read the same way. */
function koaOrigin(incoming: IncomingMessage, proxy: boolean): string {
  const first = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim() || undefined
  const host = (proxy ? first(incoming.headers["x-forwarded-host"]) : undefined) ?? first(incoming.headers.host) ?? ""
  const encrypted = Boolean((incoming.socket as TLSSocket | undefined)?.encrypted)
  const protocol = encrypted ? "https" : proxy ? (first(incoming.headers["x-forwarded-proto"]) ?? "http") : "http"
  return `${protocol}://${host}`
}

/** The caps on stored registrations and open device requests (S5, S9). */
export type AgentCaps = { clients: number; deviceRequests: number }
export const AGENT_CAPS: AgentCaps = { clients: MAX_CLIENTS, deviceRequests: MAX_DEVICE_REQUESTS }

export type AgentRouteDeps = AuthDeps & {
  access: AgentAccess
  limits?: AgentLimits
  caps?: AgentCaps
  /** The agent skill's folder (skill/adiutor), served at /agents/skill/; without it the build serves no skill. */
  skillDir?: string
}

/**
 * Agent access over HTTP: the protected resource documents (RFC 9728), the approval API of the consent page, the
 * owner's connections and agent settings, and the hand-off of the authorization server's own addresses to the library.
 * Mounted by createApp only when it is given `agentOAuth`.
 */
export function agentRoutes(deps: AgentRouteDeps) {
  const { access, ctx } = deps
  const app = new Hono<Env>()
  const issuer = access.issuer
  const limits = deps.limits ?? agentLimits()
  const caps = deps.caps ?? AGENT_CAPS
  const provider = access.provider

  access.hooks.devicePollAnswered = (req) => {
    const address = addressOf.get(req)
    if (address) limits.token.give(address)
  }
  // Codes typed on the code page count per provider session too, keyed by its verified signed cookie.
  access.hooks.codeAttempt = (session, req) =>
    limits.codeSession.take(session ? `s:${sha256(session)}` : `a:${addressOf.get(req) ?? "unknown"}`)
  /** The address each handed-off request was counted under, for a poll given back. */
  const addressOf = new WeakMap<IncomingMessage, string>()
  /** The place of a capped request, given back when the library has handled it. */
  const handled = new WeakMap<IncomingMessage, () => void>()
  access.hooks.providerDone = (req) => {
    handled.get(req)?.()
    handled.delete(req)
  }
  const registering = new Mutex()
  const requesting = new Mutex()
  const deciding = semaphore(DECISIONS_AT_ONCE)

  /** Whether agents may connect now: a valid issuer and agents on. */
  const live = async () => Boolean(provider && (await access.agentSettings()).enabled)

  const tooMany = (c: Context) =>
    c.json({ error: "slow_down", error_description: "Too many requests. Wait a few minutes." }, 429, {
      "Retry-After": "600",
      "Cache-Control": "no-store",
    })

  /** Blocked after too many attempts: one audit row per limit and address and window, never a secret. */
  const blocked = async (limit: WindowLimit, name: string, address: string) => {
    if (!limit.firstOver(address)) return
    try {
      await writeAudit(ctx, ctx.db, SYSTEM, {
        action: "agent.blocked",
        entityType: "agent_connection",
        entityId: null,
        after: { limit: name, address },
      })
    } catch (error) {
      log.error("the blocked agent requests were not audited", errorFacts(error))
    }
  }

  // --- RFC 9728: what each resource is and where its tokens come from (S2). Public; no-store. ---
  const resourceMetadata = (resource: AgentResource) => async (c: Context) => {
    if (!issuer || !(await live())) return c.json(notConfigured, 404, { "Cache-Control": "no-store" })
    return c.json(
      {
        resource: resourceUrls(issuer)[resource],
        authorization_servers: [issuer],
        scopes_supported: [...RESOURCE_AREAS[resource]],
        bearer_methods_supported: ["header"],
        resource_name: resource === "mcp" ? "Adiutor MCP server" : "Adiutor REST API",
      },
      200,
      { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    )
  }
  app.get("/.well-known/oauth-protected-resource", resourceMetadata("mcp"))
  app.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata("mcp"))
  app.get("/.well-known/oauth-protected-resource/api/v1", resourceMetadata("rest"))

  // --- The agent skill for agents that run commands (oauth/skill.ts) ---
  app.route("/", skillRoutes(issuer, live, deps.skillDir))

  // --- The consent page's API, under the interaction's address so the library's cookie comes along (S11) ---

  /**
   * Every answer on the flow's addresses: the consent page's API and the page itself, which the built UI (web.ts,
   * mounted after these routes) serves as index.html, and every refusal before the hand-off to the library (not
   * configured, another host, a limit). The page keeps the UI's whole Content-Security-Policy, which forbids framing
   * too; other answers get `frame-ancestors 'none'` alone. An answer the library wrote itself got them before the
   * hand-off (below) and is left alone.
   */
  const flowHeaders: MiddlewareHandler = async (c, next) => {
    await next()
    if (c.res === RESPONSE_ALREADY_SENT) return
    c.header("Cache-Control", "no-store")
    c.header("X-Frame-Options", "DENY")
    if (!c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", "frame-ancestors 'none'")
    c.header("Referrer-Policy", "no-referrer")
  }
  for (const path of ["/connect/approve/*", "/connect/code", "/connect/code/*", "/oauth/*"]) app.use(path, flowHeaders)
  const peopleOnly: MiddlewareHandler = async (c, next) => {
    if (PEOPLE_ONLY.some((h) => c.req.header(h) !== undefined))
      return c.json({ error: "forbidden", message: "Only the owner's signed-in browser answers an approval." }, 403)
    await next()
  }

  /** The owner's browser session from its cookie alone, with two-factor on; an answer when there is none. */
  async function ownerSession(c: Context) {
    const found = await deps.auth.current.api.getSession({ headers: cookieOnly(c.req.raw.headers) })
    if (!found) return { refusal: c.json({ error: "unauthorized", message: "Sign in to Adiutor first." }, 401) }
    if (found.user.twoFactorEnabled !== true)
      return { refusal: c.json({ error: "totp_required", message: "Set up two-factor authentication first." }, 403) }
    const user = found.user as { id: string; username?: string | null; name: string }
    return { session: found.session.id, user }
  }

  /** The library's pending request behind this address, as the consent page shows it; null when there is none. */
  async function pending(c: Context): Promise<{ n: Bindings; request: PendingRequest } | null> {
    const n = node(c)
    if (!n || !provider || !issuer) return null
    let details: Interaction
    try {
      details = await provider.interactionDetails(n.incoming, n.outgoing)
    } catch {
      return null
    }
    if (details.uid !== c.req.param("uid")) return null
    const params = details.params as Record<string, unknown>
    const clientId = typeof params.client_id === "string" ? params.client_id : ""
    const client = await provider.Client.find(clientId)
    if (!client) return null
    const resources = resourceUrls(issuer)
    const asked = params.resource
    if (Array.isArray(asked)) return null
    const resource: AgentResource | null =
      asked === undefined
        ? clientId === CLI_CLIENT_ID
          ? "rest"
          : "mcp"
        : asked === resources.mcp
          ? "mcp"
          : asked === resources.rest
            ? "rest"
            : null
    if (!resource) return null
    const deviceCode = typeof details.deviceCode === "string" ? details.deviceCode : null
    const redirectUri = typeof params.redirect_uri === "string" ? URL.parse(params.redirect_uri) : null
    if (!deviceCode && !redirectUri) return null
    return {
      n,
      request: {
        uid: details.uid,
        clientId,
        name: agentName(clientId, client.clientName, params.client_label),
        builtIn: clientId === CLI_CLIENT_ID,
        via: deviceCode ? "code" : "browser",
        resource,
        redirect: redirectUri
          ? {
              host: redirectUri.host,
              scheme: redirectUri.protocol.slice(0, -1),
              loopback:
                redirectUri.protocol === "http:" &&
                (LOOPBACK_HOSTNAMES as readonly string[]).includes(redirectUri.hostname),
            }
          : null,
        areas: offeredAreas(resource, params.scope),
        deviceCode,
      },
    }
  }

  app.get("/connect/approve/:uid/details", peopleOnly, async (c) => {
    const who = await ownerSession(c)
    if (who.refusal) return who.refusal
    if (!(await live())) return c.json(notConfigured, 404)
    const it = await pending(c)
    if (!it || !(await access.bindRequest(it.request.uid, who.session))) return c.json(gone, 410)
    const { request } = it
    return c.json({
      client: { name: request.name, builtIn: request.builtIn, nameIsOwnWord: true },
      via: request.via,
      resource: request.resource,
      redirect: request.redirect,
      areas: request.areas,
      idleDays: (await access.agentSettings()).idleDays,
    })
  })

  const decisionBody = z
    .object({
      approve: z.boolean(),
      areas: z
        .array(z.enum(AGENT_AREAS))
        .max(AGENT_AREAS.length)
        .refine((a) => new Set(a).size === a.length)
        .default([]),
    })
    .strict()

  app.post("/connect/approve/:uid/decision", peopleOnly, async (c) => {
    // CSRF: the Origin must be the issuer exactly as a browser spells it, and a missing one is refused; JSON only.
    if (!issuer || c.req.header("origin") !== issuer)
      return c.json({ error: "forbidden", message: "The request does not come from the Adiutor page." }, 403)
    if (!/^application\/json(\s*;|$)/i.test(c.req.header("content-type") ?? ""))
      return c.json({ error: "unsupported_media_type", message: "Send JSON." }, 415)
    const who = await ownerSession(c)
    if (who.refusal) return who.refusal
    if (!(await live())) return c.json(notConfigured, 404)
    const parsed = decisionBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "validation_failed", message: "The answer is not valid." }, 400)
    const it = await pending(c)
    if (!it) return c.json(gone, 410)
    const { approve, areas } = parsed.data
    // Validated before the request is taken, so the page can show the areas again: only from the set shown, never none.
    if (approve && (areas.length === 0 || !areas.every((a) => it.request.areas.includes(a))))
      return c.json({ error: "validation_failed", message: "Choose what the agent may do from the areas shown." }, 400)
    const by = { actor: { kind: "owner" as const, label: who.user.username ?? who.user.name }, source: "ui" as const }
    const outcome = await deciding(() =>
      access.decide({ request: it.request, sessionId: who.session, approve, areas, accountId: who.user.id, by }),
    )
    if (outcome.kind === "gone") return c.json(gone, 410)
    const result =
      outcome.kind === "denied"
        ? { error: "access_denied", error_description: "The owner did not approve the connection." }
        : { login: { accountId: who.user.id }, consent: { grantId: outcome.grantId } }
    try {
      const redirectTo = await provider?.interactionResult(it.n.incoming, it.n.outgoing, result, {
        mergeWithLastSubmission: false,
      })
      return c.json({ outcome: outcome.kind, redirectTo })
    } catch {
      // The library's request ran out meanwhile; an approved connection that is never collected ends when idle.
      return c.json(gone, 410)
    }
  })

  // --- The owner's connections and agent settings (the Agent access page) ---

  const owner = new Hono<Env>()
  owner.use("*", authenticate(deps, { allowSession: true }), requireOwnerAuth)
  owner.get("/settings", async (c) => {
    const current = await access.agentSettings()
    return c.json({
      ...current,
      issuer,
      issuerProblem: access.issuerProblem,
      mcpUrl: access.resources?.mcp ?? null,
      restUrl: access.resources?.rest ?? null,
    })
  })
  const settingsBody = z
    .object({
      enabled: z.boolean().optional(),
      idleDays: z.number().int().min(AGENT_IDLE_DAYS_MIN).max(AGENT_IDLE_DAYS_MAX).optional(),
    })
    .strict()
  owner.patch("/settings", async (c) => {
    const parsed = settingsBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw invalid("The agent settings are not valid.")
    await access.saveSettings(byOf(c), parsed.data)
    return c.json(await access.agentSettings())
  })
  owner.get("/connections", async (c) => {
    const rows = await access.listConnections(byOf(c))
    const idleDays = (await access.agentSettings()).idleDays
    return c.json({
      connections: rows.map((r) => ({
        id: r.id,
        name: r.name,
        via: r.connectedVia,
        resource: r.resource,
        areas: r.areas,
        redirectHost: r.redirectHost,
        approvedAt: r.approvedAt.toISOString(),
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
        endsAt: new Date((r.lastUsedAt ?? r.approvedAt).getTime() + idleDays * 86_400_000).toISOString(),
      })),
    })
  })
  owner.delete("/connections/:id", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"))
    if (!id.success) throw notFound("The connection")
    await access.disconnect(byOf(c), id.data)
    return c.body(null, 204)
  })
  owner.post("/connections/disconnect-all", async (c) => {
    const ended = await access.disconnectAll(byOf(c))
    return c.json({ ended })
  })
  app.route("/api/v1/agents", owner)

  // --- Everything else of OAuth is the library's: discovery, authorize, token, device, code page, revoke, register ---

  const handoff = async (c: Context) => {
    const n = node(c)
    if (!n) return c.json({ error: "unavailable" }, 501)
    const raw = (n.incoming.url ?? "").split("?")[0] ?? ""
    if (raw !== c.req.path || !PROVIDER_PATHS.test(raw)) return c.json({ error: "not_found" }, 404)
    if (!provider || !issuer) return c.json(notConfigured, 404)
    // D1h: the library builds its URLs from the request's Host (or X-Forwarded-Host behind the proxy); a request
    // for another host than the issuer's is refused before it reaches the library.
    if (koaOrigin(n.incoming, provider.proxy) !== issuer)
      return c.json({ error: "misdirected", message: "This address does not serve Adiutor's authorization." }, 421)
    // Counted before the first await (S20).
    const address = deps.clientIp(c)
    const [name, limit] =
      raw === PROVIDER_ROUTES.registration
        ? (["register", limits.register] as const)
        : raw === PROVIDER_ROUTES.device_authorization
          ? (["device", limits.device] as const)
          : raw.startsWith(PROVIDER_ROUTES.authorization)
            ? (["authorize", limits.authorize] as const)
            : raw === PROVIDER_ROUTES.token || raw === PROVIDER_ROUTES.revocation
              ? (["token", limits.token] as const)
              : raw.startsWith(PROVIDER_ROUTES.code_verification)
                ? (["code", limits.code] as const)
                : ([null, null] as const)
    if (limit && !limit.take(address)) {
      await blocked(limit, name, address)
      return tooMany(c)
    }
    addressOf.set(n.incoming, address)
    if (!(await live())) {
      if (name === "token") limits.token.give(address)
      return c.json(notConfigured, 404, { "Cache-Control": "no-store" })
    }
    // A cap is counted and filled one request at a time: its place is given back once the library has handled the
    // request (its middleware, oauth/access.ts), whether it stored the record, failed, or its client left meanwhile.
    const capped =
      c.req.method === "POST" && raw === PROVIDER_ROUTES.registration
        ? { lock: registering, room: () => roomForClient(ctx.db, caps.clients) }
        : c.req.method === "POST" && raw === PROVIDER_ROUTES.device_authorization
          ? {
              lock: requesting,
              room: async () => (await openDeviceRequests(ctx.db, ctx.clock())) < caps.deviceRequests,
            }
          : null
    if (capped) {
      const release = await capped.lock.acquire()
      // A request still unhandled after a minute (a body sent slowly) is cut off; the place comes back only when the
      // library is done with it, never on a timer.
      const cutOff = setTimeout(() => n.incoming.destroy(), 60_000)
      cutOff.unref()
      const done = () => {
        clearTimeout(cutOff)
        release()
      }
      let room = false
      try {
        room = await capped.room()
      } catch (error) {
        done()
        throw error
      }
      if (!room) {
        done()
        return tooMany(c)
      }
      handled.set(n.incoming, done)
    }
    n.outgoing.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY)
    n.outgoing.setHeader("X-Frame-Options", "DENY")
    n.outgoing.setHeader("Referrer-Policy", "no-referrer")
    n.outgoing.setHeader("X-Content-Type-Options", "nosniff")
    n.outgoing.setHeader("Cache-Control", "no-store")
    provider.callback()(n.incoming, n.outgoing)
    // The library writes the answer to the socket itself.
    return RESPONSE_ALREADY_SENT
  }
  app.all("/oauth/*", handoff)
  app.all("/connect/code", handoff)
  app.all("/connect/code/*", handoff)
  app.get("/.well-known/oauth-authorization-server", handoff)

  app.onError((error, c) => {
    if (error instanceof AppError) return c.json(errorBody(error), error.status)
    // Never log bodies, headers or the error's message: they may hold a token or a code.
    log.error("an agent access request failed", { method: c.req.method, path: c.req.path, ...errorFacts(error) })
    return c.json({ error: { code: "internal_error", message: "Something went wrong on the server." } }, 500)
  })
  return app
}

/**
 * What createApp mounts when it is given `agentOAuth`: built by the caller, so the app module never loads the
 * authorization server unless it is mounted (index.ts always mounts it; only tests build an app without it).
 */
export function agentOAuthMount(
  access: AgentAccess,
  limits?: AgentLimits,
  caps?: AgentCaps,
  /** The agent channel's limits (agents/channel.ts); tests pass shorter ones. */
  channel?: ChannelLimits,
  /** The agent skill's folder (skill/adiutor in the repository), served at /agents/skill/. */
  skillDir?: string,
) {
  /** The agent channels createApp built on this mount (one per app). */
  const channels: AgentChannel[] = []
  return {
    access,
    channel,
    /** The version a served copy of the skill sends in X-Adiutor-Skill (null without a skill), for `update_skill`. */
    skillVersion: servedSkillVersion(skillDir),
    routes: (deps: AuthDeps) => agentRoutes({ ...deps, access, limits, caps, skillDir }),
    /** createApp hands over the agent channel it built. */
    attach(built: AgentChannel) {
      channels.push(built)
    },
    /**
     * Waits for every agent call's audit row still being written. The caller that owns shutdown runs it after the
     * server stopped taking requests and before the database closes (index.ts, once it mounts agent access).
     */
    async drain() {
      for (const built of channels) await built.drain()
    },
  }
}
export type AgentOAuthMount = ReturnType<typeof agentOAuthMount>
