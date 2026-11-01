import { DEFAULT_DATE_FORMAT, isDateFormat, write24h, writeNumericDate } from "../../shared/datetime-formats.ts"

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

const twelveHour = new Map<string, Intl.DateTimeFormat>()

/** The 12-hour clock with the day half in the message's language: "12:05 AM". */
function write12h(at: Date, language: string): string {
  let format = twelveHour.get(language)
  if (!format) {
    format = new Intl.DateTimeFormat(language, {
      timeZone: TIME_ZONE,
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h12",
    })
    twelveHour.set(language, format)
  }
  return format.format(at)
}

/**
 * A time in Asia/Jerusalem by the owner's Date Format and Time Format settings, written as the UI writes
 * them (src/shared/datetime-formats.ts). "browser", and a value the settings do not offer, write the
 * default numeric date and the 24-hour clock: the server has no browser. Never a month name.
 */
export function formatLocal(at: Date, dateFormat: string, timeFormat: string, language = "en"): string {
  const t = localTime(at)
  const date =
    (isDateFormat(dateFormat) ? writeNumericDate(t, dateFormat) : null) ?? writeNumericDate(t, DEFAULT_DATE_FORMAT)
  const time = timeFormat === "h:mm a" ? write12h(at, language) : write24h(t.hour, t.minute)
  return `${date} ${time}`
}
