import { afterEach, describe, expect, it } from "vitest"
import {
  agoParts,
  dayKey,
  formatClock,
  formatDay,
  formatDayMonth,
  formatListTime,
  formatTime,
  getFormatPrefs,
  setFormatPrefs,
  withFormatPrefs,
} from "./datetime.ts"
import { formatNumber, setNumberLocale } from "./number.ts"

// 2026-10-23 10:05:09 UTC is 13:05:09 in Jerusalem (summer time, UTC+3, until 25 October 2026).
const SUMMER = "2026-10-23T10:05:09Z"
// 2026-12-01 10:05 UTC is 12:05 in Jerusalem (winter time, UTC+2).
const WINTER = "2026-12-01T10:05:00Z"

afterEach(() =>
  setFormatPrefs({ dateFormat: "dd/MM/yyyy", timeFormat: "HH:mm", timeZone: "Asia/Jerusalem", uiLocale: "en-US" }),
)

describe("dates and times (FW-9)", () => {
  it("write the app time zone, not the browser's, across a clock change", () => {
    setFormatPrefs({ dateFormat: "dd/MM/yyyy", timeFormat: "HH:mm" })
    expect(formatTime(SUMMER)).toBe("23/10/2026, 13:05:09")
    expect(formatTime(SUMMER, { seconds: false })).toBe("23/10/2026, 13:05")
    expect(formatClock(WINTER)).toBe("12:05")
  })

  it("follow every date format the UI offers", () => {
    const cases: [string, string, string][] = [
      ["dd/MM/yyyy", "23/10/2026", "23/10"],
      ["MM/dd/yyyy", "10/23/2026", "10/23"],
      ["dd.MM.yyyy", "23.10.2026", "23.10"],
      ["yyyy-MM-dd", "2026-10-23", "10-23"],
    ]
    for (const [format, day, dayMonth] of cases) {
      setFormatPrefs({ dateFormat: format })
      expect(formatDay(SUMMER), format).toBe(day)
      expect(formatDayMonth(SUMMER), format).toBe(dayMonth)
    }
  })

  it("never write month names, in the Browser choice either", () => {
    setFormatPrefs({ dateFormat: "browser", browserLocale: "en-US" })
    expect(formatDay(SUMMER)).toMatch(/^\d{2}\D\d{2}\D\d{4}$/)
  })

  it("write the 12-hour clock in the UI language", () => {
    setFormatPrefs({ timeFormat: "h:mm a", uiLocale: "en-US" })
    expect(formatClock(SUMMER)).toMatch(/^1:05\s?PM$/)
  })

  it("fall back to the defaults for a value the server holds but the UI does not know", () => {
    setFormatPrefs({ dateFormat: "yyyy/dd/MM", timeFormat: "HH.mm" })
    expect(getFormatPrefs().dateFormat).toBe("dd/MM/yyyy")
    expect(getFormatPrefs().timeFormat).toBe("HH:mm")
    setFormatPrefs({ timeZone: "Not/AZone" })
    expect(getFormatPrefs().timeZone).toBe("UTC")
  })

  it("show a list row as the time today, day and month this year, the whole date before (FW-1)", () => {
    const now = new Date("2026-10-24T08:00:00Z")
    // 22:30 UTC on the 23rd is already 01:30 on the 24th in Jerusalem: today.
    expect(formatListTime("2026-10-23T22:30:00Z", now)).toBe("01:30")
    expect(formatListTime("2026-10-23T20:30:00Z", now)).toBe("23/10")
    expect(formatListTime("2025-12-31T10:00:00Z", now)).toBe("31/12/2025")
    expect(dayKey("2026-10-23T22:30:00Z")).toBe("2026-10-24")
  })

  it("count how long ago, rounded, and clamp the future to now", () => {
    const now = new Date("2026-10-24T12:00:00Z")
    expect(agoParts("2026-10-24T11:59:30Z", now)).toEqual({ unit: "now" })
    expect(agoParts("2026-10-24T13:00:00Z", now)).toEqual({ unit: "now" })
    expect(agoParts("2026-10-24T11:15:00Z", now)).toEqual({ unit: "min", count: 45 })
    expect(agoParts("2026-10-23T12:00:00Z", now)).toEqual({ unit: "h", count: 24 })
    expect(agoParts("2026-10-20T12:00:00Z", now)).toEqual({ unit: "d", count: 4 })
    expect(agoParts(null, now)).toBeNull()
  })

  it("show a dash for no value, and an example in other formats without changing the current ones", () => {
    expect(formatTime(null)).toBe("-")
    expect(formatDay("not a date")).toBe("-")
    const example = withFormatPrefs({ dateFormat: "yyyy-MM-dd" }, () => formatDay(SUMMER))
    expect(example).toBe("2026-10-23")
    expect(formatDay(SUMMER)).toBe("23/10/2026")
  })
})

describe("counts (FW-3)", () => {
  it("use the UI language's separator, not the browser's", () => {
    setNumberLocale("en")
    expect(formatNumber(4096)).toBe("4,096")
    setNumberLocale("he")
    expect(formatNumber(1920)).toBe("1,920")
  })
})
