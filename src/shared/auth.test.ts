import { describe, expect, it } from "vitest"
import { z } from "zod"
import { authenticatorUri, isValidUsername, ownerEmail, USERNAME_MAX, usernameSchema } from "./auth.ts"

// The username rule the setup form and the username plugin's usernameValidator share, and the synthetic e-mail it
// makes. Better Auth's sign-up checks the e-mail with zod's z.email() (the same zod version as Mikud's).

const WORD = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_"

/** A deterministic stream of names the rule allows: words of WORD joined by single dots, 3 to 30 characters. */
function* allowedNames(count: number): Generator<string> {
  let seed = 20_261_102
  const next = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
    return seed % n
  }
  for (let i = 0; i < count; i++) {
    const length = 3 + next(USERNAME_MAX - 2)
    let name = ""
    while (name.length < length) {
      const canDot = name.length > 0 && !name.endsWith(".") && name.length < length - 1
      name += canDot && next(4) === 0 ? "." : (WORD[next(WORD.length)] ?? "a")
    }
    yield name
  }
}

describe("the username rule", () => {
  it.each(["A_b.C", "owner.name", "abc", "a.b.c", "___", "_._", "Owner_2", "x".repeat(USERNAME_MAX)])(
    "allows %s",
    (name) => {
      expect(isValidUsername(name)).toBe(true)
      expect(usernameSchema.safeParse(name).success).toBe(true)
    },
  )

  it.each([
    ".alice",
    "alice.",
    "a..b",
    "ab",
    "owner-name",
    "owner name",
    " owner",
    "x".repeat(USERNAME_MAX + 1),
    `caf${String.fromCharCode(0xe9)}`,
  ])("refuses %s in the form", (name) => {
    expect(usernameSchema.safeParse(name).success).toBe(false)
  })

  it.each([".alice", "alice.", "a..b", "a.", ".", "a-b"])("refuses %s in the plugin's validator", (name) => {
    expect(isValidUsername(name)).toBe(false)
  })
})

describe("the synthetic e-mail", () => {
  it("is the lowercased username at mikud.local", () => {
    expect(ownerEmail("Owner.Name")).toBe("owner.name@mikud.local")
    expect(ownerEmail("A_b.C")).toBe("a_b.c@mikud.local")
  })

  it("passes Better Auth's e-mail check for every name the rule allows", () => {
    const email = z.email()
    const names = [...allowedNames(5_000), "A_b.C", "owner.name", "___", "_._", "x".repeat(USERNAME_MAX)]
    expect(names.some((n) => n.includes("."))).toBe(true)
    expect(names.some((n) => n.startsWith("_") || n.endsWith("_"))).toBe(true)
    for (const name of names) {
      expect(usernameSchema.safeParse(name).success, name).toBe(true)
      expect(email.safeParse(ownerEmail(name)).success, name).toBe(true)
    }
  })
})

describe("the authenticator link", () => {
  // A new base32 secret per run: no working value in the repository.
  const secret = Array.from(
    { length: 32 },
    () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(Math.random() * 32)],
  ).join("")
  // The shape of Better Auth's totpURI (@better-auth/utils otp: encodeURIComponent on each part, URLSearchParams).
  const betterAuth = (issuer: string, account: string) =>
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`

  it.each(["shlomi", "owner.name", "a_b.c", "___"])("names the account %s, not the synthetic e-mail", (name) => {
    const uri = authenticatorUri(betterAuth("Mikud", ownerEmail(name)))
    expect(uri).toBe(`otpauth://totp/Mikud:${name}?secret=${secret}&issuer=Mikud&digits=6&period=30`)
    expect(new URL(uri).searchParams.get("secret")).toBe(secret)
  })

  it("keeps the query exactly as written, in its order", () => {
    const query = `?period=30&digits=6&issuer=Mikud&algorithm=SHA1&secret=${secret}`
    expect(authenticatorUri(`otpauth://totp/Mikud:owner%40mikud.local${query}`)).toBe(
      `otpauth://totp/Mikud:owner${query}`,
    )
  })

  it("keeps an encoded issuer as it is", () => {
    expect(authenticatorUri(betterAuth("Mikud Dev: home", "owner@mikud.local"))).toBe(
      `otpauth://totp/Mikud%20Dev%3A%20home:owner?secret=${secret}&issuer=Mikud%20Dev%3A%20home&digits=6&period=30`,
    )
  })

  it.each([
    ["another e-mail", betterAuth("Mikud", "owner@example.com")],
    ["no account name before the domain", betterAuth("Mikud", "@mikud.local")],
    ["no issuer prefix", `otpauth://totp/owner%40mikud.local?secret=${secret}`],
    ["an encoded separator only", `otpauth://totp/Mikud%3Aowner%40mikud.local?secret=${secret}`],
    ["a broken escape", `otpauth://totp/Mikud:owner%E0%40mikud.local?secret=${secret}`],
    ["HOTP", `otpauth://hotp/Mikud:owner%40mikud.local?secret=${secret}&counter=0`],
    ["not a link", "Mikud:owner@mikud.local"],
  ])("leaves %s unchanged", (_case, uri) => {
    expect(authenticatorUri(uri)).toBe(uri)
  })
})
