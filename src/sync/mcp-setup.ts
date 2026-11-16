// `setup-mcp`: sets up Claude Code or Codex to use Adiutor's MCP server with OAuth, and moves a setup that the old
// `connect --for claude|codex` wrote (a static agent key) to it. It runs only the clients' own documented commands
// (`claude mcp ...`, `codex mcp ...`), never edits their configuration files, and touches only the `adiutor` entry
// of Claude Code's user scope and Codex's global `adiutor` entry. Each client then signs in through its own OAuth flow,
// which the owner approves in Adiutor; no key or token passes through this command.

import { readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ConnectDeps } from "./connect.ts"
import { parseEnvFile } from "./env.ts"
import { lastLine, type RunResult } from "./exec.ts"

export const MCP_TARGETS = ["claude", "codex"] as const
export type McpTarget = (typeof MCP_TARGETS)[number]

/** The MCP server's name in both clients. */
export const SERVER_NAME = "adiutor"
/** The variable the old `connect --for codex` kept the key in (bearer_token_env_var). */
export const CODEX_KEY_VARIABLE = "ADIUTOR_AGENT_KEY"
/** A client command that changes nothing waits this long; one that runs a browser sign-in, longer. */
const CLIENT_TIMEOUT_MS = 120_000
const LOGIN_TIMEOUT_MS = 15 * 60_000

export type McpSetupDeps = Pick<ConnectDeps, "out" | "runner" | "findCommand" | "systemCommand" | "platform" | "env">

/** Where the old `connect --for codex` kept the key outside Windows: next to the sync's env file. */
export function codexEnvFile(env: Record<string, string | undefined>): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "adiutor", "codex.env")
}

export const claudeAddArgs = (issuer: string) => [
  "mcp",
  "add",
  "--transport",
  "http",
  "--scope",
  "user",
  SERVER_NAME,
  `${issuer}/mcp`,
]
export const CLAUDE_REMOVE_ARGS = ["mcp", "remove", SERVER_NAME, "--scope", "user"]
export const CLAUDE_GET_ARGS = ["mcp", "get", SERVER_NAME]
/** Claude Code's answer when the user scope has no such entry (2.1.325): nothing to remove. */
export const CLAUDE_NOT_IN_USER = new RegExp(`^No MCP server named "?${SERVER_NAME}"? in user scope`, "m")
/** The scope `claude mcp get` names for the entry that applies in this folder (local, then user, then project). */
const CLAUDE_SCOPE = /^\s*Scope:\s*(User|Local|Project) config\b/m

export const codexAddArgs = (issuer: string) => ["mcp", "add", SERVER_NAME, "--url", `${issuer}/mcp`]
export const CODEX_REMOVE_ARGS = ["mcp", "remove", SERVER_NAME]
export const CODEX_LOGIN_ARGS = ["mcp", "login", SERVER_NAME]
export const CODEX_LIST_ARGS = ["mcp", "list", "--json"]

/** A printed command: the address in double quotes, so no shell reads its brackets or colons as anything else. */
const shown = (command: string, args: string[]) =>
  [command, ...args.map((a) => (/^[A-Za-z0-9._:/=-]+$/.test(a) && !a.includes("://") ? a : `"${a}"`))].join(" ")

const why = (result: RunResult) => {
  const detail = lastLine(result.stderr || result.stdout)
  return detail ? `${result.error ?? "failed"}: ${detail}` : (result.error ?? "failed")
}

/** Sets up one client. Returns the exit code: 0 when it is set up (or was already), 1 when something is left to do. */
export async function setupMcp(issuer: string, target: McpTarget, deps: McpSetupDeps): Promise<number> {
  const exit = target === "claude" ? await setupClaude(issuer, deps) : await setupCodex(issuer, deps)
  // The client's own status is not proof that Adiutor still accepts the connection: Adiutor's list is.
  deps.out(
    "Adiutor lists every connection with its last use in Settings, Agent access; a connection it no longer accepts is missing there.",
  )
  return exit
}

// --- Claude Code ---

