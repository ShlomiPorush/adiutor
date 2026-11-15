import { createHash, randomBytes } from "node:crypto"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { serve } from "@hono/node-server"
import { createApp } from "../app.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { type AgentAccess, createAgentAccess } from "../oauth/access.ts"
import { WindowLimit } from "../oauth/limits.ts"
import { CLI_CLIENT_ID } from "../oauth/provider.ts"
import { type AgentLimits, agentLimits, agentOAuthMount } from "../oauth/routes.ts"
import type { By } from "../services/context.ts"
import { createSettingsCipher } from "../settings/crypto.ts"
import { TEST_SETTINGS_KEY, type TestCore, testCore } from "./app.ts"
import { TestBrowser } from "./browser.ts"
import type { TestDatabase } from "./db.ts"
import { testSecret } from "./secrets.ts"

// Agent access over real HTTP for integration tests: the app on a Node server on 127.0.0.1 (the authorization server
// hands requests to the library on the Node request and response), its issuer that address, agents on, and the owner's
// signed-in browser with two-factor. Every key and secret is new per harness.

export const ownerBy: By = { actor: { kind: "owner", label: "owner" }, source: "ui" }

type Fetch = (request: Request, env?: unknown) => Response | Promise<Response>

/** A Node server on 127.0.0.1 whose handler is set once the app (which needs the server's address) exists. */
async function listen(): Promise<{ server: Server; origin: string; handle(fetch: Fetch): void }> {
  let handler: Fetch = () => new Response("starting", { status: 503 })
  const server = serve({ fetch: (request, env) => handler(request, env), port: 0, hostname: "127.0.0.1" }) as Server
  await new Promise<void>((resolve) => {
    if (server.listening) resolve()
    else server.once("listening", () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    handle(fetch) {
      handler = fetch
    },
  }
}

let browserIp = 0

/** A browser over HTTP: a cookie jar, no redirects followed, its own client address for Better Auth's limits. */
export function httpBrowser(origin: string): TestBrowser {
  return new TestBrowser((request) => fetch(new Request(request, { redirect: "manual" })), origin, {
    "x-forwarded-for": `198.51.100.${(browserIp++ % 250) + 1}`,
  })
}

export type OAuthHarness = {
  t: TestDatabase
  issuer: string
  access: AgentAccess
  core: TestCore
  storeDb: Database
  limits: AgentLimits
  /** The owner's signed-in browser (two-factor on). */
  owner: TestBrowser
  /** The owner's TOTP secret, to sign in another browser. */
  ownerSecret: string
  close(): Promise<void>
}

/**
 * The app with agent access mounted on a server of its own. Limits are wide unless a test passes its own (all requests
 * come from 127.0.0.1). With `agentsOn: false` the switch stays at a new installation's default, off.
 */
export async function oauthHarness(
  t: TestDatabase,
  options: { limits?: AgentLimits; agentsOn?: boolean; publicUrl?: (origin: string) => string } = {},
): Promise<OAuthHarness> {
  const { server, origin, handle } = await listen()
  const storeDb = createDatabase(t.url, { max: 4 })
  const access = await createAgentAccess({
    ctx: t.ctx,
    publicUrl: options.publicUrl ? options.publicUrl(origin) : origin,
    cookieKeys: [testSecret(), testSecret()],
    storeDb: storeDb.db,
    cipher: createSettingsCipher([{ version: 1, value: TEST_SETTINGS_KEY }]),
  })
  const core = testCore(t, {
    config: { publicUrl: new URL(origin), version: "test" },
    auth: { identityChanges: access.identity },
  })
  const limits = options.limits ?? wideLimits()
  const app = createApp({ checkDatabase: async () => true, core, agentOAuth: agentOAuthMount(access, limits) })
  handle((request, env) => app.fetch(request, env))
  await access.start()
  if (options.agentsOn !== false) await access.saveSettings(ownerBy, { enabled: true })
  const owner = httpBrowser(origin)
  const ownerSecret = await owner.owner()
  return {
    t,
    issuer: origin,
    access,
    core,
    storeDb,
    limits,
    owner,
    ownerSecret,
    async close() {
      access.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await storeDb.close()
    },
  }
}

/** The limits with room for every request a test makes; the limit tests pass their own. */
export function wideLimits(): AgentLimits {
  const wide = (limit: WindowLimit) => new WindowLimit(1_000_000, limit.windowMs)
  const base = agentLimits()
  return {
    register: wide(base.register),
    device: wide(base.device),
    authorize: wide(base.authorize),
    token: wide(base.token),
    code: wide(base.code),
    codeSession: wide(base.codeSession),
  }
}

// biome-ignore lint/suspicious/noExplicitAny: OAuth answers are loose JSON or HTML
export type Loose = any
export type Answer = { status: number; headers: Headers; body: Loose; text: string; location: string | null }

async function answer(response: Response): Promise<Answer> {
  const text = await response.text()
  let body: unknown = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {}
  return { status: response.status, headers: response.headers, body, text, location: response.headers.get("location") }
}

/** A request the agent makes (no cookies): a form post, a JSON post or a GET. */
export async function agentCall(
  origin: string,
  path: string,
  init: {
    form?: Record<string, string | string[]>
    json?: unknown
    method?: string
    headers?: Record<string, string>
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...init.headers }
  let body: string | undefined
  if (init.form) {
    headers["content-type"] = "application/x-www-form-urlencoded"
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(init.form))
      for (const v of Array.isArray(value) ? value : [value]) params.append(key, v)
    body = params.toString()
  } else if (init.json !== undefined) {
    headers["content-type"] = "application/json"
    body = JSON.stringify(init.json)
  }
  const url = path.startsWith("http") ? path : `${origin}${path}`
  return answer(await fetch(url, { method: init.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" }))
}

/** A request in the owner's browser: its cookies, a form or JSON body, no redirects followed. */
export async function browserCall(
  b: TestBrowser,
  path: string,
  init: { form?: Record<string, string>; json?: unknown; method?: string; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...b.extra, ...init.headers }
  if (b.cookies.size > 0) headers.cookie = b.cookieHeader
  let body: string | undefined
  if (init.form) {
    headers["content-type"] = "application/x-www-form-urlencoded"
    body = new URLSearchParams(init.form).toString()
  } else if (init.json !== undefined) {
    headers["content-type"] = "application/json"
    body = JSON.stringify(init.json)
  }
  const method = init.method ?? (body ? "POST" : "GET")
  if (method !== "GET") headers.origin ??= b.origin
  const url = path.startsWith("http") ? path : `${b.origin}${path}`
  const response = await fetch(url, { method, headers, body, redirect: "manual" })
  for (const cookie of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = cookie.split(";")
    const eq = pair.indexOf("=")
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1)
    const expired = attributes.some(
      (a) => /^\s*max-age\s*=\s*0\s*$/i.test(a) || /^\s*expires\s*=\s*Thu, 01 Jan 1970/i.test(a),
    )
    if (!value || expired) b.cookies.delete(name)
    else b.cookies.set(name, value)
  }
  return answer(response)
}

export const pkce = () => {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}

/** Registers like an MCP client. */
export async function register(origin: string, metadata: Record<string, unknown> = {}): Promise<Answer> {
  return agentCall(origin, "/oauth/register", {
    json: { client_name: "Test agent", redirect_uris: ["http://127.0.0.1:33418/callback"], ...metadata },
  })
}

/** The owner's answer on the consent page: the details, then the decision; the address to go next. */
export async function answerConsent(
  b: TestBrowser,
  uid: string,
  decision: { approve: boolean; areas?: string[] },
): Promise<{ details: Answer; decision: Answer }> {
  const details = await browserCall(b, `/connect/approve/${uid}/details`)
  const answered = await browserCall(b, `/connect/approve/${uid}/decision`, {
    json: { approve: decision.approve, areas: decision.areas ?? (decision.approve ? details.body?.areas : []) },
  })
  return { details, decision: answered }
}

export const uidOf = (location: string | null) =>
  /\/connect\/approve\/([A-Za-z0-9_-]+)$/.exec(location ?? "")?.[1] ?? ""

/**
 * An MCP client's whole connection: registration, authorize in the owner's browser, approval, the code exchanged for
 * tokens. `areas` are ticked on the consent page (default: all shown).
 */
export async function connectBrowser(
  h: OAuthHarness,
  options: { scope?: string; areas?: string[]; resource?: string; redirect?: string } = {},
) {
  const redirect = options.redirect ?? "http://127.0.0.1:33418/callback"
  const reg = await register(h.issuer, { redirect_uris: [redirect] })
  if (reg.status !== 201) throw new Error(`registration answered ${reg.status}: ${reg.text}`)
  const clientId = String(reg.body.client_id)
  const { verifier, challenge } = pkce()
  const resource = options.resource ?? `${h.issuer}/mcp`
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: options.scope ?? "read write",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s-1",
    resource,
  })
  const authorize = await browserCall(h.owner, `/oauth/authorize?${query}`)
  const uid = uidOf(authorize.location)
  if (!uid) throw new Error(`authorize answered ${authorize.status} ${authorize.location}: ${authorize.text}`)
  const consent = await answerConsent(h.owner, uid, { approve: true, areas: options.areas })
  if (consent.decision.status !== 200)
    throw new Error(`decision answered ${consent.decision.status}: ${consent.decision.text}`)
  const back = await browserCall(h.owner, String(consent.decision.body.redirectTo))
  const code = new URL(back.location ?? "", h.issuer).searchParams.get("code") ?? ""
  const tokens = await agentCall(h.issuer, "/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirect,
      resource,
    },
  })
  return { clientId, code, verifier, redirect, resource, back, uid, consent, tokens }
}

