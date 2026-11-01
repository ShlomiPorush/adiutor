import { describe, expect, it } from "vitest"
import { DATE_FORMATS, TIME_FORMATS } from "../../shared/datetime-formats.ts"
import { formatLocal } from "./time.ts"

// 2026-07-04 21:05 UTC is 00:05 on 5 July in Asia/Jerusalem (summer time, UTC+3).
const AT = new Date("2026-07-04T21:05:00Z")
// 2026-11-01 11:30 UTC is 13:30 the same day (winter time, UTC+2).
const AFTERNOON = new Date("2026-11-01T11:30:00Z")

const dates: Record<(typeof DATE_FORMATS)[number], string> = {
  "dd/MM/yyyy": "05/07/2026",
  "MM/dd/yyyy": "07/05/2026",
  "dd.MM.yyyy": "05.07.2026",
  "yyyy-MM-dd": "2026-07-05",
  // The server has no browser: the default numeric date.
  browser: "05/07/2026",
}

describe("formatLocal", () => {
  it("covers every date format the settings offer", () => {
    expect(Object.keys(dates).sort()).toEqual([...DATE_FORMATS].sort())
    for (const format of DATE_FORMATS) expect(formatLocal(AT, format, "HH:mm")).toBe(`${dates[format]} 00:05`)
  })

  it("writes every time format the settings offer", () => {
    expect([...TIME_FORMATS].sort()).toEqual(["HH:mm", "browser", "h:mm a"].sort())
    expect(formatLocal(AFTERNOON, "dd/MM/yyyy", "HH:mm")).toBe("01/11/2026 13:30")
    // The server has no browser: the default 24-hour clock.
    expect(formatLocal(AFTERNOON, "dd/MM/yyyy", "browser")).toBe("01/11/2026 13:30")
    expect(formatLocal(AT, "dd/MM/yyyy", "h:mm a", "en")).toMatch(/^05\/07\/2026 12:05\sAM$/u)
    expect(formatLocal(AFTERNOON, "dd/MM/yyyy", "h:mm a", "en")).toMatch(/^01\/11\/2026 1:30\sPM$/u)
    const hebrew = formatLocal(AFTERNOON, "dd/MM/yyyy", "h:mm a", "he")
    expect(hebrew.startsWith("01/11/2026 1:30")).toBe(true)
    expect(hebrew).not.toContain("13:30")
  })

  it("falls back to the defaults for a value the settings do not offer", () => {
    expect(formatLocal(AT, "MMMM d", "hh:mm:ss")).toBe("05/07/2026 00:05")
  })
})
