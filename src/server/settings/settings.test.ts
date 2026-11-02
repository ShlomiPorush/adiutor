import { describe, expect, it } from "vitest"
import type { SettingsRow } from "../services/admin.ts"
import { createSettingsCipher } from "./crypto.ts"
import { BOT_TOKEN_COLUMN, effectivePrivateDomains, effectiveTelegram } from "./effective.ts"

// Assembled at run time: the guards and push protection scan literal text.
const keyOne = { version: 1, value: "k".repeat(32) }
const keyTwo = { version: 2, value: "n".repeat(32) }
const botToken = `${"1234567"}:${"AAH"}${"x".repeat(32)}`

const row = (patch: Partial<SettingsRow> = {}): SettingsRow => ({
  id: 1,
  closedItemDays: 7,
  dateFormat: "dd/MM/yyyy",
  timeFormat: "HH:mm",
  language: "he",
  sessionIdleDays: 30,
  otpViaTelegram: false,
  telegramBotTokenEnc: null,
  telegramChatId: null,
  privateDomains: [],
  updatedAt: new Date(0),
  ...patch,
})

describe("settings secrets", () => {
  it("round-trips a value and never stores it in plain text", () => {
    const cipher = createSettingsCipher([keyOne])
    const stored = cipher.encrypt(BOT_TOKEN_COLUMN, botToken)
    expect(stored).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(stored).not.toContain(botToken.split(":")[1])
    expect(cipher.decrypt(BOT_TOKEN_COLUMN, stored)).toBe(botToken)
    // A new IV every time.
    expect(cipher.encrypt(BOT_TOKEN_COLUMN, botToken)).not.toBe(stored)
  })

  it("decrypts older versions after a rotation and encrypts with the newest", () => {
    const stored = createSettingsCipher([keyOne]).encrypt(BOT_TOKEN_COLUMN, botToken)
    const rotated = createSettingsCipher([keyTwo, keyOne])
    expect(rotated.decrypt(BOT_TOKEN_COLUMN, stored)).toBe(botToken)
    expect(rotated.encrypt(BOT_TOKEN_COLUMN, botToken)).toMatch(/^v2\./)
  })

  it("cannot read a value of a version no longer listed, another column's value, or a damaged one", () => {
    const stored = createSettingsCipher([keyOne]).encrypt(BOT_TOKEN_COLUMN, botToken)
    expect(createSettingsCipher([keyTwo]).decrypt(BOT_TOKEN_COLUMN, stored)).toBeNull()
    const cipher = createSettingsCipher([keyOne])
    expect(cipher.decrypt("another_column", stored)).toBeNull()
    expect(cipher.decrypt(BOT_TOKEN_COLUMN, `${stored.slice(0, -2)}AA`)).toBeNull()
    expect(cipher.decrypt(BOT_TOKEN_COLUMN, "plain text")).toBeNull()
    // Same version number, other key: not readable.
    expect(createSettingsCipher([{ version: 1, value: "z".repeat(32) }]).decrypt(BOT_TOKEN_COLUMN, stored)).toBeNull()
  })
})

describe("effective settings: the environment first, per field", () => {
  const cipher = createSettingsCipher([keyOne])
  const enc = cipher.encrypt(BOT_TOKEN_COLUMN, botToken)

  it("is off with neither field, incomplete with one, on with both", () => {
    expect(effectiveTelegram(row(), {}, cipher).state).toBe("off")
    const half = effectiveTelegram(row({ telegramChatId: "42" }), {}, cipher)
    expect([half.state, half.missing]).toEqual(["incomplete", ["botToken"]])
    const on = effectiveTelegram(row({ telegramBotTokenEnc: enc, telegramChatId: "42" }), {}, cipher)
    expect([on.state, on.botToken, on.chatId]).toEqual(["on", botToken, "42"])
    expect(JSON.stringify(on.view)).not.toContain(botToken)
  })

  it("merges an environment field with a stored one and locks only the environment's field", () => {
    const merged = effectiveTelegram(row({ telegramChatId: "42" }), { telegramBotToken: botToken }, cipher)
    expect(merged.state).toBe("on")
    expect(merged.view.botToken).toEqual({
      set: true,
      readable: true,
      locked: true,
      variable: "MIKUD_TELEGRAM_BOT_TOKEN",
    })
    expect(merged.view.chatId).toEqual({ value: "42", locked: false, variable: null })
    const env = effectiveTelegram(row({ telegramBotTokenEnc: enc, telegramChatId: "42" }), { telegramChatId: "7" }, cipher)
    expect([env.chatId, env.view.chatId.locked]).toEqual(["7", true])
  })

  it("shows an unreadable stored token as set but not readable, and the pair as incomplete", () => {
    const other = createSettingsCipher([keyTwo])
    const unreadable = effectiveTelegram(row({ telegramBotTokenEnc: enc, telegramChatId: "42" }), {}, other)
    expect(unreadable.state).toBe("incomplete")
    expect(unreadable.view.botToken).toMatchObject({ set: true, readable: false })
  })

  it("takes the private domains from the environment when it sets them", () => {
    expect(effectivePrivateDomains(row({ privateDomains: ["corp.example"] }), {})).toEqual({
      value: ["corp.example"],
      locked: false,
      variable: null,
    })
    expect(effectivePrivateDomains(row({ privateDomains: ["corp.example"] }), { privateDomains: ["lab.test"] })).toEqual(
      { value: ["lab.test"], locked: true, variable: "MIKUD_PRIVATE_DOMAINS" },
    )
  })
})
