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

  it("refuses a bad port", () => {
    expect(refusal({ ...valid, PORT: "http" })).toContain("PORT")
  })
})
