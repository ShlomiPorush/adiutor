// The sync's connection to Adiutor: an OAuth client of the agent REST contract (the agent-access standard,
// client-contract.md), in the sync's own shape. It connects with the device grant as Adiutor's built-in client, asking
// only for the `sync` area, keeps the connection in an owner-only folder of its own (one file per Adiutor address,
// written in one step, never printed), refreshes the rotating token under a lock, and sends every push with the policy
// revision and the kind the endpoints listing gives. A push whose answer was lost, or that the server failed, is
// `outcome_unknown`: it is never sent again (a push is idempotent by design; the next run decides again). The skill's
// scripts implement the same contract for agents (skill/adiutor/scripts); this is its port for the bundle.

import { createHash, randomBytes } from "node:crypto"
import { closeSync, openSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve, win32 } from "node:path"
import { ClientError } from "./errors.ts"
import type { Runner } from "./exec.ts"
import type { FetchLike } from "./http.ts"
import { connectionLockOptions, fileLock } from "./lock.ts"
import { ownerOnlyFolder } from "./owner-folder.ts"
import { writeAtomic } from "./state.ts"

export { ClientError } from "./errors.ts"
export { othersAllowed } from "./owner-folder.ts"

/** Adiutor's built-in client of the skill and the sync, and the area the sync asks for (D3). */
export const CLIENT_ID = "adiutor-agent"
export const SYNC_SCOPE = "sync"
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const PATHS = { device: "/oauth/device", token: "/oauth/token", revoke: "/oauth/revoke" } as const
export const ENDPOINTS_PATH = "/api/v1/agent/endpoints"
const POLICY_HEADER = "x-adiutor-policy"
const KIND_HEADER = "x-adiutor-kind"
const SECRET = /^[A-Za-z0-9._~+/=-]{1,4096}$/
const REVISION = /^[A-Za-z0-9._-]{1,128}$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const PLAIN = /^[^"\\\u0000-\u001f\u007f]*$/
// The only address shape kept: it goes into printed commands, so nothing a shell would run may reach it.
const SAFE_ORIGIN = /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:[1-9][0-9]{0,4})?$/
const LOOPBACK = ["127.0.0.1", "[::1]", "localhost"]
/** Reuse the access token until a minute before it ends. */
const ACCESS_MARGIN_S = 60
/** A refresh that started less than this ago may still be on its way: never send it again. */
const REFRESH_GRACE_S = 30
const OAUTH_TIMEOUT_MS = 15_000
/** Adiutor answers a call within 60 s or says the outcome is unknown. */
const API_TIMEOUT_MS = 75_000
const BUSY_WAIT_MS = 2_000

/** Failures before a request left the computer: it was not sent. Anything else may have reached Adiutor. */
const NOT_SENT = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
])

export type ClientDeps = {
  fetch: FetchLike
  runner: Runner
  /** The full path of a Windows component in System32 (icacls, whoami), or undefined. */
  systemCommand: (name: string) => Promise<string | undefined>
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** Milliseconds since the epoch. */
  now: () => number
  sleep: (ms: number) => Promise<void>
  httpTimeoutMs?: number
}

/** Adiutor's address as an issuer: https (http only on this computer), a plain origin with nothing after it. */
export function issuerOf(raw: string): string {
  const url = URL.parse(raw.trim())
  if (!url) throw new ClientError("insecure_url", "The address is not an address.")
  const loopback = LOOPBACK.includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new ClientError("insecure_url", "The address must start with https:// (http only for this computer).")
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw new ClientError("insecure_url", "Use the address alone, for example https://adiutor.example.com.")
  if (!SAFE_ORIGIN.test(url.origin))
    throw new ClientError("insecure_url", "Use the address alone, for example https://adiutor.example.com.")
  return url.origin
}

/**
 * The sync's own credentials folder, never the skill's (~/.adiutor holds the agents' connection, with other areas):
 * %LOCALAPPDATA%\adiutor\connection on Windows, inside the user profile; $XDG_CONFIG_HOME/adiutor/connection (or
 * ~/.config/adiutor/connection) elsewhere. Next to the sync's env file by default.
 */
