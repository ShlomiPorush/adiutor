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
