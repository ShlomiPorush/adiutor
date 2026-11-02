// `connect`: approve an agent in the browser and give it one agent key (Better Auth's device authorization, then its
// api-key plugin). The owner approves at /connect/device; this command then holds a session token for a few
// seconds, creates one key with it and ends that session at once, whatever happens in between. The key goes to the
// sync's env file or is printed once for Claude Code or Codex; it is never logged and never put on a command line.
// The session token is never printed or stored.

import { chmod, type FileHandle, mkdir, open, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, win32 } from "node:path"
import { parseEnvFile } from "./env.ts"
import type { Runner } from "./exec.ts"
import type { FetchLike } from "./http.ts"

/** The one client id Mikud's device plugin accepts; also the User-Agent, so Settings can name the session. */
export const CONNECT_CLIENT_ID = "mikud-connect"
/** The api-key plugin's keyExpiration limits Mikud sets (src/shared/auth.ts). */
export const DAYS_MIN = 1
export const DAYS_MAX = 365
export const NAME_MAX = 32
/** The variable Codex reads the key from (bearer_token_env_var). */
export const CODEX_KEY_VARIABLE = "MIKUD_AGENT_KEY"

export const TARGETS = ["sync", "claude", "codex"] as const
export type Target = (typeof TARGETS)[number]

export type ConnectOptions = {
  /** Mikud's address, without a trailing slash. */
  url: string
  name: string
  days: number
  target: Target
  /** The sync's env file (target sync). */
  envFile: string
  /** Open the approval page in the browser. */
  open: boolean
}

export type ConnectDeps = {
  fetch: FetchLike
  out: (line: string) => void
  runner: Runner
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  sleep: (ms: number) => Promise<void>
  now: () => number
  httpTimeoutMs?: number
}

export const EXIT_CONNECTED = 0
export const EXIT_NOT_CONNECTED = 1

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

/** Where the sync's env file lives by default: outside every repository, in the user's own profile. */
export function defaultEnvFile(platform: NodeJS.Platform, env: Record<string, string | undefined>): string {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || win32.join(env.USERPROFILE || homedir(), "AppData", "Local")
    return win32.join(base, "mikud", "sync.env")
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "mikud", "sync.env")
}

/** ABCDEFGH as ABCD-EFGH, easier to compare with the page. */
export const groupedCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code)

type Answer = { status: number; body: Record<string, unknown> | null }

class ConnectError extends Error {
  override name = "ConnectError"
}

async function call(
  deps: ConnectDeps,
  url: string,
  body: unknown,
  bearer?: string,
): Promise<Answer | { error: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": CONNECT_CLIENT_ID,
  }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  let response: Response
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(deps.httpTimeoutMs ?? 30_000),
    })
  } catch (error) {
    const err = error as Error & { cause?: { code?: string } }
    if (err.name === "TimeoutError") return { error: "no answer in time" }
    return { error: err.cause?.code ? `cannot reach Mikud (${err.cause.code})` : "cannot reach Mikud" }
  }
  const text = await response.text().catch(() => "")
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  const object = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  return { status: response.status, body: object }
}

const str = (value: unknown) => (typeof value === "string" ? value : "")
const num = (value: unknown, fallback: number) => (typeof value === "number" && value > 0 ? value : fallback)

/** A refusal in words: Better Auth's code or the OAuth error, never the body as a whole. */
function reason(answer: Answer | { error: string }): string {
  if ("error" in answer) return answer.error
  const code = str(answer.body?.code) || str(answer.body?.error)
  return code ? `HTTP ${answer.status}, ${code}` : `HTTP ${answer.status}`
}

// --- The env file of the sync ---

/** An env file that only the current user can read, checked before the key is written into it. */
export async function prepareEnvFile(path: string, deps: Pick<ConnectDeps, "platform" | "runner" | "env">) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // Created empty if missing; an existing file keeps its values.
  const handle: FileHandle = await open(path, "a", 0o600)
  await handle.close()
  if (deps.platform === "win32") await restrictOnWindows(path, deps)
  else await restrictOnPosix(path)
}

async function restrictOnPosix(path: string): Promise<void> {
  await chmod(path, 0o600)
  const mode = (await stat(path)).mode & 0o777
  if ((mode & 0o077) !== 0) throw new ConnectError(`the env file is readable by others (mode ${mode.toString(8)})`)
}

