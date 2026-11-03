// The item title's direction follows its first letter, as dir="auto" does on an input: the title field is a
// textarea now (audit B-2), and Chromium does not follow a textarea's value for dir="auto".
import { describe, expect, it } from "vitest"
import he from "../../shared/locales/he.json"
import { textDirection } from "./ItemDialog.tsx"

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
