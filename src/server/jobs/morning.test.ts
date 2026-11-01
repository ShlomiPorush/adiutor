import { describe, expect, it } from "vitest"
import type { JobState } from "../../shared/enums.ts"
import { decideMorning } from "./morning.ts"
import { localTime } from "./time.ts"

// Asia/Jerusalem is UTC+2 in November (winter time) and UTC+3 in July (summer time).
// 2026-11-01 is a Sunday, 2026-11-06 a Friday, 2026-11-07 a Saturday.
const at = (iso: string) => new Date(iso)
const run = (state: JobState) => ({ state })

describe("localTime", () => {
  it("reads the wall clock in Asia/Jerusalem across midnight and daylight saving time", () => {
    expect(localTime(at("2026-11-01T06:00:00Z"))).toMatchObject({ date: "2026-11-01", hour: 8, minute: 0, weekday: 0 })
    expect(localTime(at("2026-10-31T22:30:00Z"))).toMatchObject({ date: "2026-11-01", hour: 0, weekday: 0 })
    expect(localTime(at("2026-07-05T05:00:00Z"))).toMatchObject({ date: "2026-07-05", hour: 8, weekday: 0 })
  })
})

describe("decideMorning", () => {
  it("waits before 08:00", () => {
    expect(decideMorning(at("2026-11-01T05:59:59Z"), null)).toEqual({ action: "none", reason: "too_early" })
    expect(decideMorning(at("2026-07-05T04:59:00Z"), null)).toEqual({ action: "none", reason: "too_early" })
  })

  it("sends at 08:00 Sunday to Friday", () => {
    expect(decideMorning(at("2026-11-01T06:00:00Z"), null)).toEqual({
      action: "send",
      localDate: "2026-11-01",
      retry: false,
    })
    expect(decideMorning(at("2026-11-06T06:00:00Z"), null)).toMatchObject({ action: "send", localDate: "2026-11-06" })
    // Summer time: 08:00 in Jerusalem is 05:00 UTC.
    expect(decideMorning(at("2026-07-05T05:00:00Z"), null)).toMatchObject({ action: "send", localDate: "2026-07-05" })
  })

  it("never sends on Saturday", () => {
    expect(decideMorning(at("2026-11-07T06:00:00Z"), null)).toEqual({ action: "none", reason: "saturday" })
    expect(decideMorning(at("2026-11-07T10:00:00Z"), null)).toEqual({ action: "none", reason: "saturday" })
  })

  it("sends late until 11:00 and skips the day after", () => {
    expect(decideMorning(at("2026-11-01T08:59:00Z"), null)).toMatchObject({ action: "send", localDate: "2026-11-01" })
    expect(decideMorning(at("2026-11-01T09:00:00Z"), null)).toEqual({ action: "skip", localDate: "2026-11-01" })
    expect(decideMorning(at("2026-11-01T09:01:00Z"), null)).toEqual({ action: "skip", localDate: "2026-11-01" })
  })

  it("retries a failed run until the cutoff, then skips it", () => {
    expect(decideMorning(at("2026-11-01T07:00:00Z"), run("failed"))).toEqual({
      action: "send",
      localDate: "2026-11-01",
      retry: true,
    })
    expect(decideMorning(at("2026-11-01T09:01:00Z"), run("failed"))).toEqual({
      action: "skip",
      localDate: "2026-11-01",
    })
  })

  it("never sends twice: a run in progress, sent, unknown or skipped ends the day", () => {
    expect(decideMorning(at("2026-11-01T06:30:00Z"), run("sending"))).toEqual({ action: "none", reason: "in_progress" })
    for (const state of ["sent", "unknown", "skipped"] as const) {
      expect(decideMorning(at("2026-11-01T06:30:00Z"), run(state))).toEqual({ action: "none", reason: "done" })
      expect(decideMorning(at("2026-11-01T09:30:00Z"), run(state))).toEqual({ action: "none", reason: "done" })
    }
  })
})
