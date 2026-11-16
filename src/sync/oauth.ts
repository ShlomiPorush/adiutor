// The sync's connection to Adiutor: an OAuth client of the agent REST contract (the agent-access standard,
// client-contract.md), in the sync's own shape. It connects with the device grant as Adiutor's built-in client, asking
// only for the `sync` area, keeps the connection in an owner-only folder of its own (one file per Adiutor address,
// written in one step, never printed), refreshes the rotating token under a lock, and sends every push with the policy
// revision and the kind the endpoints listing gives. A push whose answer was lost, or that the server failed, is
// `outcome_unknown`: it is never sent again (a push is idempotent by design; the next run decides again). The skill's
// scripts implement the same contract for agents (skill/adiutor/scripts); this is its port for the bundle.

import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs"
import { homedir, hostname } from "node:os"
import { join, resolve, win32 } from "node:path"
import type { Runner } from "./exec.ts"
import type { FetchLike } from "./http.ts"

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
const LOCK_WAIT_MS = 20_000
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

/** A failure with a stable code; the message holds no token, code or secret. */
export class ClientError extends Error {
  override name = "ClientError"
  constructor(
    readonly code: string,
    message: string,
    readonly extra: { sent?: boolean; status?: number } = {},
  ) {
    super(message)
  }
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
  /** Refresh tokens of a replaced connection, still to be revoked. */
  toRevoke: string
}
const NUMBERS = ["v", "accessExpiresAt", "refreshStartedAt", "refreshRetried"] as const
const TEXTS = ["issuer", "label", "refreshToken", "accessToken", "scope", "toRevoke"] as const