/** The current user as icacls names it: DOMAIN\user. */
function windowsUser(env: Record<string, string | undefined>): string {
  const user = env.USERNAME ?? ""
  if (!/^[^"%\r\n\\/:*?<>|]+$/.test(user)) throw new ConnectError("cannot tell the current user (USERNAME)")
  const domain = env.USERDOMAIN ?? ""
  return /^[^"%\r\n\\/:*?<>|]+$/.test(domain) ? `${domain}\\${user}` : user
}

/**
 * icacls: inheritance removed and full control for the current user only, then read back. Anything else in the list
 * (an inherited entry, another account) refuses the file.
 */
async function restrictOnWindows(path: string, deps: Pick<ConnectDeps, "runner" | "env">): Promise<void> {
  const user = windowsUser(deps.env)
  const set = await deps.runner("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], { timeoutMs: 30_000 })
  if (set.code !== 0) throw new ConnectError(`icacls could not restrict the env file (${set.error ?? "failed"})`)
  const read = await deps.runner("icacls", [path], { timeoutMs: 30_000 })
  if (read.code !== 0) throw new ConnectError(`icacls could not read the env file's access (${read.error ?? "failed"})`)
  const entries = aclEntries(read.stdout, path)
  const only = entries.length === 1 ? entries[0] : undefined
  const ok =
    only !== undefined &&
    !only.includes("(I)") &&
    only.toLowerCase().startsWith(`${user.toLowerCase()}:`) &&
    only.includes("(F)")
  if (!ok) throw new ConnectError("the env file is not restricted to the current user; check it with icacls")
}

/** The access entries icacls prints for one file: the first line after the path, then the indented lines. */
export function aclEntries(output: string, path: string): string[] {
  const lines = output.split(/\r?\n/)
  const entries: string[] = []
  for (const [index, raw] of lines.entries()) {
    if (index === 0) {
      const first = raw.startsWith(path) ? raw.slice(path.length) : raw
      if (first.trim()) entries.push(first.trim())
      continue
    }
    if (!raw.trim()) break
    entries.push(raw.trim())
  }
  return entries
}

/** The file's lines with MIKUD_URL and MIKUD_AGENT_TOKEN set; every other line stays as it was. */
export function withSyncKey(text: string, url: string, key: string): string {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/)
  while (lines.length > 0 && lines.at(-1) === "") lines.pop()
  const set = (name: string, value: string) => {
    const pattern = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`)
    const index = lines.findIndex((line) => pattern.test(line))
    if (index === -1) lines.push(`${name}=${value}`)
    else lines[index] = `${name}=${value}`
  }
  set("MIKUD_URL", url)
  set("MIKUD_AGENT_TOKEN", key)
  return `${lines.join("\n")}\n`
}

async function saveSyncKey(path: string, url: string, key: string): Promise<void> {
  const before = await readFile(path, "utf8")
  // Checks the file still parses, so a broken file is reported before it is changed.
  parseEnvFile(before)
  // Written in place: the restricted access list of the file stays.
  const handle = await open(path, "r+")
  try {
    await handle.truncate(0)
    await handle.write(withSyncKey(before, url, key), 0, "utf8")
  } finally {
    await handle.close()
  }
}

// --- What the clients get ---

export function claudeCommand(url: string, key: string): string {
  return `claude mcp add --transport http --scope user mikud ${url}/mcp --header "Authorization: Bearer ${key}"`
}

export function codexLines(url: string, key: string, platform: NodeJS.Platform): string[] {
  return [
    "Add this to ~/.codex/config.toml:",
    "",
    "[mcp_servers.mikud]",
    `url = "${url}/mcp"`,
    `bearer_token_env_var = "${CODEX_KEY_VARIABLE}"`,
    "",
    platform === "win32"
      ? "Then set the variable for your Windows user, and open a new terminal before you start Codex:"
      : "Then set the variable in your shell profile, and open a new terminal before you start Codex:",
    "",
    platform === "win32" ? `setx ${CODEX_KEY_VARIABLE} "${key}"` : `export ${CODEX_KEY_VARIABLE}="${key}"`,
  ]
}

// --- The browser ---

/** Opens the approval page with the system's own opener, without a shell. A failure only means: open it yourself. */
async function openBrowser(link: string, deps: Pick<ConnectDeps, "runner" | "platform">): Promise<boolean> {
  const [command, args] =
    deps.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", link]]
      : deps.platform === "darwin"
        ? ["open", [link]]
        : ["xdg-open", [link]]
  const result = await deps.runner(command as string, args as string[], { timeoutMs: 15_000 })
  return result.code === 0
}

// --- The flow ---

/**
 * One connection: device code, approval in the browser, the session token, one key, then the session ends.
 * Returns the exit code.
 */
export async function connect(options: ConnectOptions, deps: ConnectDeps): Promise<number> {
  const say = deps.out
  const auth = `${options.url}/api/auth`

  if (options.target === "sync") {
    try {
      await prepareEnvFile(options.envFile, deps)
    } catch (error) {
      say(`connect: cannot prepare the env file ${options.envFile}: ${messageOf(error)}`)
      return EXIT_NOT_CONNECTED
    }
  }

  const code = await call(deps, `${auth}/device/code`, { client_id: CONNECT_CLIENT_ID })
  if ("error" in code || code.status !== 200 || !code.body) {
    say(`connect: Mikud did not start the approval: ${reason(code)}`)
    return EXIT_NOT_CONNECTED
  }
  const deviceCode = str(code.body.device_code)
  const userCode = str(code.body.user_code)
  const link = str(code.body.verification_uri_complete)
  const linkUrl = URL.canParse(link) ? new URL(link) : null
  if (!deviceCode || !userCode || !linkUrl || linkUrl.origin !== new URL(options.url).origin) {
    say("connect: Mikud's answer to the approval request is not usable")
    return EXIT_NOT_CONNECTED
  }
  const expiresAt = deps.now() + num(code.body.expires_in, 600) * 1000
  let interval = num(code.body.interval, 5) * 1000

  say(`Approve this agent in Mikud: ${link}`)
  say(`Check that the page shows the code ${groupedCode(userCode)}, then choose Allow.`)
  if (options.open && !(await openBrowser(link, deps))) say("Could not open the browser; open the link yourself.")
  say("Waiting for the approval...")

  let token = ""
  while (!token) {
    await deps.sleep(interval)
    if (deps.now() >= expiresAt) {
      say("connect: the code expired before it was approved. Run the command again.")
      return EXIT_NOT_CONNECTED
    }
    const answer = await call(deps, `${auth}/device/token`, {
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
      client_id: CONNECT_CLIENT_ID,
    })
    if ("error" in answer) continue
    if (answer.status === 200 && str(answer.body?.access_token)) {
      token = str(answer.body?.access_token)
      break
    }
    const error = str(answer.body?.error)
    if (error === "authorization_pending") continue
    if (error === "slow_down") {
      // RFC 8628: wait 5 seconds longer from now on.
      interval += 5000
      continue
    }
    if (error === "access_denied") {
      say("connect: the request was denied in the browser. Nothing was created.")
      return EXIT_NOT_CONNECTED
    }
    if (error === "expired_token") {
      say("connect: the code expired before it was approved. Run the command again.")
      return EXIT_NOT_CONNECTED
    }
    say(`connect: Mikud refused the approval: ${reason(answer)}`)
    return EXIT_NOT_CONNECTED
  }

  let exit = EXIT_NOT_CONNECTED
  try {
    exit = await createAndDeliver(options, deps, auth, token)
  } finally {
    const ended = await call(deps, `${auth}/revoke-session`, { token }, token)
    if ("error" in ended || ended.status !== 200 || ended.body?.status !== true)
      say(
        `connect: could not confirm that the approval's temporary session ended (${reason(ended)}). End the session ` +
          `"mikud connect (agent approval)" in Mikud, Settings, Account.`,
      )
  }
  return exit
}

async function createAndDeliver(
  options: ConnectOptions,
  deps: ConnectDeps,
  auth: string,
  token: string,
): Promise<number> {
  const say = deps.out
  const created = await call(
    deps,
    `${auth}/api-key/create`,
    { name: options.name, expiresIn: options.days * 86_400 },
    token,
  )
  const key = "error" in created ? "" : str(created.body?.key)
  if ("error" in created || created.status !== 200 || !key) {
    say(`connect: Mikud did not create the key: ${reason(created)}`)
    return EXIT_NOT_CONNECTED
  }
  const until = "error" in created ? "" : str(created.body?.expiresAt).slice(0, 10)
  const ends = until ? ` It works until ${until}.` : ""

  if (options.target === "sync") {
    try {
      await saveSyncKey(options.envFile, options.url, key)
    } catch (error) {
      say(
        `connect: the key "${options.name}" was created but could not be saved (${messageOf(error)}). ` +
          "Disconnect it in Mikud, Settings, Agent access, and run the command again.",
      )
      return EXIT_NOT_CONNECTED
    }
    say(`Connected "${options.name}". The sync's key is in ${options.envFile}, readable by you only.${ends}`)
    return EXIT_CONNECTED
  }

  say(`Connected "${options.name}".${ends} Mikud shows the key only now.`)
  say("")
  if (options.target === "claude") {
    say("Run this once to add Mikud to Claude Code:")
    say("")
    say(claudeCommand(options.url, key))
    say("")
    say("Claude Code keeps the key in its own configuration (~/.claude.json).")
  } else {
    for (const line of codexLines(options.url, key, deps.platform)) say(line)
    say("")
  }
  say("A command you paste can stay in your shell history; clear that entry if others can read it.")
  return EXIT_CONNECTED
}

function messageOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  if (code) return code
  return error instanceof ConnectError ? error.message : "unexpected error"
}
