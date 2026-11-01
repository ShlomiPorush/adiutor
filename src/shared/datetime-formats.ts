// The Date Format and Time Format settings, shared by the web UI and the server (the morning message):
// the values offered, the defaults, and the numeric date each format writes. Numbers only, never month
// names. "browser" follows the browser's language in the UI; the server has no browser, so it writes the
// default numeric date and the 24-hour clock.

export const DATE_FORMATS = ["dd/MM/yyyy", "MM/dd/yyyy", "dd.MM.yyyy", "yyyy-MM-dd", "browser"] as const
export const TIME_FORMATS = ["HH:mm", "h:mm a", "browser"] as const
export type DateFormat = (typeof DATE_FORMATS)[number]
export type TimeFormat = (typeof TIME_FORMATS)[number]
export const DEFAULT_DATE_FORMAT: DateFormat = "dd/MM/yyyy"
export const DEFAULT_TIME_FORMAT: TimeFormat = "HH:mm"

export function isDateFormat(value: string): value is DateFormat {
  return (DATE_FORMATS as readonly string[]).includes(value)
}
export function isTimeFormat(value: string): value is TimeFormat {
  return (TIME_FORMATS as readonly string[]).includes(value)
}

/** A wall-clock date, already in the application time zone. */
export type WallDate = { year: number; month: number; day: number }

const pad = (value: number, length = 2) => String(value).padStart(length, "0")

/** The date as a numeric format writes it, with or without the year; null for "browser". */
export function writeNumericDate(p: WallDate, format: DateFormat, { year = true } = {}): string | null {
  const dd = pad(p.day)
  const mm = pad(p.month)
  const yyyy = pad(p.year, 4)
  switch (format) {
    case "dd/MM/yyyy":
      return year ? `${dd}/${mm}/${yyyy}` : `${dd}/${mm}`
    case "MM/dd/yyyy":
      return year ? `${mm}/${dd}/${yyyy}` : `${mm}/${dd}`
    case "dd.MM.yyyy":
      return year ? `${dd}.${mm}.${yyyy}` : `${dd}.${mm}`
    case "yyyy-MM-dd":
      return year ? `${yyyy}-${mm}-${dd}` : `${mm}-${dd}`
    case "browser":
      return null
  }
}

/** The 24-hour clock: "13:05". */
export function write24h(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`
}
