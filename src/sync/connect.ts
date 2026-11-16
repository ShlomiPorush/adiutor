// `connect`: connects the sync to Adiutor by agent approval (the OAuth device grant, src/sync/oauth.ts). The owner
// approves the code in the browser and grants the `sync` area; the connection is kept in the sync's own owner-only
// folder, never printed, and the sync's env file gets Adiutor's address. Claude Code and Codex connect to Adiutor's MCP
// server themselves, through OAuth: `setup-mcp` (src/sync/mcp-setup.ts) sets them up.

import { chmod, type FileHandle, mkdir, open, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, win32 } from "node:path"
import { parseEnvFile } from "./env.ts"
import type { Runner } from "./exec.ts"
import type { FetchLike } from "./http.ts"
import { ClientError, syncClient } from "./oauth.ts"

/** The connection's name on the approval page and in Settings, Agent access (client_label; Adiutor allows 60). */
export const NAME_MAX = 60

export type ConnectOptions = {
  /** Adiutor's address (an issuer: a plain origin). */
  url: string
  name: string
  /** The sync's env file, which gets ADIUTOR_URL. */
  envFile: string
  /** Open the approval page in the browser. */
  open: boolean
  /** Ask for a new connection even while one is kept; the old one is ended once the new one is stored. */
  replace: boolean
}

export type ConnectDeps = {
  fetch: FetchLike
  out: (line: string) => void
  runner: Runner
  /** The full path of a client's command (claude, codex), or undefined when it is not installed. */
  findCommand: (name: string) => Promise<string | undefined>
  /** The full path of a Windows component in System32 (icacls, rundll32, whoami, reg), or undefined. */
  systemCommand: (name: string) => Promise<string | undefined>
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  sleep: (ms: number) => Promise<void>
  now: () => number
  httpTimeoutMs?: number
}

export const EXIT_CONNECTED = 0
export const EXIT_NOT_CONNECTED = 1

/** Where the sync's env file lives by default: outside every repository, in the user's own profile. */
export function defaultEnvFile(platform: NodeJS.Platform, env: Record<string, string | undefined>): string {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || win32.join(env.USERPROFILE || homedir(), "AppData", "Local")
    return win32.join(base, "adiutor", "sync.env")
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "adiutor", "sync.env")
}

/** ABCDEFGH as ABCD-EFGH, easier to compare with the page. */
export const groupedCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code)

class ConnectError extends Error {
  override name = "ConnectError"
}

// --- The env file of the sync ---

