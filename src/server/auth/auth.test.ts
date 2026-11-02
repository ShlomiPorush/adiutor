import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { describe, expect, it } from "vitest"
import * as schema from "../db/schema.ts"
import { createSecretScanner } from "../services/secrets.ts"
import { ALLOWED_PATHS, createAuth, OTP_PATHS, TRUST_DEVICE_PATHS } from "./auth.ts"

// The allow-list names Better Auth's route patterns. A route renamed or removed by an update would leave a dead entry
// (and the UI calling a closed route): every listed path must exist on the pinned version.

/** Never connects: building the instance does not touch the database. */
const db = drizzle(postgres("postgres://nobody@127.0.0.1:1/none", { max: 1 }), { schema })

function routePaths(): Set<string> {
  const auth = createAuth({
    ctx: { db, secrets: createSecretScanner(), clock: () => new Date() },
    secrets: [{ version: 1, value: "r".repeat(32) }],
    publicUrl: new URL("https://mikud.example.com"),
    trustedProxies: [],
    sessionIdleDays: 30,
    otpViaTelegram: true,
    sendOtp: async () => {},
  })
  return new Set(Object.values(auth.api).map((endpoint) => (endpoint as { path?: string }).path ?? ""))
}

describe("the routes Mikud opens", () => {
  const paths = routePaths()

  it.each([...ALLOWED_PATHS, ...OTP_PATHS])("%s exists in Better Auth", (path) => {
    expect(paths.has(path)).toBe(true)
  })

  it.each([...TRUST_DEVICE_PATHS])("%s, where trustDevice is refused, exists", (path) => {
    expect(paths.has(path)).toBe(true)
  })

  it("leaves the reset, e-mail sign-in and account routes closed", () => {
    for (const path of ["/request-password-reset", "/reset-password", "/sign-in/email", "/update-user", "/list-accounts"])
      expect([path, (ALLOWED_PATHS as readonly string[]).includes(path)]).toEqual([path, false])
  })
})
