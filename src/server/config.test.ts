import { randomBytes, randomInt } from "node:crypto"
import { describe, expect, it } from "vitest"
import { ConfigError, loadConfig } from "./config.ts"
import { testBotToken, testSecret } from "./testing/secrets.ts"

// Every value the loader accepts is new on each run; only refused values are literal.
const authSecret = testSecret()
const settingsKey = testSecret()
const valid = {
  DATABASE_URL: `postgres://mikud:${randomBytes(16).toString("hex")}@db.example.com:5432/mikud`,
  MIKUD_PUBLIC_URL: "https://mikud.example.com",
  MIKUD_AUTH_SECRETS: `1:${authSecret}`,
  MIKUD_SETTINGS_KEYS: `1:${settingsKey}`,
}

function refusal(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as Error).message
  }
  throw new Error("the configuration was accepted")
}

describe("loadConfig", () => {
  it("accepts a complete configuration with defaults", () => {
    const config = loadConfig(valid)
    expect(config.port).toBe(8080)
    expect(config.migrationsDir).toBe("drizzle")
    expect(config.publicUrl.origin).toBe("https://mikud.example.com")
    expect(config.authSecrets).toEqual([{ version: 1, value: authSecret }])
    expect(config.settingsKeys).toEqual([{ version: 1, value: settingsKey }])
    expect(config.legacyAuthSecret).toBeUndefined()
    expect(config.trustedProxies).toEqual([])
    expect(config.telegramApiUrl).toBe("https://api.telegram.org")
    expect(config.overrides).toEqual({})
    expect(config.warnings).toEqual([])
  })

  it.each(["DATABASE_URL", "MIKUD_PUBLIC_URL", "MIKUD_AUTH_SECRETS", "MIKUD_SETTINGS_KEYS"])(
    "refuses without %s",
    (name) => {
      expect(refusal({ ...valid, [name]: undefined })).toContain(`${name} is required`)
      expect(refusal({ ...valid, [name]: "" })).toContain(`${name} is required`)
    },
  )

  it("reads versioned keys, newest first, and refuses a bad entry, a repeated version or a short key unprinted", () => {
    const older = testSecret()
    expect(loadConfig({ ...valid, MIKUD_AUTH_SECRETS: `2:${authSecret}, 1:${older}` }).authSecrets).toEqual([
      { version: 2, value: authSecret },
      { version: 1, value: older },
    ])
    expect(refusal({ ...valid, MIKUD_AUTH_SECRETS: authSecret })).toContain("must look like <version>:<secret>")
    expect(refusal({ ...valid, MIKUD_AUTH_SECRETS: `1:${authSecret},1:${older}` })).toContain("repeats version 1")
    const short = "x".repeat(31)
    const message = refusal({ ...valid, MIKUD_SETTINGS_KEYS: `1:${short}` })
    expect(message).toContain("MIKUD_SETTINGS_KEYS entry 1 must be at least 32 bytes")
    expect(message).not.toContain(short)
    // Counted in bytes: 16 two-byte characters are enough (U+0100 to U+07FF: two bytes each, none that trim() drops).
    const twoByte = String.fromCodePoint(...Array.from({ length: 16 }, () => randomInt(0x100, 0x800)))
    expect(loadConfig({ ...valid, MIKUD_AUTH_SECRETS: `1:${twoByte}` }).authSecrets).toHaveLength(1)
  })

  it("keeps the settings key apart from every auth secret, the legacy one too", () => {
    expect(refusal({ ...valid, MIKUD_SETTINGS_KEYS: `1:${authSecret}` })).toContain(
      "MIKUD_SETTINGS_KEYS must differ from every auth secret",
    )
    const legacy = testSecret()
    expect(loadConfig({ ...valid, MIKUD_AUTH_SECRET: legacy }).legacyAuthSecret).toBe(legacy)
    expect(refusal({ ...valid, MIKUD_AUTH_SECRET: legacy, MIKUD_SETTINGS_KEYS: `1:${legacy}` })).toContain(
      "must differ from every auth secret",
    )
    expect(refusal({ ...valid, MIKUD_AUTH_SECRET: "short" })).toContain("MIKUD_AUTH_SECRET must be at least 32 bytes")
  })

  it("refuses the variables Better Auth would read on its own", () => {
    for (const name of ["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"])
      expect(refusal({ ...valid, [name]: "x" })).toContain(`${name} is set`)
    expect(refusal({ ...valid, AUTH_SECRET: "x" })).toContain("AUTH_SECRET is set")
  })

  it("only warns about the old token variables", () => {
    const config = loadConfig({ ...valid, MIKUD_OWNER_TOKEN: "o".repeat(40), MIKUD_AGENT_TOKEN: "a".repeat(40) })
    expect(config.warnings).toEqual([
      "MIKUD_OWNER_TOKEN is no longer used: remove it",
      "MIKUD_AGENT_TOKEN is no longer used: remove it",
    ])
  })

  it("reads the trusted proxies and refuses one that is not an address or range", () => {
    expect(loadConfig({ ...valid, MIKUD_TRUSTED_PROXIES: "192.0.2.10, 198.51.100.0/24" }).trustedProxies).toEqual([
      "192.0.2.10",
      "198.51.100.0/24",
    ])
    expect(refusal({ ...valid, MIKUD_TRUSTED_PROXIES: "traefik" })).toContain("MIKUD_TRUSTED_PROXIES")
  })

  it("refuses a public URL that is not http or https", () => {
    expect(refusal({ ...valid, MIKUD_PUBLIC_URL: "not a url" })).toContain("MIKUD_PUBLIC_URL")
    expect(refusal({ ...valid, MIKUD_PUBLIC_URL: "ftp://mikud.example.com" })).toContain("MIKUD_PUBLIC_URL")
  })

  it("refuses a database URL that is not PostgreSQL and never prints it", () => {
    const message = refusal({ ...valid, DATABASE_URL: "mysql://user:secret@db/mikud" })
    expect(message).toContain("DATABASE_URL must be a postgres:// URL")
    expect(message).not.toContain("secret@")
  })

  it("refuses a bad port", () => {
    expect(refusal({ ...valid, PORT: "http" })).toContain("PORT")
  })

  describe("owner settings the environment overrides, per field", () => {
    const botToken = testBotToken()

    it("sets nothing without the variables, or with empty ones", () => {
      expect(loadConfig({ ...valid, MIKUD_TELEGRAM_BOT_TOKEN: "", MIKUD_TELEGRAM_CHAT_ID: " " }).overrides).toEqual({})
    })

    it("reads each Telegram field on its own: one without the other is fine", () => {
      expect(loadConfig({ ...valid, MIKUD_TELEGRAM_BOT_TOKEN: botToken }).overrides).toEqual({
        telegramBotToken: botToken,
      })
      expect(loadConfig({ ...valid, MIKUD_TELEGRAM_CHAT_ID: "-1001" }).overrides).toEqual({ telegramChatId: "-1001" })
      expect(loadConfig({ ...valid, TELEGRAM_API_URL: "http://stand-in:8099/" }).telegramApiUrl).toBe(
        "http://stand-in:8099",
      )
    })

    it("refuses a malformed value by its name, never printing it", () => {
      const badToken = `${botToken}!`
      const message = refusal({ ...valid, MIKUD_TELEGRAM_BOT_TOKEN: badToken })
      expect(message).toContain("MIKUD_TELEGRAM_BOT_TOKEN does not look like a bot token")
      expect(message).not.toContain(badToken)
      expect(refusal({ ...valid, MIKUD_TELEGRAM_CHAT_ID: "@owner" })).toContain(
        "MIKUD_TELEGRAM_CHAT_ID must be a numeric chat id",
      )
      expect(refusal({ ...valid, TELEGRAM_API_URL: "ftp://example.com" })).toContain("TELEGRAM_API_URL")
    })

    it("reads the private domains, normalized, and refuses one that is not a domain", () => {
      expect(
        loadConfig({ ...valid, MIKUD_PRIVATE_DOMAINS: " Corp.Example , .internal.test.,," }).overrides.privateDomains,
      ).toEqual(["corp.example", "internal.test"])
      expect(refusal({ ...valid, MIKUD_PRIVATE_DOMAINS: "corp.example, not a domain" })).toContain(
        "MIKUD_PRIVATE_DOMAINS",
      )
    })
  })
})
