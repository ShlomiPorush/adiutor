// The sync's env file (KEY=VALUE lines), one of the places its settings come from (src/sync/settings.ts), and the
// redaction of secrets in output. Error messages never include a value.

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

/** Replaces every occurrence of the given secrets in a line of output. */
export function redactor(secrets: Array<string | undefined>): (line: string) => string {
  const values = secrets.filter((s): s is string => typeof s === "string" && s.length >= 8)
  return (line) => values.reduce((text, secret) => text.split(secret).join("[redacted]"), line)
}
