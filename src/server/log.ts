// One JSON line per entry on stdout or stderr. Never pass tokens, cookies or message text.
type Fields = Record<string, unknown>

function write(level: "info" | "warn" | "error", msg: string, fields?: Fields) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })
  if (level === "info") console.log(line)
  else console.error(line)
}

export const log = {
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,59}$/
const SQLSTATE = /^[0-9A-Z]{5}$/

/**
 * What may be logged about an unexpected error: its class name, the PostgreSQL SQLSTATE found in its
 * cause chain and our error code. Never its message: a failed query's message holds the query and its
 * parameters (owner text, possibly secrets).
 */
export function errorFacts(error: unknown): { errorClass: string; sqlstate?: string; code?: string } {
  const name = error instanceof Error ? error.constructor.name || error.name : typeof error
  const facts: { errorClass: string; sqlstate?: string; code?: string } = {
    errorClass: SAFE_NAME.test(name) ? name : "unknown",
  }
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === "string" && SQLSTATE.test(code)) {
      facts.sqlstate = code
      break
    }
    e = (e as { cause?: unknown }).cause
  }
  const ownCode = (error as { code?: unknown } | null)?.code
  if (error instanceof Error && error.name === "AppError" && typeof ownCode === "string") facts.code = ownCode
  return facts
}
