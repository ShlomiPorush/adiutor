// The one place that writes dates and times (v3 FW-1, FW-2, FW-9). Every time on screen is in the
// application time zone (Asia/Jerusalem), never the browser's, and follows the Date Format and Time
// Format picked in Settings: numbers only, never month names. A page never formats a date itself;
// format.guard.test.ts fails on toLocaleDateString, Intl.DateTimeFormat and the like outside this file.

import type { DateFormat, TimeFormat } from "../api/types.ts"

export const APP_TIME_ZONE = "Asia/Jerusalem"
/** The formats the UI offers, as the server stores them; the server default is dd/MM/yyyy and HH:mm. */
export const DATE_FORMATS: readonly DateFormat[] = ["dd/MM/yyyy", "MM/dd/yyyy", "dd.MM.yyyy", "yyyy-MM-dd", "browser"]
export const TIME_FORMATS: readonly TimeFormat[] = ["HH:mm", "h:mm a", "browser"]
export const DEFAULT_DATE_FORMAT: DateFormat = "dd/MM/yyyy"
export const DEFAULT_TIME_FORMAT: TimeFormat = "HH:mm"

export function isDateFormat(value: string): value is DateFormat {
  return (DATE_FORMATS as readonly string[]).includes(value)
}
export function isTimeFormat(value: string): value is TimeFormat {
  return (TIME_FORMATS as readonly string[]).includes(value)
}

type Prefs = {
  dateFormat: DateFormat
  timeFormat: TimeFormat
  timeZone: string
  /** The UI language, for the 12-hour clock's day-half words. */
  uiLocale: string
  /** The browser's language, for the Browser choices. */
  browserLocale: string
}

const defaultBrowserLocale = typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-GB"

let prefs: Prefs = {
  dateFormat: DEFAULT_DATE_FORMAT,
  timeFormat: DEFAULT_TIME_FORMAT,
  timeZone: APP_TIME_ZONE,
  uiLocale: "he",
  browserLocale: defaultBrowserLocale,
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  let found = formatters.get(key)
  if (!found) {
    found = new Intl.DateTimeFormat(locale, options)
    formatters.set(key, found)
  }
  return found
}

function validZone(zone: string): string {
  try {
    formatter("en-US", { timeZone: zone })
    return zone
  } catch {
    return "UTC"
  }
}

/** Unknown stored values never stop the app: they fall back to the defaults. */
export function setFormatPrefs(
  next: Partial<Omit<Prefs, "dateFormat" | "timeFormat">> & { dateFormat?: string; timeFormat?: string },
): void {
  const merged = { ...prefs, ...next } as Prefs
  if (!isDateFormat(merged.dateFormat)) merged.dateFormat = DEFAULT_DATE_FORMAT
  if (!isTimeFormat(merged.timeFormat)) merged.timeFormat = DEFAULT_TIME_FORMAT
  merged.timeZone = validZone(merged.timeZone)
  prefs = merged
}

export function getFormatPrefs(): Readonly<Prefs> {
  return prefs
}

export type DateInput = string | number | Date | null | undefined

export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** The wall clock of an instant in the app time zone. */
export function zonedParts(date: Date, timeZone = prefs.timeZone): Parts {
  const parts = formatter("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  }
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0")

/** An instant's date as Date Format writes it, with or without the year. */
export function writeDate(date: Date, { year = true }: { year?: boolean } = {}): string {
  const p = zonedParts(date)
  const dd = pad(p.day)
  const mm = pad(p.month)
  const yyyy = pad(p.year, 4)
  switch (prefs.dateFormat) {
    case "dd/MM/yyyy":
      return year ? `${dd}/${mm}/${yyyy}` : `${dd}/${mm}`
    case "MM/dd/yyyy":
      return year ? `${mm}/${dd}/${yyyy}` : `${mm}/${dd}`
    case "dd.MM.yyyy":
      return year ? `${dd}.${mm}.${yyyy}` : `${dd}.${mm}`
    case "yyyy-MM-dd":
      return year ? `${yyyy}-${mm}-${dd}` : `${mm}-${dd}`
    default:
      return formatter(prefs.browserLocale, {
        timeZone: prefs.timeZone,
        day: "2-digit",
        month: "2-digit",
        ...(year ? { year: "numeric" } : {}),
      }).format(date)
  }
}

/** An instant's time of day as Time Format writes it. */
export function writeClock(date: Date, { seconds = false }: { seconds?: boolean } = {}): string {
  if (prefs.timeFormat === "HH:mm") {
    const p = zonedParts(date)
    return seconds ? `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` : `${pad(p.hour)}:${pad(p.minute)}`
  }
  const twelve = prefs.timeFormat === "h:mm a"
  return formatter(twelve ? prefs.uiLocale : prefs.browserLocale, {
    timeZone: prefs.timeZone,
    hour: twelve ? "numeric" : "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    ...(twelve ? { hourCycle: "h12" } : {}),
  }).format(date)
}

/** Date and time: "23/10/2026, 13:05:09" (seconds optional). */
export function formatTime(value: DateInput, { seconds = true }: { seconds?: boolean } = {}): string {
  const date = toDate(value)
  return date ? `${writeDate(date)}, ${writeClock(date, { seconds })}` : "-"
}

/** The date with its year: "23/10/2026". */
export function formatDay(value: DateInput): string {
  const date = toDate(value)
  return date ? writeDate(date) : "-"
}

/** Day and month: "23/10". */
export function formatDayMonth(value: DateInput): string {
  const date = toDate(value)
  return date ? writeDate(date, { year: false }) : "-"
}

/** The time of day: "13:05". */
export function formatClock(value: DateInput): string {
  const date = toDate(value)
  return date ? writeClock(date) : "-"
}

/** A list row: the time today, day and month earlier this year, the whole date before (FW-1). */
export function formatListTime(value: DateInput, now: Date = new Date()): string {
  const date = toDate(value)
  if (!date) return "-"
  const p = zonedParts(date)
  const n = zonedParts(now)
  if (p.year === n.year && p.month === n.month && p.day === n.day) return writeClock(date)
  if (p.year === n.year) return writeDate(date, { year: false })
  return writeDate(date)
}

export type Ago = { unit: "now" } | { unit: "min" | "h" | "d"; count: number }

/** How long ago, rounded: under a minute "now", under an hour minutes, under 48 hours hours, then days. */
export function agoParts(value: DateInput, now: Date = new Date()): Ago | null {
  const date = toDate(value)
  if (!date) return null
  const seconds = Math.max(0, (now.getTime() - date.getTime()) / 1000)
  if (seconds < 60) return { unit: "now" }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return { unit: "min", count: minutes }
  const hours = Math.round(seconds / 3600)
  if (hours < 48) return { unit: "h", count: hours }
  return { unit: "d", count: Math.round(seconds / 86_400) }
}

/** A day in the app time zone as YYYY-MM-DD, for keys and comparisons. */
export function dayKey(value: DateInput): string | null {
  const date = toDate(value)
  if (!date) return null
  const p = zonedParts(date)
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`
}

/** Runs fn with other formats for a moment: the Settings example shows a choice before it is saved. */
export function withFormatPrefs<T>(next: { dateFormat?: string; timeFormat?: string }, fn: () => T): T {
  const saved = prefs
  setFormatPrefs(next)
  try {
    return fn()
  } finally {
    prefs = saved
  }
}
