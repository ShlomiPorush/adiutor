// Configuration of the sync tool: the process environment, optionally completed by a local env file
// (KEY=VALUE lines) so a scheduled task needs no system environment variables. Error messages never
// include a value.

export class SyncConfigError extends Error {
  override name = "SyncConfigError"
}

export const MIN_TOKEN_LENGTH = 32

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Reads KEY=VALUE lines. Blank lines and lines starting with # are skipped; an optional `export `
 * prefix and one pair of matching surrounding quotes are removed. A bad line is reported by number
 * only, since it may hold a secret.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {}
  const lines = text.replace(/^﻿/, "").split(/\r?\n/)
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) return
    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line
    const eq = body.indexOf("=")
    const key = eq > 0 ? body.slice(0, eq).trim() : ""
    if (!KEY.test(key)) throw new SyncConfigError(`env file line ${index + 1} is not KEY=VALUE`)
    let value = body.slice(eq + 1).trim()
    const quote = value[0]
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1)
    vars[key] = value
  })
  return vars
}

export type SyncConfig = {
  /** Base URL of the Mikud server, without a trailing slash. */
  url?: string
  /** The agent token. Never printed, logged or passed to a child process. */
  token?: string
  /** Path of the T3 Code CLI; on Windows usually a .cmd file. */
  cliPath?: string
  /** The owner's overview checkout. */
  overviewDir?: string
}

const NAMES = ["MIKUD_URL", "MIKUD_AGENT_TOKEN", "T3CODE_CLI_PATH", "MIKUD_OVERVIEW_DIR"] as const

/**
 * Merges the environment with the env file (the file wins: it is the explicit choice of the caller)
 * and checks the values. The server URL and the token are required only when something is sent.
 */
export function loadSyncConfig(
  env: Record<string, string | undefined>,
  fileVars: Record<string, string>,
  options: { requireServer: boolean },
): SyncConfig {
  const pick = (name: (typeof NAMES)[number]) => {
    const value = (fileVars[name] ?? env[name] ?? "").trim()
    return value === "" ? undefined : value
  }
  const problems: string[] = []
  const url = pick("MIKUD_URL")
  const token = pick("MIKUD_AGENT_TOKEN")

  if (url !== undefined) {
    const parsed = URL.canParse(url) ? new URL(url) : undefined
    if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:"))
      problems.push("MIKUD_URL must be an http or https URL")
    else if (parsed.username || parsed.password || parsed.search || parsed.hash)
      problems.push("MIKUD_URL must not contain credentials, a query or a fragment")
  } else if (options.requireServer) problems.push("MIKUD_URL is required")

  if (token !== undefined) {
    if (token.length < MIN_TOKEN_LENGTH)
      problems.push(`MIKUD_AGENT_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`)
  } else if (options.requireServer) problems.push("MIKUD_AGENT_TOKEN is required")

  if (problems.length > 0) throw new SyncConfigError(`Invalid configuration: ${problems.join("; ")}`)
  return {
    url: url?.replace(/\/+$/, ""),
    token,
    cliPath: pick("T3CODE_CLI_PATH"),
    overviewDir: pick("MIKUD_OVERVIEW_DIR"),
  }
}

/** Replaces every occurrence of the given secrets in a line of output. */
export function redactor(secrets: Array<string | undefined>): (line: string) => string {
  const values = secrets.filter((s): s is string => typeof s === "string" && s.length >= 8)
  return (line) => values.reduce((text, secret) => text.split(secret).join("[redacted]"), line)
}