/** The owner types a code on the code page and confirms it; returns the consent page's uid. */
export async function confirmCode(b: TestBrowser, userCode: string): Promise<string> {
  const page = await browserCall(b, "/connect/code")
  const xsrf = /name="xsrf" value="([^"]+)"/.exec(page.text)?.[1] ?? ""
  await browserCall(b, "/connect/code", { form: { xsrf, user_code: userCode } })
  const confirmed = await browserCall(b, "/connect/code", { form: { xsrf, user_code: userCode, confirm: "yes" } })
  const uid = uidOf(confirmed.location)
  if (!uid) throw new Error(`the code page answered ${confirmed.status}: ${confirmed.text}`)
  return uid
}

/** Asks for a device code as the built-in client (the skill, the sync). */
export async function deviceRequest(
  origin: string,
  params: { scope?: string; resource?: string; label?: string } = {},
): Promise<Answer> {
  return agentCall(origin, "/oauth/device", {
    form: {
      client_id: CLI_CLIENT_ID,
      scope: params.scope ?? "read write",
      ...(params.resource ? { resource: params.resource } : {}),
      ...(params.label ? { client_label: params.label } : {}),
    },
  })
}

export const pollDevice = (origin: string, deviceCode: string) =>
  agentCall(origin, "/oauth/token", {
    form: {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: CLI_CLIENT_ID,
    },
  })

/** A script's whole connection by the device flow, approved by the owner with `areas` (default: all shown). */
export async function connectWithCode(
  h: OAuthHarness,
  params: { scope?: string; resource?: string; label?: string; areas?: string[] } = {},
) {
  const device = await deviceRequest(h.issuer, params)
  if (device.status !== 200) throw new Error(`device answered ${device.status}: ${device.text}`)
  const pending = await pollDevice(h.issuer, device.body.device_code)
  const uid = await confirmCode(h.owner, device.body.user_code)
  const consent = await answerConsent(h.owner, uid, { approve: true, areas: params.areas })
  if (consent.decision.status !== 200)
    throw new Error(`decision answered ${consent.decision.status}: ${consent.decision.text}`)
  const done = await browserCall(h.owner, String(consent.decision.body.redirectTo))
  const tokens = await pollDevice(h.issuer, device.body.device_code)
  return { device, pending, uid, consent, done, tokens }
}

export const refresh = (origin: string, clientId: string, refreshToken: string) =>
  agentCall(origin, "/oauth/token", {
    form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId },
  })