async function setupClaude(issuer: string, deps: McpSetupDeps): Promise<number> {
  const say = deps.out
  const add = shown("claude", claudeAddArgs(issuer))
  const claude = await deps.findCommand("claude")
  if (!claude) {
    say("Claude Code (claude) was not found. Add Adiutor to it yourself:")
    say(`  ${add}`)
    return 1
  }
  const run = (args: string[]) => deps.runner(claude, args, { timeoutMs: CLIENT_TIMEOUT_MS })

  // Which entry applies in this folder: a local or project one is reported, never changed.
  const got = await run(CLAUDE_GET_ARGS)
  const scope = got.code === 0 ? CLAUDE_SCOPE.exec(got.stdout)?.[1] : undefined
  if (scope === "Local" || scope === "Project")
    say(
      `Claude Code has an ${SERVER_NAME} entry of ${scope.toLowerCase()} scope in this folder; it is left as it is${scope === "Local" ? " and is used here instead of the user entry" : ""}. Remove it in Claude Code if it is an old one.`,
    )

  const removed = await run(CLAUDE_REMOVE_ARGS)
  const absent = removed.code !== 0 && CLAUDE_NOT_IN_USER.test(`${removed.stdout}\n${removed.stderr}`)
  if (removed.code !== 0 && !absent) {
    say(
      `Could not remove Claude Code's ${SERVER_NAME} entry of user scope (claude mcp remove ${why(removed)}); nothing was changed.`,
    )
    say("Run these yourself:")
    say(`  ${shown("claude", CLAUDE_REMOVE_ARGS)}`)
    say(`  ${add}`)
    return 1
  }
  const added = await run(claudeAddArgs(issuer))
  if (added.code !== 0) {
    say(`Could not add Adiutor to Claude Code (claude mcp add ${why(added)}).`)
    say("Adiutor is not set up in Claude Code until this runs:")
    say(`  ${add}`)
    return 1
  }
  say(
    removed.code === 0
      ? `Replaced Claude Code's ${SERVER_NAME} entry (user scope): it now uses ${issuer}/mcp with OAuth, no key.`
      : `Added ${SERVER_NAME} to Claude Code (user scope): ${issuer}/mcp with OAuth.`,
  )
  say("Claude Code signs in the first time it uses Adiutor (or run /mcp in Claude Code); approve it in Adiutor then.")
  return 0
}

// --- Codex ---

type CodexEntry = {
  name?: unknown
  transport?: {
    type?: unknown
    url?: unknown
    bearer_token_env_var?: unknown
    http_headers?: unknown
    env_http_headers?: unknown
  }
  auth_status?: unknown
}

/** `codex mcp list --json` as an array of entries, or null when it failed or is not that. */
async function codexList(codex: string, deps: McpSetupDeps): Promise<CodexEntry[] | null> {
  const listed = await deps.runner(codex, CODEX_LIST_ARGS, { timeoutMs: CLIENT_TIMEOUT_MS })
  if (listed.code !== 0) return null
  try {
    const parsed = JSON.parse(listed.stdout) as unknown
    return Array.isArray(parsed) && parsed.every((e) => e !== null && typeof e === "object") ? parsed : null
  } catch {
    return null
  }
}

/** Whether a header map names an Authorization header (the old setup's bearer source, another way). */
const hasAuthorization = (headers: unknown) =>
  headers !== null &&
  typeof headers === "object" &&
  Object.keys(headers as object).some((k) => k.toLowerCase() === "authorization")

/** Whether an entry still reads the old key's variable. */
const usesKeyVariable = (e: CodexEntry) =>
  e.transport?.bearer_token_env_var === CODEX_KEY_VARIABLE ||
  (e.transport?.env_http_headers !== null &&
    typeof e.transport?.env_http_headers === "object" &&
    Object.values(e.transport.env_http_headers as object).includes(CODEX_KEY_VARIABLE))

