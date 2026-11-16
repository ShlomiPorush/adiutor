import { randomBytes, randomInt } from "node:crypto"
import { describe, expect, it } from "vitest"
import { ConfigError, deriveAgentCookieKeys, isCertainPlaceholder, loadConfig, looksLikePlaceholder } from "./config.ts"
import { testBotToken, testSecret } from "./testing/secrets.ts"

// Every value the loader accepts is new on each run; only refused values are literal.
const authSecret = testSecret()
const settingsKey = testSecret()
const valid = {
  DATABASE_URL: `postgres://adiutor:${randomBytes(16).toString("hex")}@db.example.com:5432/adiutor`,
  ADIUTOR_PUBLIC_URL: "https://adiutor.example.com",
  ADIUTOR_AUTH_SECRETS: `1:${authSecret}`,
  ADIUTOR_SETTINGS_KEYS: `1:${settingsKey}`,
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
    expect(config.publicUrl.origin).toBe("https://adiutor.example.com")
    expect(config.publicUrlText).toBe("https://adiutor.example.com")
    expect(config.authSecrets).toEqual([{ version: 1, value: authSecret }])
    expect(config.settingsKeys).toEqual([{ version: 1, value: settingsKey }])
    expect(config.agentCookieKeys).toEqual(deriveAgentCookieKeys(config.authSecrets))
    expect(config.trustedProxies).toEqual([])
    expect(config.telegramApiUrl).toBe("https://api.telegram.org")
    expect(config.overrides).toEqual({})
    expect(config.warnings).toEqual([])
  })

  it.each(["DATABASE_URL", "ADIUTOR_PUBLIC_URL", "ADIUTOR_AUTH_SECRETS", "ADIUTOR_SETTINGS_KEYS"])(
    "refuses without %s",
    (name) => {
      expect(refusal({ ...valid, [name]: undefined })).toContain(`${name} is required`)
      expect(refusal({ ...valid, [name]: "" })).toContain(`${name} is required`)
    },
  )

  it("reads versioned keys, newest first, and refuses a bad entry, a repeated version or a short key unprinted", () => {
    const older = testSecret()
    expect(loadConfig({ ...valid, ADIUTOR_AUTH_SECRETS: `2:${authSecret}, 1:${older}` }).authSecrets).toEqual([
      { version: 2, value: authSecret },
      { version: 1, value: older },
    ])
    expect(refusal({ ...valid, ADIUTOR_AUTH_SECRETS: authSecret })).toContain("must look like <version>:<secret>")
    expect(refusal({ ...valid, ADIUTOR_AUTH_SECRETS: `1:${authSecret},1:${older}` })).toContain("repeats version 1")
    const short = "x".repeat(31)
    const message = refusal({ ...valid, ADIUTOR_SETTINGS_KEYS: `1:${short}` })
    expect(message).toContain("ADIUTOR_SETTINGS_KEYS entry 1 must be at least 32 bytes")
    expect(message).not.toContain(short)
    // Counted in bytes: 16 two-byte characters are enough (U+0100 to U+07FF: two bytes each, none that trim() drops).
    const twoByte = String.fromCodePoint(...Array.from({ length: 16 }, () => randomInt(0x100, 0x800)))
    expect(loadConfig({ ...valid, ADIUTOR_AUTH_SECRETS: `1:${twoByte}` }).authSecrets).toHaveLength(1)
  })

  it("keeps the settings key apart from every auth secret", () => {
    const older = testSecret()
    expect(refusal({ ...valid, ADIUTOR_SETTINGS_KEYS: `1:${authSecret}` })).toContain(
      "ADIUTOR_SETTINGS_KEYS must differ from every auth secret",
    )
    expect(
      refusal({ ...valid, ADIUTOR_AUTH_SECRETS: `2:${authSecret},1:${older}`, ADIUTOR_SETTINGS_KEYS: `1:${older}` }),
    ).toContain("ADIUTOR_SETTINGS_KEYS must differ from every auth secret")
  })

  it("keeps ADIUTOR_PUBLIC_URL as written beside the parsed URL", () => {
    const config = loadConfig({ ...valid, ADIUTOR_PUBLIC_URL: "https://Adiutor.example.com/" })
    expect(config.publicUrl.origin).toBe("https://adiutor.example.com")
    expect(config.publicUrlText).toBe("https://Adiutor.example.com/")
  })

  describe("the cookie keys of the authorization server for agents, derived from ADIUTOR_AUTH_SECRETS", () => {
    it("derives one key per auth secret, in the order listed, each its own and none equal to a secret", () => {
      const older = testSecret()
      const config = loadConfig({ ...valid, ADIUTOR_AUTH_SECRETS: `2:${authSecret},1:${older}` })
      const keys = config.agentCookieKeys
      expect(keys).toHaveLength(2)
      expect(new Set(keys).size).toBe(2)
      for (const key of keys) {
        expect(Buffer.from(key, "base64")).toHaveLength(32)
        for (const secret of [authSecret, older, settingsKey]) expect(key).not.toContain(secret)
      }
      // Rotation: the key derived from a secret stays the same when a newer secret is listed before it.
      expect(keys).toEqual([
        ...loadConfig(valid).agentCookieKeys,
        ...loadConfig({ ...valid, ADIUTOR_AUTH_SECRETS: `1:${older}` }).agentCookieKeys,
      ])
      expect(deriveAgentCookieKeys(config.authSecrets)).toEqual(keys)
    })

    it.each([
      ["a value", testSecret()],
      ["an empty value", ""],
      ["a malformed value", "not-a-key"],
    ])("only warns about a leftover ADIUTOR_OAUTH_SECRETS with %s, never reading or printing it", (_, value) => {
      const config = loadConfig({ ...valid, ADIUTOR_OAUTH_SECRETS: value })
      expect(config.warnings).toEqual([
        "ADIUTOR_OAUTH_SECRETS is no longer read: remove it; the agent cookie keys come from ADIUTOR_AUTH_SECRETS",
      ])
      if (value) expect(config.warnings.join(" ")).not.toContain(value)
      expect(config.agentCookieKeys).toEqual(loadConfig(valid).agentCookieKeys)
    })
  })

  describe("placeholders", () => {
    const families = ["ADIUTOR_AUTH_SECRETS", "ADIUTOR_SETTINGS_KEYS"]
    const recovery = "generate a new key with openssl rand -hex 32, list it first under a new version"
    // Refused values only: literal on purpose. No random key is ever one of these: refused in every entry.
    const certain = ["<32 random bytes from openssl rand -hex 32>", "a".repeat(40)]
    // Refused as the current (first) entry only: a placeholder word as a token, or few distinct characters.
    const likely = [
      "changeme",
      "changeme-changeme-changeme-changeme",
      "CHANGE_ME_CHANGE_ME_CHANGE_ME_CHANGE_ME",
      "CHANGE_ME_to_a_long_random_value_0123",
      "please-change-me-before-you-deploy-it",
      "replace-me-with-32-random-bytes-0123456",
      "replace-me placeholder secret value here",
      "ReplaceMe",
      "ReplaceMe0123456789012345678901234567",
      "your-secret-1",
      "placeholder-placeholder-placeholder",
      "PLACEHOLDER-VALUE-HERE",
      "Example",
      "an-Example-value-that-is-long-enough-0",
      "example-key-for-the-docs-0123456789abcdef",
      "Example2-key-for-docs-0123456789abcdef",
      "your-own-secret-goes-here-0123456789",
      "your-secret-here-0123456789abcdefghijkl",
      "YOUR_SECRET",
      "TODO: generate with openssl rand -hex 32",
      "a-real-key-goes-here-FIXME-0123456789",
      "secret-secret-secret-secret-secret",
      "abcabcabcabcabcabcabcabcabcabcabcabc",
    ]
    // A base64url key that starts like a placeholder word: refused as current, accepted as an older version.
    const unlucky = `your0${randomBytes(30).toString("base64url")}`

    it.each(families)("%s refuses a certain placeholder in any entry, never printing it", (name) => {
      for (const value of certain)
        for (const [text, entry] of [
          [`1:${value}`, 1],
          [`2:${testSecret()},1:${value}`, 2],
        ] as const) {
          const message = refusal({ ...valid, [name]: text })
          expect(message, value).toContain(`${name} entry ${entry} looks like an example placeholder`)
          expect(message).not.toContain(value)
        }
    })

    it.each(families)("%s refuses a likely placeholder as the current key, saying how to recover", (name) => {
      for (const value of [...likely, unlucky]) {
        const message = refusal({ ...valid, [name]: `2:${value},1:${testSecret()}` })
        expect(message, value).toContain(`${name} entry 1 looks like an example placeholder: ${recovery}`)
        expect(message).not.toContain(value)
      }
    })

    it.each(families)("%s accepts a likely placeholder as an older key behind a random current one", (name) => {
      // Every accepted value is new on each run: a placeholder word followed by a random key, a random run of fewer
      // than eight distinct characters (`x` keeps it from being one repeated character), and `unlucky`. Each still
      // looks like a placeholder, so only its place as an older key lets it through.
      const fewDistinct = `x${randomBytes(3).toString("hex")}`.repeat(6)
      const withWord = likely.filter((v) => !/^(abc)+$/.test(v)).map((v) => `${v}-${testSecret()}`)
      for (const value of [...withWord, fewDistinct, unlucky]) {
        expect(looksLikePlaceholder(value), value).toBe(true)
        expect(loadConfig({ ...valid, [name]: `2:${testSecret()},1:${value}` }), value).toBeDefined()
      }
    })

    it("accepts a random key where a letter or digit comes right before a placeholder word", () => {
      // Hex on every run around a fixed word with a letter or digit on its left, so the case is always the same:
      // the word is never a token of its own (aBcExampleXyZ, Qyour-Z, 0EXAMPLE9).
      const random = () => randomBytes(24).toString("hex")
      for (const word of [
        "Qyour-Z",
        "7your_4",
        "aBcExampleXyZ",
        "0EXAMPLE9",
        "xchangemex",
        "kchange-me2",
        "Rreplace_meQ",
        "9placeholder8",
        "1secret-",
        "atodob",
        "3FIXMEz",
        "x<a>x",
      ]) {
        for (const value of [`${random()}${word}${random()}`, `${word}${random()}`]) {
          expect(looksLikePlaceholder(value), word).toBe(false)
          expect(loadConfig({ ...valid, ADIUTOR_SETTINGS_KEYS: `1:${value}` }).settingsKeys).toHaveLength(1)
        }
      }
    })

    it("accepts 1000 random hex keys, as the stacks and the tests generate them", () => {
      for (let i = 0; i < 1000; i++) {
        const value = randomBytes(32).toString("hex")
        expect(isCertainPlaceholder(value) || looksLikePlaceholder(value), "random hex").toBe(false)
      }
      expect(testSecret()).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  it.each([
    ["a value", testSecret()],
    ["an empty value", ""],
  ])("refuses the removed ADIUTOR_AUTH_SECRET with %s, never printing it", (_, value) => {
    const message = refusal({ ...valid, ADIUTOR_AUTH_SECRET: value })
    expect(message).toContain(
      "ADIUTOR_AUTH_SECRET is no longer used: remove it; ADIUTOR_AUTH_SECRETS holds the auth keys",
    )
    if (value) expect(message).not.toContain(value)
  })

  it("refuses the variables Better Auth would read on its own", () => {
    for (const name of ["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"])
      expect(refusal({ ...valid, [name]: "x" })).toContain(`${name} is set`)
    expect(refusal({ ...valid, AUTH_SECRET: "x" })).toContain("AUTH_SECRET is set")
  })

  it("reads the trusted proxies and refuses one that is not an address or range", () => {
    expect(loadConfig({ ...valid, ADIUTOR_TRUSTED_PROXIES: "192.0.2.10, 198.51.100.0/24" }).trustedProxies).toEqual([
      "192.0.2.10",
      "198.51.100.0/24",
    ])
    expect(refusal({ ...valid, ADIUTOR_TRUSTED_PROXIES: "traefik" })).toContain("ADIUTOR_TRUSTED_PROXIES")
  })

  it("refuses a public URL that is not http or https", () => {
    expect(refusal({ ...valid, ADIUTOR_PUBLIC_URL: "not a url" })).toContain("ADIUTOR_PUBLIC_URL")
    expect(refusal({ ...valid, ADIUTOR_PUBLIC_URL: "ftp://adiutor.example.com" })).toContain("ADIUTOR_PUBLIC_URL")
  })

  it("refuses a database URL that is not PostgreSQL and never prints it", () => {
    const message = refusal({ ...valid, DATABASE_URL: "mysql://user:secret@db/adiutor" })
    expect(message).toContain("DATABASE_URL must be a postgres:// URL")
    expect(message).not.toContain("secret@")
  })

  it("refuses a bad port", () => {
    expect(refusal({ ...valid, PORT: "http" })).toContain("PORT")
  })

  describe("owner settings the environment overrides, per field", () => {
    const botToken = testBotToken()

    it("sets nothing without the variables, or with empty ones", () => {
      expect(loadConfig({ ...valid, ADIUTOR_TELEGRAM_BOT_TOKEN: "", ADIUTOR_TELEGRAM_CHAT_ID: " " }).overrides).toEqual(
        {},
      )
    })

    it("reads each Telegram field on its own: one without the other is fine", () => {
      expect(loadConfig({ ...valid, ADIUTOR_TELEGRAM_BOT_TOKEN: botToken }).overrides).toEqual({
        telegramBotToken: botToken,
      })
      expect(loadConfig({ ...valid, ADIUTOR_TELEGRAM_CHAT_ID: "-1001" }).overrides).toEqual({ telegramChatId: "-1001" })
      expect(loadConfig({ ...valid, TELEGRAM_API_URL: "http://stand-in:8099/" }).telegramApiUrl).toBe(
        "http://stand-in:8099",
      )
    })

    it("refuses a malformed value by its name, never printing it", () => {
      const badToken = `${botToken}!`
      const message = refusal({ ...valid, ADIUTOR_TELEGRAM_BOT_TOKEN: badToken })
      expect(message).toContain("ADIUTOR_TELEGRAM_BOT_TOKEN does not look like a bot token")
      expect(message).not.toContain(badToken)
      expect(refusal({ ...valid, ADIUTOR_TELEGRAM_CHAT_ID: "@owner" })).toContain(
        "ADIUTOR_TELEGRAM_CHAT_ID must be a numeric chat id",
      )
      expect(refusal({ ...valid, TELEGRAM_API_URL: "ftp://example.com" })).toContain("TELEGRAM_API_URL")
    })

    it("reads the private domains, normalized, and refuses one that is not a domain", () => {
      expect(
        loadConfig({ ...valid, ADIUTOR_PRIVATE_DOMAINS: " Corp.Example , .internal.test.,," }).overrides.privateDomains,
      ).toEqual(["corp.example", "internal.test"])
      expect(refusal({ ...valid, ADIUTOR_PRIVATE_DOMAINS: "corp.example, not a domain" })).toContain(
        "ADIUTOR_PRIVATE_DOMAINS",
      )
    })
  })
})