type Answer = { status: number; text: string; json: unknown; isJson: boolean; challenge: string }
type Listing = { revision: string; entries: { method: string; path: string; kind: "read" | "act" }[] }

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
  const win = deps.platform === "win32"
  const nowS = () => Math.floor(deps.now() / 1000)
  const hex = (n: number) => randomBytes(n).toString("hex")
  const host = () => (win ? deps.env.COMPUTERNAME || hostname() : hostname())

  // --- The folder: owner-only, checked, never loosened ---

  let secured = false
  let checked = false

  async function icacls(args: string[]): Promise<void> {
    const exe = await deps.systemCommand("icacls")
    if (!exe) throw new ClientError("insecure_credentials", "icacls was not found in %SystemRoot%\\System32.")
    for (let i = 0; ; i++) {
      const result = await deps.runner(exe, args, { timeoutMs: 30_000 })
      if (result.code === 0) return
      if (i >= 4) throw new ClientError("insecure_credentials", `Could not limit ${dir} to your user (icacls failed).`)
      await deps.sleep(100 + Math.random() * 200)
    }
  }

  async function userSid(): Promise<string> {
    const whoami = await deps.systemCommand("whoami")
    if (!whoami) throw new ClientError("insecure_credentials", "whoami was not found in %SystemRoot%\\System32.")
    const result = await deps.runner(whoami, ["/user", "/fo", "csv", "/nh"], { timeoutMs: 30_000 })
    const sid = /"(S-1-[0-9-]+)"\s*$/.exec(result.stdout.trim())?.[1]
    if (result.code !== 0 || !sid) throw new ClientError("insecure_credentials", "Could not tell the current user.")
    return sid
  }

  /** Reads the folder's and its files' ACLs back and allows no one but this user, SYSTEM and Administrators. */
  async function assertOnlyUser(sid: string): Promise<void> {
    const saved = join(dir, `.acl-${hex(4)}`)
    try {
      await icacls([dir, "/save", saved, "/T", "/Q"])
      const other = othersAllowed(readFileSync(saved).toString("utf16le"), sid)
      if (other)
        throw new ClientError("insecure_credentials", `Others can open ${dir} (${other}). Remove their access.`)
    } finally {
      rmSync(saved, { force: true })
    }
  }

  function assertOwnMode(path: string, mode: number, uid: number): void {
    if (uid !== process.getuid?.())
      throw new ClientError("insecure_credentials", `${path} belongs to another user. Use a folder of your own.`)
    if (mode & 0o077) throw new ClientError("insecure_credentials", `Others can open ${path}. Run: chmod 700 '${path}'`)
  }

  /** Creates the folder if needed and limits it to this user; refuses one that is open to others. */
  async function secureDir(): Promise<void> {
    if (secured) return
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch {
      throw new ClientError("cannot_save", `Cannot create ${dir}. Allow the sync to write there.`)
    }
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new ClientError("insecure_credentials", `${dir} must be a plain folder, not a link.`)
    if (win) {
      const sid = await userSid()
      await icacls([
        dir,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F",
        "/Q",
      ])
      // The owner may always change an ACL, so the folder and its files must be this user's.
      await icacls([dir, "/setowner", `*${sid}`, "/T", "/Q"])
      await assertOnlyUser(sid)
    } else assertOwnMode(dir, st.mode, st.uid)
    secured = true
  }

  /** Before the connection's file is read: the folder must still be one only this user can open. Checks only. */
  async function checkDir(): Promise<void> {
    if (secured || checked) return
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new ClientError("insecure_credentials", `${dir} must be a plain folder, not a link.`)
    if (win) await assertOnlyUser(await userSid())
    else assertOwnMode(dir, st.mode, st.uid)
    checked = true
  }

  // --- The record: flat JSON with plain values, written in one step ---

  async function readRecord(): Promise<Record_ | null> {
    let text: string
    try {
      const st = lstatSync(file)
      if (st.isSymbolicLink() || !st.isFile())
        throw new ClientError("insecure_credentials", `${file} must be a plain file.`)
      if (!win && (st.uid !== process.getuid?.() || st.mode & 0o077))
        throw new ClientError("insecure_credentials", `Others can read ${file}. Run: chmod 600 '${file}'`)
      await checkDir()
      text = readFileSync(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
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
    const tmp = `${file}.${hex(6)}.tmp`
    let fd: number | undefined
    try {
      fd = openSync(tmp, "wx", 0o600)
      writeSync(fd, `{${parts.join(",")}}\n`)
      fsyncSync(fd)
    } catch {
      throw new ClientError("cannot_save", `Cannot write in ${dir}. Allow the sync to write there.`)
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    // On Windows an open handle (an antivirus scan) can refuse the rename for a moment.
    const until = deps.now() + 5_000
    for (;;) {
      try {
        renameSync(tmp, file)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? ""
        if (!win || !["EPERM", "EBUSY", "EACCES"].includes(code) || deps.now() > until) {
          rmSync(tmp, { force: true })
          throw new ClientError("cannot_save", `Cannot replace ${file}.`)
        }
        await deps.sleep(100)
      }
    }
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
    toRevoke: "",
  })

  // --- The lock: a file created exclusively, naming its holder; never taken from a live holder ---

  type Held = { token?: string; pid?: number; host?: string; startedAt?: number; empty?: true; mtime?: number }
  function readLock(path: string): Held | null {
    try {
      const held = JSON.parse(readFileSync(path, "utf8")) as Held
      return typeof held?.token === "string" ? held : { empty: true, mtime: lstatSync(path).mtimeMs }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      try {
        return { empty: true, mtime: lstatSync(path).mtimeMs }
      } catch {
        return null
      }
    }
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return win && (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  async function acquire(own?: string): Promise<string> {
    await secureDir()
    const token = hex(16)
    const line = JSON.stringify({ pid: process.pid, host: host(), token, startedAt: nowS() })
    const deadline = deps.now() + LOCK_WAIT_MS
    for (;;) {
      let fd: number | undefined
      try {
        fd = openSync(lockFile, "wx", 0o600)
        writeSync(fd, line)
        closeSync(fd)
        return token
      } catch (error) {
        if (fd !== undefined) closeSync(fd)
        const code = (error as NodeJS.ErrnoException).code
        // Windows refuses for a moment to create a file whose name is still being deleted.
        if (win && (code === "EPERM" || code === "EACCES") && deps.now() < deadline) {
          await deps.sleep(50 + Math.random() * 100)
          continue
        }
        if (code !== "EEXIST") throw new ClientError("cannot_save", `Cannot create a lock in ${dir}.`)
      }
      const held = readLock(lockFile)
      if (own && held && !held.empty && held.token === own) return own
      const dead = held?.empty
        ? deps.now() - (held.mtime ?? 0) > 60_000
        : held && String(held.host).toLowerCase() === host().toLowerCase() && !alive(Number(held.pid))
      if (dead && held && breakLock(held)) continue
      if (deps.now() > deadline) {
        const old = held && !held.empty && nowS() - Number(held.startedAt) > 600
        throw new ClientError(
          "busy",
          old
            ? `Another sync command has held ${lockFile} for over 10 minutes. If none is running, delete that file.`
            : "Another sync command is using this connection. Nothing was sent; run it again.",
        )
      }
      await deps.sleep(100 + Math.random() * 200)
    }
  }

  /** Moves a dead holder's lock away atomically; puts it back when what was moved is not the dead lock. */
  function breakLock(held: Held): boolean {
    const moved = `${lockFile}.${hex(6)}.dead`
    try {
      renameSync(lockFile, moved)
    } catch {
      return true
    }
    const got = readLock(moved)
    if (got && (held.empty ? got.empty : got.token === held.token)) {
      rmSync(moved, { force: true })
      return true
    }
    try {
      // A link, not a rename: a newer lock already in its place wins.
      linkSync(moved, lockFile)
    } catch {}
    rmSync(moved, { force: true })
    return false
  }

  const mine = (token: string) => readLock(lockFile)?.token === token
  async function withLock<T>(fn: (token: string) => Promise<T>, own?: string): Promise<T> {
    const token = await acquire(own)
    try {
      return await fn(token)
    } finally {
      if (mine(token)) rmSync(lockFile, { force: true })
    }
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

  async function revokeLeft(rec: Record_): Promise<Record_> {
    if (!rec.toRevoke) return rec
    const left: string[] = []
    for (const token of rec.toRevoke.split(" ").filter(Boolean)) {
      const r = await oauth(PATHS.revoke, { token, token_type_hint: "refresh_token" }).catch(() => null)
      if (r?.status !== 200) left.push(token)
    }
    const next = { ...rec, toRevoke: left.join(" ") }
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
        if (rec.refreshRetried)
          throw new ClientError(
            "connection_ended",
            "Two refreshes got no answer, so this connection cannot be trusted. Connect the sync again with --replace.",
          )
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
        if (rec.toRevoke) await writeRecord({ ...emptyRecord(rec.label), toRevoke: rec.toRevoke })
        else rmSync(file, { force: true })
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
    const read = async (token: string) => {
      try {
        return await request("GET", `${issuer}${ENDPOINTS_PATH}`, { bearer: token })
      } catch (error) {
        if (error instanceof ClientError && error.code === "unreachable") throw unavailable()
        throw error
      }
    }
    const token = await accessToken()
    let a = await read(token)
    if (a.status === 401 && a.challenge.includes('error="invalid_token"')) a = await read(await accessToken(token))
    const endpoints = field(a, "endpoints")
    const revision = field(a, "revision")
    if (a.status !== 200 || !Array.isArray(endpoints) || typeof revision !== "string" || !REVISION.test(revision))
      throw unavailable()
    const entries: Listing["entries"] = []
    for (const e of endpoints as Record<string, unknown>[]) {
      const method = String(e?.method ?? "")
      const path = String(e?.path ?? "")
      // Anything but an explicit read counts as an act.
      if (/^[A-Z]{3,7}$/.test(method) && path.startsWith("/api/v1/"))
        entries.push({ method, path, kind: e?.kind === "read" ? "read" : "act" })
    }
    return { revision, entries }
  }

  const kindOf = (list: Listing, method: string, path: string) =>
    list.entries.find((e) => e.method === method && e.path === path)?.kind

  let listing: Listing | null = null

  /**
   * Pushes one payload. Every resend follows a refusal Adiutor makes before any route code runs: a 401 with the token
   * challenge (refresh, once), 429 busy (wait, once), 409 policy_changed (the list again, once). A push that may have
   * reached Adiutor and lost its answer, or that Adiutor failed (5xx), is outcome_unknown and never sent again.
   */
  async function push(path: string, payload: unknown): Promise<PushResult> {
    try {
      listing ??= await fetchListing()
      let kind = kindOf(listing, "POST", path)
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
      for (;;) {
        let a: Answer
        try {
          a = await request("POST", `${issuer}${path}`, {
            bearer: token,
            json,
            policy: listing.revision,
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
          listing = await fetchListing()
          kind = kindOf(listing, "POST", path)
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

  /** Whether a connection is kept for this address, and its name and areas. */
  async function status() {
    const rec = await readRecord()
    return rec?.refreshToken
      ? { connected: true as const, label: rec.label, scope: rec.scope }
      : { connected: false as const }
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
   * again then: it may have been spent). Stores the connection under the lock; a replaced one is revoked once the new
   * one is stored.
   */
  async function waitForApproval(device: Awaited<ReturnType<typeof deviceCode>>, label: string) {
    let interval = device.interval
    for (;;) {
      await deps.sleep(interval * 1000)
      if (deps.now() >= device.expiresAt + 60_000)
        throw new ClientError("expired", "The code expired before it was approved.")
      let r: Answer
      try {
        r = await oauth(PATHS.token, { grant_type: DEVICE_GRANT, device_code: device.code })
      } catch (error) {
        if (error instanceof ClientError && error.extra.sent === false) continue
        throw new ClientError(
          "unreachable",
          "The answer to the approval was lost, so the code is not used again. Run connect again.",
        )
      }
      if (r.status === 200) {
        const tokens = tokensFrom(r)
        return withLock(async () => {
          let rec = (await readRecord()) ?? emptyRecord(label)
          const old = rec.refreshToken && rec.refreshToken !== tokens.refreshToken ? rec.refreshToken : ""
          rec = {
            ...rec,
            ...tokens,
            label,
            refreshStartedAt: 0,
            refreshRetried: 0,
            toRevoke: [rec.toRevoke, old].filter(Boolean).join(" "),
          }
          await writeRecord(rec)
          rec = await revokeLeft(rec)
          return { scope: rec.scope, notRevoked: rec.toRevoke !== "" }
        })
      }
      const error = field(r, "error")
      if (error === "authorization_pending") continue
      if (error === "slow_down") {
        interval += 5
        continue
      }
      if (error === "access_denied") throw new ClientError("denied", "The owner did not approve the connection.")
      if (error === "expired_token" || error === "invalid_grant")
        throw new ClientError("expired", "The code is no longer valid.")
      throw new ClientError(`http_${r.status}`, `Waiting for the approval failed (${r.status}).`)
    }
  }

  return { dir, file, status, prepare, deviceCode, waitForApproval, push }
}

export type SyncClient = ReturnType<typeof syncClient>

/**
 * What in saved ACLs (icacls /save: one SDDL line per object) lets anyone but this user, SYSTEM and Administrators
 * in. Anything but plain allow and deny entries counts too: refused, not guessed.
 */
export function othersAllowed(saved: string, userSid: string): string | null {
  const allowed = new Set([userSid, "SY", "BA", "S-1-5-18", "S-1-5-32-544"])
  // SDDL writes the built-in Administrator account (RID 500) as LA.
  if (/^S-1-5-21-[0-9-]+-500$/.test(userSid)) allowed.add("LA")
  for (const line of saved.split(/\r?\n/)) {
    const at = line.indexOf("D:")
    if (at < 0) continue
    const dacl = line.slice(at + 2).split(/S:/)[0] ?? ""
    let depth = 0
    let ace = ""
    for (const ch of dacl) {
      if (ch === "(") {
        depth++
        if (depth > 1) return "a conditional entry"
        ace = ""
      } else if (ch === ")") {
        depth--
        const parts = ace.split(";")
        const type = parts[0] ?? ""
        const sid = parts[5] ?? ""
        if (!["A", "D", "OA", "OD"].includes(type)) return `an entry of type ${type}`
        if ((type === "A" || type === "OA") && !allowed.has(sid)) return sid
      } else if (depth === 1) ace += ch
    }
  }
  return null
}
