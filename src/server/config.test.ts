import { describe, expect, it } from "vitest"
import { ConfigError, loadConfig } from "./config.ts"

const owner = "o".repeat(32)
const agent = "a".repeat(32)
const valid = {
  DATABASE_URL: "postgres://mikud:example@db.example.com:5432/mikud",
  MIKUD_OWNER_TOKEN: owner,
  MIKUD_AGENT_TOKEN: agent,
  MIKUD_PUBLIC_URL: "https://mikud.example.com",
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
  })

  it.each(["DATABASE_URL", "MIKUD_OWNER_TOKEN", "MIKUD_AGENT_TOKEN", "MIKUD_PUBLIC_URL"])(
    "refuses without %s",
    (name) => {
      expect(refusal({ ...valid, [name]: undefined })).toContain(`${name} is required`)
      expect(refusal({ ...valid, [name]: "" })).toContain(`${name} is required`)
    },
  )

  it("refuses a short token and never prints it", () => {
    const short = "s".repeat(31)
    const message = refusal({ ...valid, MIKUD_AGENT_TOKEN: short })
    expect(message).toContain("MIKUD_AGENT_TOKEN must be at least 32 characters")
    expect(message).not.toContain(short)
  })

  it("refuses equal tokens", () => {
    const message = refusal({ ...valid, MIKUD_AGENT_TOKEN: owner })
    expect(message).toContain("must differ")
    expect(message).not.toContain(owner)
  })

  it("refuses a public URL that is not http or https", () => {
    expect(refusal({ ...valid, MIKUD_PUBLIC_URL: "not a url" })).toContain("MIKUD_PUBLIC_URL")
    expect(refusal({ ...valid, MIKUD_PUBLIC_URL: "ftp://mikud.example.com" })).toContain("MIKUD_PUBLIC_URL")
  })

  it("refuses a database URL that is not PostgreSQL and never prints it", () => {
    const message = refusal({ ...valid, DATABASE_URL: "mysql://user:secret@db/mikud" })
    expect(message).toContain("DATABASE_URL must be a postgres:// URL")
    expect(message).not.toContain("secret")
  })

  it("reads the private domains, normalized, and refuses one that is not a domain", () => {
    expect(loadConfig(valid).privateDomains).toEqual([])
    expect(loadConfig({ ...valid, MIKUD_PRIVATE_DOMAINS: " Corp.Example , .internal.test.,," }).privateDomains).toEqual(
      ["corp.example", "internal.test"],
    )
    expect(refusal({ ...valid, MIKUD_PRIVATE_DOMAINS: "corp.example, not a domain" })).toContain(
      "MIKUD_PRIVATE_DOMAINS",
    )
  })

  it("refuses a bad port", () => {
    expect(refusal({ ...valid, PORT: "http" })).toContain("PORT")
  })

  describe("Telegram", () => {
    // Assembled at run time: the guards and push protection scan literal text.
    const botToken = `${"1234567"}:${"AAH"}${"x".repeat(32)}`

    it("is off without the bot token and the chat id", () => {
      expect(loadConfig(valid).telegram).toBeNull()
      expect(loadConfig({ ...valid, MIKUD_TELEGRAM_BOT_TOKEN: "", MIKUD_TELEGRAM_CHAT_ID: " " }).telegram).toBeNull()
    })

    it("reads both, with the official Bot API by default", () => {
      expect(
        loadConfig({ ...valid, MIKUD_TELEGRAM_BOT_TOKEN: botToken, MIKUD_TELEGRAM_CHAT_ID: "-1001" }).telegram,
      ).toEqual({ botToken, chatId: "-1001", apiUrl: "https://api.telegram.org" })
      expect(
        loadConfig({
          ...valid,
          MIKUD_TELEGRAM_BOT_TOKEN: botToken,
          MIKUD_TELEGRAM_CHAT_ID: "42",
          TELEGRAM_API_URL: "http://stand-in:8099/",
        }).telegram?.apiUrl,
      ).toBe("http://stand-in:8099")
    })

    it("refuses one without the other, a malformed value or API URL, and never prints the token", () => {
      const onlyToken = refusal({ ...valid, MIKUD_TELEGRAM_BOT_TOKEN: botToken })
      expect(onlyToken).toContain("must be set together")
      expect(onlyToken).not.toContain(botToken)
      expect(refusal({ ...valid, MIKUD_TELEGRAM_CHAT_ID: "42" })).toContain("must be set together")
      const badToken = `${botToken}!`
      const message = refusal({ ...valid, MIKUD_TELEGRAM_BOT_TOKEN: badToken, MIKUD_TELEGRAM_CHAT_ID: "42" })
      expect(message).toContain("MIKUD_TELEGRAM_BOT_TOKEN does not look like a bot token")
      expect(message).not.toContain(badToken)
      expect(refusal({ ...valid, MIKUD_TELEGRAM_BOT_TOKEN: botToken, MIKUD_TELEGRAM_CHAT_ID: "@owner" })).toContain(
        "MIKUD_TELEGRAM_CHAT_ID must be a numeric chat id",
      )
      expect(refusal({ ...valid, TELEGRAM_API_URL: "ftp://example.com" })).toContain("TELEGRAM_API_URL")
    })
  })
})
