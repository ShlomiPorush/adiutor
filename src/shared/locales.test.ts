import { describe, expect, it } from "vitest"
import { ITEM_STATUSES, LABELLED_CODES, stageSchema } from "./enums.ts"
import en from "./locales/en.json"
import he from "./locales/he.json"

const locales = { en, he } as Record<string, Record<string, unknown>>

function keys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix]
  return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
}

describe("locale files", () => {
  it("have the same keys", () => {
    expect(keys(he).sort()).toEqual(keys(en).sort())
  })

  for (const [name, locale] of Object.entries(locales)) {
    it(`${name} labels every code of every labelled group, and nothing else`, () => {
      for (const [group, codes] of Object.entries(LABELLED_CODES)) {
        const labels = locale[group] as Record<string, string>
        expect(Object.keys(labels).sort(), group).toEqual([...codes].sort())
        for (const code of codes) expect(labels[code]?.trim(), `${group}.${code}`).toBeTruthy()
      }
      expect(typeof locale.inbox === "string" && locale.inbox.trim()).toBeTruthy()
    })
  }

  it("Hebrew labels are in Hebrew", () => {
    expect(he.itemStatus.waiting_on_you).toMatch(/\p{Script=Hebrew}/u)
    expect(he.inbox).toMatch(/\p{Script=Hebrew}/u)
  })
})

describe("code schemas", () => {
  it("accept the codes and refuse anything else", () => {
    expect(stageSchema.parse("production")).toBe("production")
    expect(stageSchema.safeParse("Production").success).toBe(false)
    expect(ITEM_STATUSES).toContain("waiting_on_you")
  })
})
