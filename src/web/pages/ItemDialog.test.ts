// The item title's direction follows its first letter, as dir="auto" does on an input: the title field is a
// textarea now (audit B-2), and Chromium does not follow a textarea's value for dir="auto".
import { describe, expect, it } from "vitest"
import he from "../../shared/locales/he.json"
import { snoozedNow, textDirection } from "./ItemDialog.tsx"

describe("the title's direction", () => {
  it("follows the first letter, past digits and punctuation", () => {
    expect(textDirection("Water the herb spiral")).toBe("ltr")
    expect(textDirection(he.inbox)).toBe("rtl")
    expect(textDirection(`2026: ${he.inbox} and more`)).toBe("rtl")
    expect(textDirection(`#12 Water ${he.inbox}`)).toBe("ltr")
    expect(textDirection("12 - 3")).toBe("auto")
    expect(textDirection("")).toBe("auto")
  })
})

describe("a thread's snooze", () => {
  it("shows while it lasts: until resumed, or until its time passes", () => {
    const now = Date.parse("2026-11-16T12:00:00.000Z")
    expect(snoozedNow({ snoozed: false, snoozedUntil: null }, now)).toBe(false)
    expect(snoozedNow({ snoozed: true, snoozedUntil: null }, now)).toBe(true)
    expect(snoozedNow({ snoozed: true, snoozedUntil: "2026-11-16T13:00:00.000Z" }, now)).toBe(true)
    expect(snoozedNow({ snoozed: true, snoozedUntil: "2026-11-16T11:00:00.000Z" }, now)).toBe(false)
  })
})