export function credentialsDir(platform: NodeJS.Platform, env: Record<string, string | undefined>): string {
  if (platform === "win32") {
    const profile = win32.resolve(env.USERPROFILE || homedir())
    const base = env.LOCALAPPDATA || win32.join(profile, "AppData", "Local")
    const dir = win32.resolve(base, "adiutor", "connection")
    const lower = dir.toLowerCase()
    const home = profile.toLowerCase()
    if (!lower.startsWith(`${home}\\`))
      throw new ClientError("insecure_credentials", `Keep the sync's connection inside your user profile, not ${dir}.`)
    return dir
  }
  return resolve(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "adiutor", "connection")
}

type Record_ = {
  v: number
  issuer: string
  label: string
  refreshToken: string
  accessToken: string
  accessExpiresAt: number
  scope: string
  refreshStartedAt: number
  refreshRetried: number
  /** When Adiutor ended the connection (seconds); the tokens are gone or unusable then. 0 while it lives. */
  endedAt: number
  /** Refresh tokens of a replaced or disconnected connection, still to be revoked. */
  toRevoke: string
  /** A random id given to each approved connection on this computer (empty before it existed): what a kept claim names. */
  connection: string
}
const NUMBERS = ["v", "accessExpiresAt", "refreshStartedAt", "refreshRetried", "endedAt"] as const
const TEXTS = ["issuer", "label", "refreshToken", "accessToken", "scope", "toRevoke", "connection"] as const

type Answer = { status: number; text: string; json: unknown; isJson: boolean; challenge: string }
type Listing = { revision: string; entries: { method: string; path: string; kind: "read" | "act" }[] }

/** The calls of a listing: method, path template and kind; anything but an explicit read counts as an act. */
function entriesOf(endpoints: unknown[]): Listing["entries"] {
  const entries: Listing["entries"] = []
  for (const e of endpoints as Record<string, unknown>[]) {
    const method = String(e?.method ?? "")
    const path = String(e?.path ?? "")
    if (/^[A-Z]{3,7}$/.test(method) && path.startsWith("/api/v1/"))
      entries.push({ method, path, kind: e?.kind === "read" ? "read" : "act" })
  }
  return entries
}

/** What a push came to. Never holds a token. */
export type PushResult =
  | { kind: "answer"; status: number; body: unknown }
  | { kind: "outcome_unknown"; status?: number }
  | { kind: "failed"; code: string; message: string }