/** An env file that only the current user can read, checked before it is written. */
export async function prepareEnvFile(
  path: string,
  deps: Pick<ConnectDeps, "platform" | "runner" | "env" | "systemCommand">,
) {
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
async function restrictOnWindows(
  path: string,
  deps: Pick<ConnectDeps, "runner" | "env" | "systemCommand">,
): Promise<void> {
  const user = windowsUser(deps.env)
  const icacls = await deps.systemCommand("icacls")
  if (!icacls) throw new ConnectError("icacls was not found in %SystemRoot%\\System32")
  const set = await deps.runner(icacls, [path, "/inheritance:r", "/grant:r", `${user}:F`], { timeoutMs: 30_000 })
  if (set.code !== 0) throw new ConnectError(`icacls could not restrict the env file (${set.error ?? "failed"})`)
  const read = await deps.runner(icacls, [path], { timeoutMs: 30_000 })
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

/**
 * The file's lines with exactly one ADIUTOR_URL, in the place of its first definition (parseEnvFile keeps the last
 * one, so a leftover duplicate would win); every other line stays as it was, an old ADIUTOR_AGENT_TOKEN included (the
 * sync reports it, and the owner deletes it).
 */
export function withSyncUrl(text: string, url: string): string {
  let lines = text.replace(/^﻿/, "").split(/\r?\n/)
  while (lines.length > 0 && lines.at(-1) === "") lines.pop()
  // A line break would add lines of its own to the file.
  if (/[\r\n]/.test(url)) throw new ConnectError("ADIUTOR_URL holds a line break")
  const pattern = /^\s*(export\s+)?ADIUTOR_URL\s*=/
  const first = lines.findIndex((line) => pattern.test(line))
  if (first === -1) lines.push(`ADIUTOR_URL=${url}`)
  else
    lines = lines.flatMap((line, index) =>
      index === first ? [`ADIUTOR_URL=${url}`] : pattern.test(line) ? [] : [line],
    )
  return `${lines.join("\n")}\n`
}

async function saveSyncUrl(path: string, url: string): Promise<void> {
  const before = await readFile(path, "utf8")
  // Checks the file still parses, so a broken file is reported before it is changed.
  parseEnvFile(before)
  const after = withSyncUrl(before, url)
  if (after === before) return
  // Written in place: the restricted access list of the file stays.
  const handle = await open(path, "r+")
  try {
    await handle.truncate(0)
    await handle.write(after, 0, "utf8")
  } finally {
    await handle.close()
  }
}

// --- The browser ---

/** Opens the approval page with the system's own opener, without a shell. A failure only means: open it yourself. */
async function openBrowser(
  link: string,
  deps: Pick<ConnectDeps, "runner" | "platform" | "systemCommand">,
): Promise<boolean> {
  let command = deps.platform === "darwin" ? "open" : "xdg-open"
  let args = [link]
  if (deps.platform === "win32") {
    const rundll32 = await deps.systemCommand("rundll32")
    if (!rundll32) return false
    command = rundll32
    args = ["url.dll,FileProtocolHandler", link]
  }
  const result = await deps.runner(command, args, { timeoutMs: 15_000 })
  return result.code === 0
}

// --- The flow ---

/** One connection: the env file checked, the device code, the approval in the browser, the connection kept. */
export async function connect(options: ConnectOptions, deps: ConnectDeps): Promise<number> {
  const say = deps.out
  try {
    await prepareEnvFile(options.envFile, deps)
  } catch (error) {
    say(`connect: cannot prepare the env file ${options.envFile}: ${messageOf(error)}`)
    return EXIT_NOT_CONNECTED
  }
  try {
    const client = syncClient(options.url, { ...deps, now: deps.now })
    await client.prepare()
    const kept = await client.status()
    if (kept.connected && !options.replace) {
      await saveSyncUrl(options.envFile, options.url)
      say(`The sync is connected to ${options.url} already, as "${kept.label}" (${kept.scope}).`)
      say("To connect it again, for example after you disconnected it in Settings, Agent access, add --replace.")
      return EXIT_CONNECTED
    }
    const device = await client.deviceCode(options.name)
    say(`Approve the sync in Adiutor: ${device.link}`)
    say(`Check that the page shows the code ${groupedCode(device.userCode)}, keep the sync area ticked, then approve.`)
    if (options.open && !(await openBrowser(device.link, deps)))
      say("Could not open the browser; open the link yourself.")
    say("Waiting for the approval...")
    const done = await client.waitForApproval(device, options.name)
    await saveSyncUrl(options.envFile, options.url)
    say(`Connected "${options.name}" (${done.scope}). The connection is kept in ${client.dir}, readable by you only.`)
    if (done.notRevoked)
      say(
        "The connection it replaced could not be ended yet; it is ended on the next run, or disconnect it in Settings, Agent access.",
      )
    if (!done.scope.split(" ").includes("sync"))
      say("The sync area was not approved, so the sync cannot push. Connect again with --replace and keep it ticked.")
    return EXIT_CONNECTED
  } catch (error) {
    say(`connect: ${messageOf(error)}`)
    return EXIT_NOT_CONNECTED
  }
}

function messageOf(error: unknown): string {
  if (error instanceof ClientError || error instanceof ConnectError) return error.message
  const code = (error as NodeJS.ErrnoException).code
  return code ?? "unexpected error"
}
