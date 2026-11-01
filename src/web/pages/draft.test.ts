import { describe, expect, it } from "vitest"
import { afterOwnChange, draftBase, saveVersion } from "./draft.ts"

describe("draft base version", () => {
  it("keeps the version the owner started typing on when a refresh brings a newer one", () => {
    const base = draftBase(null, 3)
    // A background refresh shows version 4 (an agent's change) under the draft.
    expect(draftBase(base, 4)).toBe(3)
    expect(saveVersion(base, 4)).toBe(3)
  })

  it("sends the version on screen when nothing was typed", () => {
    expect(saveVersion(null, 4)).toBe(4)
  })

  it("follows the owner's own change only when it started from the base", () => {
    expect(afterOwnChange(3, 3, 4)).toBe(4)
    // Someone else changed it first (3 -> 4), then the owner (4 -> 5): the save must still conflict.
    expect(afterOwnChange(3, 4, 5)).toBe(3)
    expect(afterOwnChange(null, 3, 4)).toBeNull()
  })
})
