import { getTableConfig } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { SETTINGS_DEFAULTS } from "../../shared/settings.ts"
import { settings } from "./schema.ts"

// One source of defaults (R7): the database's column defaults are the table Settings resets to, and both keep the
// values Mikud has always had (the date default is dd/MM/yyyy, as in the schema).

describe("the settings defaults", () => {
  it("keep today's values", () => {
    expect(SETTINGS_DEFAULTS).toEqual({
      language: "he",
      dateFormat: "dd/MM/yyyy",
      timeFormat: "HH:mm",
      closedItemDays: 7,
      sessionIdleDays: 30,
      otpViaTelegram: false,
    })
  })

  it("are the database's column defaults", () => {
    const columns = new Map(getTableConfig(settings).columns.map((column) => [column.name, column]))
    const column = {
      language: "language",
      dateFormat: "date_format",
      timeFormat: "time_format",
      closedItemDays: "closed_item_days",
      sessionIdleDays: "session_idle_days",
      otpViaTelegram: "otp_via_telegram",
    } as const
    for (const [key, value] of Object.entries(SETTINGS_DEFAULTS))
      expect(columns.get(column[key as keyof typeof column])?.default, key).toBe(value)
  })
})