async function setupCodex(issuer: string, deps: McpSetupDeps): Promise<number> {
  const say = deps.out
  const url = `${issuer}/mcp`
  const byHand = () => {
    say("Run these yourself, once you checked the entry:")
    say(`  ${shown("codex", CODEX_REMOVE_ARGS)}`)
    say(`  ${shown("codex", codexAddArgs(issuer))}`)
  }
  const codex = await deps.findCommand("codex")
  if (!codex) {
    say("Codex (codex) was not found. Add Adiutor to it yourself:")
    say(`  ${shown("codex", codexAddArgs(issuer))}`)
    return 1
  }
  const run = (args: string[], timeoutMs = CLIENT_TIMEOUT_MS) => deps.runner(codex, args, { timeoutMs })

  const entries = await codexList(codex, deps)
  if (!entries) {
    // An unknown or unreadable state is never read as "not logged in".
    say("Could not read Codex's MCP servers (codex mcp list --json); nothing was changed.")
    byHand()
    return 1
  }
  const entry = entries.find((e) => e.name === SERVER_NAME)
  const transport = entry?.transport
  const http = transport?.type === "streamable_http"
  const bearer =
    typeof transport?.bearer_token_env_var === "string" ||
    hasAuthorization(transport?.http_headers) ||
    hasAuthorization(transport?.env_http_headers)
  let exit = 0

  if (entry && http && transport?.url !== url) {
    say(`Codex's ${SERVER_NAME} entry points to ${String(transport?.url)}, not ${url}; nothing was changed.`)
    byHand()
    exit = 1
  } else if (!entry || bearer || !http) {
    // No entry, or the old command's entry (a bearer source, or another transport): replaced by one with OAuth. Codex's
    // add starts its sign-in by itself when the server offers OAuth: one approval.
    if (entry) {
      const removed = await run(CODEX_REMOVE_ARGS)
      if (removed.code !== 0) {
        say(
          `Could not remove Codex's old ${SERVER_NAME} entry (codex mcp remove ${why(removed)}); nothing was changed.`,
        )
        byHand()
        return 1
      }
    }
    say(`Adding ${SERVER_NAME} to Codex: ${url}. Codex opens the browser to sign in; approve it in Adiutor.`)
    const added = await run(codexAddArgs(issuer), LOGIN_TIMEOUT_MS)
    if (added.code !== 0) {
      say(`Codex could not add Adiutor (codex mcp add ${why(added)}).`)
      say("Adiutor is not set up in Codex until this runs:")
      say(`  ${shown("codex", codexAddArgs(issuer))}`)
      exit = 1
    } else
      say(
        entry
          ? `Replaced Codex's old ${SERVER_NAME} entry: it now uses ${url} with OAuth, no key.`
          : `Added ${SERVER_NAME} to Codex: ${url} with OAuth.`,
      )
  } else if (entry.auth_status === "o_auth") {
    say(`Codex's ${SERVER_NAME} entry already uses ${url} and is signed in with OAuth; nothing was changed.`)
  } else if (entry.auth_status === "not_logged_in") {
    // Saved earlier, but its sign-in was cancelled or failed: one sign-in.
    say(`Codex's ${SERVER_NAME} entry is not signed in. Codex opens the browser to sign in; approve it in Adiutor.`)
    const login = await run(CODEX_LOGIN_ARGS, LOGIN_TIMEOUT_MS)
    if (login.code !== 0) {
      say(`Codex did not sign in (codex mcp login ${why(login)}). Run it again yourself:`)
      say(`  ${shown("codex", CODEX_LOGIN_ARGS)}`)
      exit = 1
    } else say(`Codex's ${SERVER_NAME} entry is signed in with OAuth.`)
  } else {
    say(
      `Codex reports the sign-in of its ${SERVER_NAME} entry as ${JSON.stringify(entry.auth_status ?? null)}; nothing was changed. If Adiutor is reachable and the entry is not signed in, run:`,
    )
    say(`  ${shown("codex", CODEX_LOGIN_ARGS)}`)
    exit = 1
  }

  await removeKeyVariable(codex, deps)
  return exit
}

/**
 * ADIUTOR_AGENT_KEY, which the old setup kept the key in, is removed only once Codex's list shows that no entry reads
 * it any longer: on Windows only that value of the user's environment (reg.exe from System32); elsewhere the env file
 * the old command wrote, only while it holds that variable alone.
 */
async function removeKeyVariable(codex: string, deps: McpSetupDeps): Promise<void> {
  const say = deps.out
  const entries = await codexList(codex, deps)
  if (!entries) {
    say(`${CODEX_KEY_VARIABLE} was kept: Codex's list could not be read to check that no entry reads it.`)
    return
  }
  const readers = entries.filter(usesKeyVariable).map((e) => String(e.name))
  if (deps.platform === "win32") {
    const reg = await deps.systemCommand("reg")
    if (!reg) {
      say(`reg.exe was not found in %SystemRoot%\\System32, so ${CODEX_KEY_VARIABLE} was not checked.`)
      return
    }
    const query = await deps.runner(reg, ["query", "HKCU\\Environment", "/v", CODEX_KEY_VARIABLE], {
      timeoutMs: 30_000,
    })
    if (query.code !== 0) return
    if (readers.length) {
      say(`${CODEX_KEY_VARIABLE} was kept: Codex's ${readers.join(", ")} entry still reads it.`)
      return
    }
    const removed = await deps.runner(reg, ["delete", "HKCU\\Environment", "/v", CODEX_KEY_VARIABLE, "/f"], {
      timeoutMs: 30_000,
    })
    if (removed.code === 0)
      say(
        `Removed ${CODEX_KEY_VARIABLE}, the old key's variable, from your Windows user. New terminals no longer see it.`,
      )
    else say(`Could not remove ${CODEX_KEY_VARIABLE} from your Windows user (reg delete ${why(removed)}).`)
    return
  }
  const file = codexEnvFile(deps.env)
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch {
    return
  }
  if (readers.length) {
    say(`${file} was kept: Codex's ${readers.join(", ")} entry still reads ${CODEX_KEY_VARIABLE}.`)
    return
  }
  let names: string[]
  try {
    names = Object.keys(parseEnvFile(text))
  } catch {
    names = []
  }
  if (names.length !== 1 || names[0] !== CODEX_KEY_VARIABLE) {
    say(`${file} holds more than ${CODEX_KEY_VARIABLE}, so it was kept. Remove that line yourself.`)
    return
  }
  await rm(file, { force: true })
  say(`Removed ${file}, which held the old key. Remove the line . "${file}" from your shell profile.`)
}
