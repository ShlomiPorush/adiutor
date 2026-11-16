// Configuration of the sync tool: the process environment, optionally completed by a local env file
// (KEY=VALUE lines) so a scheduled task needs no system environment variables. Error messages never
// include a value.

import { issuerOf } from "./oauth.ts"

export class SyncConfigError extends Error {
  override name = "SyncConfigError"
}

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
  /** Adiutor's address as an issuer (a plain origin): the connection `connect` kept for it is used. */
  url?: string
  /** Path of the T3 Code CLI; on Windows usually a .cmd file. */
  cliPath?: string
  /** The owner's overview checkout. */
  overviewDir?: string
  /**
   * Whether ADIUTOR_AGENT_TOKEN, the sync's agent key before agent approval, is still set: the sync no longer uses it,
   * says so once per run, and never prints or passes it on.
   */
  oldToken: boolean
}

const NAMES = ["ADIUTOR_URL", "ADIUTOR_AGENT_TOKEN", "T3CODE_CLI_PATH", "ADIUTOR_OVERVIEW_DIR"] as const

/**
 * Merges the environment with the env file (the file wins: it is the explicit choice of the caller)
 * and checks the values. The server URL is required only when something is sent.
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
  let url = pick("ADIUTOR_URL")
  if (url !== undefined) {
    try {
      url = issuerOf(url)
    } catch {
      problems.push("ADIUTOR_URL must be Adiutor's address alone: https, or http on localhost")
    }
  } else if (options.requireServer) problems.push("ADIUTOR_URL is required")

  if (problems.length > 0) throw new SyncConfigError(`Invalid configuration: ${problems.join("; ")}`)
  return {
    url,
    cliPath: pick("T3CODE_CLI_PATH"),
    overviewDir: pick("ADIUTOR_OVERVIEW_DIR"),
    oldToken: pick("ADIUTOR_AGENT_TOKEN") !== undefined,
  }
}

/** Replaces every occurrence of the given secrets in a line of output. */
export function redactor(secrets: Array<string | undefined>): (line: string) => string {
  const values = secrets.filter((s): s is string => typeof s === "string" && s.length >= 8)
  return (line) => values.reduce((text, secret) => text.split(secret).join("[redacted]"), line)
}
