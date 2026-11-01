/** The owner's time zone. The morning schedule and every time in a message use it. */
export const TIME_ZONE = "Asia/Jerusalem"

export type LocalTime = {
  /** YYYY-MM-DD in the time zone. */
  date: string
  year: number
  month: number
  day: number
  hour: number
  minute: number
  /** 0 is Sunday, 6 is Saturday. */
  weekday: number
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
})

/** The wall-clock time in Asia/Jerusalem, daylight saving time included. */
export function localTime(at: Date): LocalTime {
  const parts = Object.fromEntries(partsFormat.formatToParts(at).map((p) => [p.type, p.value]))
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ""),
  }
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0")

/**
 * A time as numbers in Asia/Jerusalem, by the owner's date and time formats (settings). Tokens: yyyy, yy,
 * MM, M, dd, d, HH, H, mm; anything else is kept as written. Never a month name.
 */
export function formatLocal(at: Date, dateFormat: string, timeFormat: string): string {
  const t = localTime(at)
  const tokens: Record<string, string> = {
    yyyy: String(t.year),
    yy: pad(t.year % 100),
    MM: pad(t.month),
    M: String(t.month),
    dd: pad(t.day),
    d: String(t.day),
    HH: pad(t.hour),
    H: String(t.hour),
    mm: pad(t.minute),
  }
  const apply = (format: string) => format.replace(/yyyy|yy|MM|M|dd|d|HH|H|mm/g, (token) => tokens[token] ?? token)
  return `${apply(dateFormat)} ${apply(timeFormat)}`.trim()
}