/** The sync's connection to one Adiutor address. */
export function syncClient(issuer: string, deps: ClientDeps) {
  const dir = credentialsDir(deps.platform, deps.env)
  const key = createHash("sha256").update(issuer).digest("hex").slice(0, 32)
  const file = join(dir, `${key}.json`)
  const lockFile = join(dir, `${key}.lock`)
  const nowS = () => Math.floor(deps.now() / 1000)
  const hex = (n: number) => randomBytes(n).toString("hex")

  // --- The folder: owner-only, checked, never loosened (src/sync/owner-folder.ts) ---

  const folder = ownerOnlyFolder(dir, deps)
  const secureDir = () => folder.secure()
  const name = `${key}.json`

  // --- The record: flat JSON with plain values, written in one step ---

  async function readRecord(): Promise<Record_ | null> {
    const text = await folder.read(name)
    if (text === null) return null
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ClientError("insecure_credentials", `${file} is damaged. Delete it and connect again.`)
    }
    const rec = { v: 1 } as Record_
    for (const k of NUMBERS) rec[k] = Number(parsed[k]) || 0
    for (const k of TEXTS) rec[k] = String(parsed[k] ?? "")
    return rec
  }

  async function writeRecord(rec: Record_): Promise<void> {
    await secureDir()
    const parts = [
      ...NUMBERS.map((k) => `"${k}":${Math.max(0, Math.floor(Number(rec[k]) || 0))}`),
      ...TEXTS.map((k) => {
        const value = String(rec[k] ?? "")
        if (!PLAIN.test(value))
          throw new ClientError("unexpected_answer", `Adiutor sent a value that cannot be stored (${k}).`)
        return `"${k}":"${value}"`
      }),
    ]
    await folder.write(name, `{${parts.join(",")}}\n`)
  }

  const emptyRecord = (label: string): Record_ => ({
    v: 1,
    issuer,
    label,
    refreshToken: "",
    accessToken: "",
    accessExpiresAt: 0,
    scope: "",
    refreshStartedAt: 0,
    refreshRetried: 0,
    endedAt: 0,
    toRevoke: "",
    connection: "",
  })

  // --- The lock: a file created exclusively, naming its holder; never taken from a live holder (src/sync/lock.ts) ---

  const lock = fileLock(lockFile, deps)
  const lockOptions = connectionLockOptions(
    lockFile,
    dir,
    deps,
    "Another sync command is using this connection. Nothing was sent; run it again.",
  )
  const mine = (token: string) => lock.mine(token)
  async function withLock<T>(fn: (token: string) => Promise<T>, own?: string): Promise<T> {
    await secureDir()
    return lock.withLock({ ...lockOptions, ...(own ? { own } : {}) }, fn)
  }
  /** Before spending a one-time secret: the lock must still be this command's, or nothing is sent. */
  const assertMine = (token: string) => {
    if (!mine(token)) throw new ClientError("busy", "Another sync command took over this connection. Run it again.")
  }

  // --- Requests: no redirects, sent or not sent ---

  async function request(
    method: string,
    url: string,
    init: {
      form?: Record<string, string>
      bearer?: string
      json?: string
      policy?: string
      kind?: string
      timeout?: number
    } = {},
  ): Promise<Answer> {
    const headers: Record<string, string> = { accept: "application/json" }
    let body: string | undefined
    if (init.form) {
      headers["content-type"] = "application/x-www-form-urlencoded"
      body = new URLSearchParams(init.form).toString()
    } else if (init.json !== undefined) {
      headers["content-type"] = "application/json"
      body = init.json
    }
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`
    if (init.policy) {
      headers[POLICY_HEADER] = init.policy
      headers[KIND_HEADER] = init.kind ?? "act"
    }
    let response: Response
    try {
      response = await deps.fetch(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(init.timeout ?? deps.httpTimeoutMs ?? OAUTH_TIMEOUT_MS),
      })
    } catch (error) {
      const err = error as Error & { cause?: { code?: string }; code?: string }
      const code = err.cause?.code ?? err.code
      throw new ClientError("unreachable", `Cannot reach ${issuer} (${code ?? err.name ?? "network error"}).`, {
        sent: !NOT_SENT.has(code ?? ""),
      })
    }
    let text: string
    try {
      text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer())
    } catch {
      // The answer started and broke off: Adiutor got the request and may have acted on it.
      throw new ClientError("unreachable", `The answer from ${issuer} broke off.`, { sent: true })
    }
    let json: unknown = null
    let isJson = false
    try {
      json = JSON.parse(text)
      isJson = true
    } catch {}
    return { status: response.status, text, json, isJson, challenge: response.headers.get("www-authenticate") ?? "" }
  }

  const oauth = (path: string, form: Record<string, string>) =>
    request("POST", `${issuer}${path}`, { form: { ...form, client_id: CLIENT_ID } })

  const field = (a: Answer, name: string): unknown => {
    const body = a.json
    if (body === null || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, name)) return undefined
    return (body as Record<string, unknown>)[name]
  }
  const topText = (a: Answer, name: string) => {
    const value = field(a, name)
    return typeof value === "string" ? value : undefined
  }

  function tokensFrom(a: Answer) {
    const access = field(a, "access_token")
    const refresh = field(a, "refresh_token")
    const scope = topText(a, "scope") ?? ""
    const ok = (v: unknown): v is string => typeof v === "string" && SECRET.test(v)
    if (!ok(access) || !ok(refresh) || !PLAIN.test(scope))
      throw new ClientError("unexpected_answer", "Adiutor answered without usable tokens.")
    return {
      refreshToken: refresh,
      accessToken: access,
      accessExpiresAt: nowS() + Math.max(0, Math.floor(Number(field(a, "expires_in")) || 0)),
      scope,
    }
  }

  /**
   * Revokes refresh tokens at Adiutor's revocation endpoint (the library's own /oauth/revoke, which ends the whole
   * grant). Returns the ones whose outcome is not known to be done, to keep and retry.
   */
  async function revokeAll(tokens: string): Promise<string> {
    const left: string[] = []
    for (const token of tokens.split(" ").filter(Boolean)) {
      const r = await oauth(PATHS.revoke, { token, token_type_hint: "refresh_token" }).catch(() => null)
      if (r?.status !== 200) left.push(token)
    }
    return left.join(" ")
  }

  async function revokeLeft(rec: Record_): Promise<Record_> {
    if (!rec.toRevoke) return rec
    const next = { ...rec, toRevoke: await revokeAll(rec.toRevoke) }
    if (next.toRevoke !== rec.toRevoke) await writeRecord(next)
    return next
  }

  // --- Refresh: reuse until a minute before the end; under the lock; a refresh in flight is never sent twice ---

  const usable = (rec: Record_) =>
    Boolean(rec.accessToken) && rec.accessExpiresAt - nowS() > ACCESS_MARGIN_S && !rec.refreshStartedAt

  const ended = () =>
    new ClientError(
      "connection_ended",
      "This connection has ended (disconnected in Adiutor, unused for its idle days, sign-in settings changed, or its token was used twice).",
    )

  async function accessToken(stale?: string): Promise<string> {
    const first = await readRecord()
    if (!first?.refreshToken) throw new ClientError("not_connected", "The sync is not connected to this Adiutor.")
    if (!stale && usable(first)) return first.accessToken
    return withLock(async (lock) => {
      let rec = await readRecord()
      if (!rec?.refreshToken) throw new ClientError("not_connected", "The sync is not connected to this Adiutor.")
      rec = await revokeLeft(rec)
      // Another command refreshed while this one waited for the lock.
      if (usable(rec) && rec.accessToken !== stale) return rec.accessToken
      const before = { refreshStartedAt: rec.refreshStartedAt, refreshRetried: rec.refreshRetried }
      if (rec.refreshStartedAt && nowS() - rec.refreshStartedAt < REFRESH_GRACE_S)
        throw new ClientError(
          "busy",
          "Another sync command is refreshing this connection. Nothing was sent; run it again.",
        )
      if (rec.refreshStartedAt) {
        // The last refresh got no answer. Trying once more either continues the connection or ends it on the server.
        if (rec.refreshRetried) {
          if (!rec.endedAt) await writeRecord({ ...rec, endedAt: nowS() })
          throw new ClientError(
            "connection_ended",
            "Two refreshes got no answer, so this connection cannot be trusted. Connect the sync again with --replace.",
          )
        }
        rec.refreshRetried = 1
      }
      rec.refreshStartedAt = nowS()
      await writeRecord(rec)
      assertMine(lock)
      let r: Answer
      try {
        r = await oauth(PATHS.token, {
          grant_type: "refresh_token",
          refresh_token: rec.refreshToken,
          resource: `${issuer}/api/v1`,
        })
      } catch (error) {
        // Nothing left the computer: the token is as good as before.
        if (error instanceof ClientError && error.extra.sent === false) await writeRecord({ ...rec, ...before })
        throw error
      }
      if (r.status === 200) {
        const next = { ...rec, ...tokensFrom(r), refreshStartedAt: 0, refreshRetried: 0 }
        // The lock was taken meanwhile: keep the new tokens anyway, under a fresh lock.
        if (!mine(lock)) await withLock(async () => writeRecord(next), lock)
        else await writeRecord(next)
        return next.accessToken
      }
      if (field(r, "error") === "invalid_grant") {
        // Kept as ended (no token), so the state shows that Adiutor ended it.
        await writeRecord({ ...emptyRecord(rec.label), toRevoke: rec.toRevoke, endedAt: nowS() })
        throw ended()
      }
      // Refused before the token was spent (a 4xx); a 5xx may have come after.
      if (r.status < 500) await writeRecord({ ...rec, ...before })
      throw new ClientError(`http_${r.status}`, `Refreshing the connection failed (${r.status}).`, { status: r.status })
    })
  }

  // --- The endpoints listing and the kind of each call ---

  /**
   * The list, read fresh once per run. Fails closed: when it cannot be read, or is not a list, nothing is sent. A 401
   * with the token challenge gets one refresh and one resend; the connection's own errors are passed on as they are.
   */
  async function fetchListing(): Promise<Listing> {
    const unavailable = () =>
      new ClientError("endpoints_unavailable", "The list of allowed calls could not be read, so nothing was sent.")
    // A read, as the skill sends it: once more after a lost or broken answer, after 429 busy (a short wait), and after
    // the token refusal (a refresh); each at most once.
    let token = await accessToken()
    let refreshed = false
    let busyRetried = false
    let netRetried = false
    let a: Answer
    for (;;) {
      try {
        a = await request("GET", `${issuer}${ENDPOINTS_PATH}`, { bearer: token })
      } catch (error) {
        if (!(error instanceof ClientError) || error.code !== "unreachable") throw error
        if (netRetried) throw unavailable()
        netRetried = true
        continue
      }
      if (!refreshed && a.status === 401 && a.challenge.includes('error="invalid_token"')) {
        refreshed = true
        token = await accessToken(token)
        continue
      }
      if (!busyRetried && a.status === 429 && topText(a, "error") === "busy") {
        busyRetried = true
        await deps.sleep(BUSY_WAIT_MS)
        continue
      }
      break
    }
    const endpoints = field(a, "endpoints")
    const revision = field(a, "revision")
    if (a.status !== 200 || !Array.isArray(endpoints) || typeof revision !== "string" || !REVISION.test(revision))
      throw unavailable()
    const fresh = { revision, entries: entriesOf(endpoints) }
    await saveListing(fresh)
    return fresh
  }

  // --- The stored listing (client-contract.md, "Kind from the server"): kept in the data folder for this address,
  // reused by every later command, and fetched again only when it is missing, unreadable, for another address, does
  // not hold the call, or after policy_changed. It holds no secret: the open routes, their kinds and the revision. ---

  const listingFile = join(dirname(dir), `endpoints-${key}.json`)

  function readStoredListing(): Listing | null {
    try {
      const root = JSON.parse(readFileSync(listingFile, "utf8")) as Record<string, unknown>
      const { revision, endpoints } = root
      if (
        root.issuer !== issuer ||
        typeof revision !== "string" ||
        !REVISION.test(revision) ||
        !Array.isArray(endpoints)
      )
        return null
      return { revision, entries: entriesOf(endpoints) }
    } catch {
      return null
    }
  }

  async function saveListing(list: Listing): Promise<void> {
    const text = `${JSON.stringify({ issuer, revision: list.revision, endpoints: list.entries })}
`
    // A listing that cannot be kept is fetched again by the next command: nothing else depends on it.
    await writeAtomic(listingFile, text, { platform: deps.platform, now: deps.now, sleep: deps.sleep }).catch(() => {})
  }

  /** A connection made or ended: its listing may differ (other areas), so the next command fetches it. */
  const forgetListing = () => {
    listing = null
    rmSync(listingFile, { force: true })
  }

  const kindOf = (list: Listing, method: string, path: string) =>
    list.entries.find((e) => e.method === method && e.path === path)?.kind

  let listing: Listing | null = null

  /**
   * The kind of a call from the stored listing; a listing that is missing, unreadable or for another address is fetched,
   * and so is a stored one that does not hold the call (it may be older than the server). Undefined: not open to this
   * connection. Throws the listing's ClientError when it cannot be fetched.
   */
  async function kindFor(method: string, path: string): Promise<{ list: Listing; kind: "read" | "act" | undefined }> {
    const stored = listing ?? readStoredListing()
    let list = stored ?? (await fetchListing())
    let kind = kindOf(list, method, path)
    if (!kind && stored) {
      list = await fetchListing()
      kind = kindOf(list, method, path)
    }
    listing = list
    return { list, kind }
  }

  /**
   * Whether the endpoints listing holds a call: `listed`; `older` when it holds the sync's pushes but not this call (an
   * Adiutor from before it); otherwise why it cannot be made (the listing unreadable, or the sync area not granted).
   */
  async function route(method: string, path: string): Promise<"listed" | "older" | { code: string; message: string }> {
    let found: Awaited<ReturnType<typeof kindFor>>
    try {
      found = await kindFor(method, path)
    } catch (error) {
      if (error instanceof ClientError) return { code: error.code, message: error.message }
      throw error
    }
    if (found.kind) return "listed"
    if (kindOf(found.list, "POST", "/api/v1/sync/t3")) return "older"
    return {
      code: "not_allowed",
      message: "This connection may not make this call: connect the sync again and approve the sync area.",
    }
  }

  /**
   * Pushes one payload. Every resend follows a refusal Adiutor makes before any route code runs: a 401 with the token
   * challenge (refresh, once), 429 busy (wait, once), 409 policy_changed (the list again, once). A push that may have
   * reached Adiutor and lost its answer, or that Adiutor failed (5xx), is outcome_unknown and never sent again.
   */
  async function push(path: string, payload: unknown, bind: { connection?: string } = {}): Promise<PushResult> {
    /**
     * A push bound to a connection (`run --request`): the token it sends must be that connection's, read under the
     * connection's lock, which connect --replace and disconnect take too. A token of a newer connection is never sent
     * for a run that began under another; the old connection's token works only for the old connection.
     */
    const boundTo = async (token: string) =>
      bind.connection === undefined ||
      withLock(async () => {
        const rec = await readRecord()
        return Boolean(
          rec && !rec.endedAt && rec.accessToken === token && `${issuer}#${rec.connection}` === bind.connection,
        )
      })
    const changed: PushResult = {
      kind: "failed",
      code: "connection_changed",
      message: "The sync connected again during this run, so nothing more is sent for the request it began with.",
    }
    try {
      let { list, kind } = await kindFor("POST", path)
      if (!kind)
        return {
          kind: "failed",
          code: "not_allowed",
          message: "This connection may not make this call: connect the sync again and approve the sync area.",
        }
      const json = JSON.stringify(payload)
      let busyRetried = false
      let policyRetried = false
      let refreshed = false
      let token = await accessToken()
      if (!(await boundTo(token))) return changed
      for (;;) {
        let a: Answer
        try {
          a = await request("POST", `${issuer}${path}`, {
            bearer: token,
            json,
            policy: list.revision,
            kind,
            timeout: deps.httpTimeoutMs ?? API_TIMEOUT_MS,
          })
        } catch (error) {
          if (error instanceof ClientError && error.code === "unreachable" && error.extra.sent !== false)
            return { kind: "outcome_unknown" }
          throw error
        }
        if (!refreshed && a.status === 401 && a.challenge.includes('error="invalid_token"')) {
          refreshed = true
          token = await accessToken(token)
          if (!(await boundTo(token))) return changed
          continue
        }
        if (!busyRetried && a.status === 429 && topText(a, "error") === "busy") {
          busyRetried = true
          await deps.sleep(BUSY_WAIT_MS)
          continue
        }
        if (a.status === 409 && topText(a, "error") === "policy_changed") {
          if (policyRetried)
            return {
              kind: "failed",
              code: "policy_changed",
              message: "Adiutor refused the call twice: its calls changed.",
            }
          policyRetried = true
          list = await fetchListing()
          listing = list
          kind = kindOf(list, "POST", path)
          if (!kind) return { kind: "failed", code: "not_allowed", message: "This connection may not make this call." }
          continue
        }
        if (kind === "act" && a.status >= 500) return { kind: "outcome_unknown", status: a.status }
        return { kind: "answer", status: a.status, body: a.isJson ? a.json : a.text }
      }
    } catch (error) {
      if (error instanceof ClientError) return { kind: "failed", code: error.code, message: error.message }
      throw error
    }
  }

  // --- Connecting: the device grant, approved in the browser ---

  /** Whether a connection is kept for this address (its name and areas), or ended; and whether a revoke is pending. */
  async function status() {
    const rec = await readRecord()
    const revocationPending = Boolean(rec?.toRevoke)
    return rec?.refreshToken && !rec.endedAt
      ? { connected: true as const, state: "connected" as const, label: rec.label, scope: rec.scope, revocationPending }
      : {
          connected: false as const,
          state: rec?.endedAt ? ("ended" as const) : ("not_connected" as const),
          revocationPending,
        }
  }

  /**
   * The connection kept for this address, as the address and the connection's own id: a claim Adiutor handed one
   * connection is never run by another (connect --replace) or for another address. Null when none is connected.
   */
  async function identity(): Promise<string | null> {
    const rec = await readRecord()
    return rec?.refreshToken && !rec.endedAt ? `${issuer}#${rec.connection}` : null
  }

  /** Every command retries the revocations a disconnect or a replaced connection left (outcome unknown). */
  async function retryRevocations(): Promise<boolean> {
    const first = await readRecord()
    if (!first?.toRevoke) return false
    return withLock(async (lock) => {
      let rec = await readRecord()
      if (!rec?.toRevoke) return false
      assertMine(lock)
      rec = await revokeLeft(rec)
      // Nothing left in it: a disconnected connection is gone.
      if (!rec.refreshToken && !rec.toRevoke && !rec.endedAt) folder.remove(name)
      return rec.toRevoke !== ""
    })
  }

  /**
   * disconnect: revokes the connection at Adiutor (which ends the whole grant), then deletes it. When the revocation's
   * outcome is unknown, the token is kept, with no connection, and the next command retries it.
   */
  async function disconnect(): Promise<{ wasConnected: boolean; revocationPending: boolean }> {
    return withLock(async (lock) => {
      const rec = await readRecord()
      if (!rec) return { wasConnected: false, revocationPending: false }
      const wasConnected = Boolean(rec.refreshToken) && !rec.endedAt
      const tokens = [rec.toRevoke, rec.refreshToken].filter(Boolean).join(" ")
      // The intent first, in one step: no usable token is left, and every token to revoke is kept. A crash or a lost
      // answer from here on leaves the connection disconnected with its revocation pending, never active.
      await writeRecord({ ...emptyRecord(rec.label), toRevoke: tokens })
      forgetListing()
      assertMine(lock)
      const left = await revokeAll(tokens)
      if (!left) folder.remove(name)
      else if (left !== tokens) await writeRecord({ ...emptyRecord(rec.label), toRevoke: left })
      return { wasConnected, revocationPending: left !== "" }
    })
  }

  /** Checks that the folder can keep a connection and that the address answers as Adiutor, before any code exists. */
  async function prepare(): Promise<void> {
    await secureDir()
    const probe = join(dir, `.probe-${hex(4)}`)
    try {
      closeSync(openSync(probe, "wx", 0o600))
      rmSync(probe)
    } catch {
      throw new ClientError("cannot_save", `Cannot write in ${dir}. Allow the sync to write there.`)
    }
    const meta = await request("GET", `${issuer}/.well-known/oauth-authorization-server`)
    if (meta.status !== 200 || field(meta, "issuer") !== issuer)
      throw new ClientError(
        "unreachable",
        `${issuer} does not answer as Adiutor with agents allowed (${meta.status}). Check the address, and turn agents on in Settings, Agent access.`,
      )
  }

  /** Asks for a device code; the link carries the code (verification_uri_complete). */
  async function deviceCode(label: string) {
    const r = await oauth(PATHS.device, { scope: SYNC_SCOPE, resource: `${issuer}/api/v1`, client_label: label })
    if (r.status !== 200) throw new ClientError(`http_${r.status}`, `Adiutor did not start the approval (${r.status}).`)
    const code = topText(r, "device_code") ?? ""
    const userCode = topText(r, "user_code") ?? ""
    const link = topText(r, "verification_uri_complete") ?? ""
    if (!SECRET.test(code) || !/^[A-Z0-9-]{4,20}$/.test(userCode) || !PLAIN.test(link))
      throw new ClientError("unexpected_answer", "Adiutor answered without a code.")
    if (!link.startsWith(`${issuer}/`))
      throw new ClientError("unexpected_answer", "The approval link is not on Adiutor.")
    return {
      code,
      userCode,
      link,
      interval: Math.max(5, Math.floor(Number(field(r, "interval")) || 5)),
      expiresAt: deps.now() + Math.max(60, Math.floor(Number(field(r, "expires_in")) || 600)) * 1000,
    }
  }

  /**
   * Polls until the owner approves or denies, the code ends, or a poll's answer is lost (the code is never presented
   * again then: it may have been spent). Each poll spends a one-time secret, so it runs under the lock, sent only while
   * the lock is still this command's, and the lock is held until the connection is stored; a replaced one is revoked
   * once the new one is stored.
   */
  async function waitForApproval(device: Awaited<ReturnType<typeof deviceCode>>, label: string) {
    let interval = device.interval
    for (;;) {
      await deps.sleep(interval * 1000)
      if (deps.now() >= device.expiresAt + 60_000)
        throw new ClientError("expired", "The code expired before it was approved.")
      const step = await withLock(async (lock) => {
        assertMine(lock)
        let r: Answer
        try {
          r = await oauth(PATHS.token, { grant_type: DEVICE_GRANT, device_code: device.code })
        } catch (error) {
          if (error instanceof ClientError && error.extra.sent === false) return { kind: "again" as const }
          throw new ClientError(
            "unreachable",
            "The answer to the approval was lost, so the code is not used again. Run connect again.",
          )
        }
        if (r.status === 200) {
          const tokens = tokensFrom(r)
          let rec = (await readRecord()) ?? emptyRecord(label)
          const old = rec.refreshToken && rec.refreshToken !== tokens.refreshToken ? rec.refreshToken : ""
          rec = {
            ...rec,
            ...tokens,
            label,
            refreshStartedAt: 0,
            refreshRetried: 0,
            endedAt: 0,
            toRevoke: [rec.toRevoke, old].filter(Boolean).join(" "),
            connection: hex(8),
          }
          await writeRecord(rec)
          forgetListing()
          rec = await revokeLeft(rec)
          return { kind: "done" as const, scope: rec.scope, notRevoked: rec.toRevoke !== "" }
        }
        return { kind: "answer" as const, error: field(r, "error"), status: r.status }
      })
      if (step.kind === "done") return { scope: step.scope, notRevoked: step.notRevoked }
      if (step.kind === "again") continue
      if (step.error === "authorization_pending") continue
      if (step.error === "slow_down") {
        interval += 5
        continue
      }
      if (step.error === "access_denied") throw new ClientError("denied", "The owner did not approve the connection.")
      if (step.error === "expired_token" || step.error === "invalid_grant")
        throw new ClientError("expired", "The code is no longer valid.")
      throw new ClientError(`http_${step.status}`, `Waiting for the approval failed (${step.status}).`)
    }
  }

  /** Runs `fn` under the connection's lock, which connect --replace and disconnect take to change the connection. */
  const whileConnected = <T>(fn: () => Promise<T>) => withLock(async () => fn())

  return {
    dir,
    file,
    status,
    identity,
    whileConnected,
    prepare,
    deviceCode,
    waitForApproval,
    route,
    push,
    disconnect,
    retryRevocations,
  }
}

export type SyncClient = ReturnType<typeof syncClient>
