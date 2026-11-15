import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { PASSKEY_MAX } from "../../shared/auth.ts"
import { createApp } from "../app.ts"
import { resetOwnerPassword } from "../auth/recovery.ts"
import { audit, authPasskey, authSession, authUser } from "../db/schema.ts"
import { type TestCoreOptions, testAuthBase, testCore } from "../testing/app.ts"
import { TEST_ORIGIN, TestBrowser } from "../testing/browser.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import { SoftwarePasskey } from "../testing/passkey.ts"

// Passkeys through the app, against the pinned @better-auth/passkey plugin and PostgreSQL, with a software
// authenticator: a passkey is a whole sign-in on its own, it must verify the person (UV), it is added only by a
// signed-in owner with two-factor on, and every change to one leaves an audit row.

let t: TestDatabase
let app: ReturnType<typeof createApp>
let lastIp = 0

/** A documentation address of its own for each browser: Better Auth keys its rate limits on X-Forwarded-For. */
const nextIp = () => `192.0.2.${(lastIp++ % 250) + 1}`
const browser = (ip = nextIp()) =>
  new TestBrowser((request) => app.fetch(request), TEST_ORIGIN, { "x-forwarded-for": ip })

function build(options: Partial<TestCoreOptions> = {}) {
  const core = testCore(t, { config: { publicUrl: new URL(TEST_ORIGIN), version: "test" }, ...options })
  app = createApp({ checkDatabase: async () => true, core })
}

const passkeys = () => t.ctx.db.select().from(authPasskey)
const rows = async (action: string) => t.ctx.db.select().from(audit).where(eq(audit.action, action))
const v1 = (b: TestBrowser) => b.call("GET", "/api/v1/session")

/** A signed-in owner with two-factor on. */
async function enrolled(): Promise<TestBrowser> {
  const b = browser()
  await b.owner()
  return b
}

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  t = await createTestDatabase("passkey")
})
afterAll(async () => {
  await t?.close()
  vi.restoreAllMocks()
})
beforeEach(async () => {
  await t.reset()
  build()
})

describe("adding a passkey", () => {
  it("needs two-factor on: the owner right after setup cannot add one", async () => {
    const b = browser()
    expect((await b.setup()).status).toBe(200)
    const key = new SoftwarePasskey(TEST_ORIGIN)
    const answer = await key.register(b)
    expect(answer.status).toBe(403)
    expect(answer.json.code).toBe("TOTP_REQUIRED")
    // Straight to the second step, with a body a browser could have built: refused as well.
    const direct = await b.call("POST", "/api/auth/passkey/verify-registration", {
      body: { name: "x", response: key.attestation({ challenge: "AAAA", rp: { id: "127.0.0.1" } }) },
    })
    expect(direct.json.code).toBe("TOTP_REQUIRED")
    expect(await passkeys()).toHaveLength(0)
  })

  it("is refused without a session", async () => {
    const answer = await new SoftwarePasskey(TEST_ORIGIN).register(browser())
    expect(answer.status).toBe(403)
    expect(answer.json.code).toBe("TOTP_REQUIRED")
    await enrolled()
    expect((await new SoftwarePasskey(TEST_ORIGIN).register(browser())).status).toBe(401)
    expect(await passkeys()).toHaveLength(0)
  })

  it("stores it with its name, lists it and records the change", async () => {
    const b = await enrolled()
    const added = await new SoftwarePasskey(TEST_ORIGIN).register(b, "  Work laptop ")
    expect(added.status).toBe(200)
    const listed = await b.call("GET", "/api/auth/passkey/list-user-passkeys")
    expect(listed.json).toHaveLength(1)
    expect(listed.json[0].name).toBe("Work laptop")
    const [row] = await rows("account.passkey_add")
    expect(row?.after).toEqual({ name: "Work laptop" })
    expect(row?.entityType).toBe("account")
  })

  it("never signs in on its own: createSession is refused", async () => {
    const b = await enrolled()
    const key = new SoftwarePasskey(TEST_ORIGIN)
    const creation = await b.call("GET", "/api/auth/passkey/generate-register-options")
    const answer = await b.call("POST", "/api/auth/passkey/verify-registration", {
      body: { name: "laptop", createSession: true, response: key.attestation(creation.json) },
    })
    expect(answer.status).toBe(400)
    expect(answer.json.code).toBe("PASSKEY_SESSION_UNSUPPORTED")
    expect(await passkeys()).toHaveLength(0)
  })

  it("needs a name of 1 to 32 characters", async () => {
    const b = await enrolled()
    for (const name of ["", "   ", "x".repeat(33)]) {
      const answer = await new SoftwarePasskey(TEST_ORIGIN).register(b, name)
      expect(answer.json.code).toBe("INVALID_PASSKEY_NAME")
    }
    expect(await passkeys()).toHaveLength(0)
  })

  it("refuses one that did not verify the person (no UV), and records nothing", async () => {
    const b = await enrolled()
    const answer = await new SoftwarePasskey(TEST_ORIGIN).register(b, "no pin", { uv: false })
    expect(answer.status).toBe(400)
    expect(await passkeys()).toHaveLength(0)
    expect(await rows("account.passkey_add")).toHaveLength(0)
  })

  it("refuses a response for another site or another challenge", async () => {
    const b = await enrolled()
    expect((await new SoftwarePasskey(TEST_ORIGIN).register(b, "x", { origin: "https://evil.example" })).status).toBe(
      400,
    )
    expect((await new SoftwarePasskey(TEST_ORIGIN).register(b, "x", { challenge: "AAAAAAAAAAAAAAAA" })).status).toBe(
      400,
    )
    expect(await passkeys()).toHaveLength(0)
  })

  it(`stops at ${PASSKEY_MAX} passkeys`, async () => {
    const b = await enrolled()
    const [owner] = await t.ctx.db.select({ id: authUser.id }).from(authUser)
    await t.ctx.db.insert(authPasskey).values(
      Array.from({ length: PASSKEY_MAX }, (_, i) => ({
        id: randomUUID(),
        name: `key ${i}`,
        publicKey: "x",
        userId: owner?.id ?? "",
        credentialID: randomUUID(),
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      })),
    )
    const answer = await new SoftwarePasskey(TEST_ORIGIN).register(b)
    expect(answer.status).toBe(403)
    expect(answer.json.code).toBe("PASSKEY_LIMIT")
    expect(await passkeys()).toHaveLength(PASSKEY_MAX)
  })

  it("refuses the request when its audit row cannot be written", async () => {
    const b = await enrolled()
    await t.ctx.db.execute(
      "alter table audit add constraint test_refuse check (action <> 'account.passkey_add') not valid",
    )
    try {
      expect((await new SoftwarePasskey(TEST_ORIGIN).register(b)).status).toBeGreaterThanOrEqual(400)
      expect(await passkeys()).toHaveLength(0)
    } finally {
      await t.ctx.db.execute("alter table audit drop constraint if exists test_refuse")
    }
  })
})

describe("signing in with a passkey", () => {
  it("is a whole sign-in: no password, no code, a session /api/v1 accepts, and an audit row", async () => {
    const key = new SoftwarePasskey(TEST_ORIGIN)
    expect((await key.register(await enrolled())).status).toBe(200)
    const b = browser()
    const answer = await key.signIn(b)
    expect(answer.status).toBe(200)
    expect(answer.json.session).toBeTruthy()
    expect((await v1(b)).status).toBe(200)
    const signIns = await rows("session.sign_in")
    expect(signIns.at(-1)?.after).toEqual({ stage: "passkey", method: "passkey" })
  })

  it("refuses an assertion without user verification", async () => {
    const key = new SoftwarePasskey(TEST_ORIGIN)
    await key.register(await enrolled())
    const b = browser()
    expect((await key.signIn(b, { uv: false })).status).toBeGreaterThanOrEqual(400)
    expect((await v1(b)).status).toBe(401)
  })

  it("refuses another challenge, a used challenge, another site and a registration challenge", async () => {
    const key = new SoftwarePasskey(TEST_ORIGIN)
    const owner = await enrolled()
    await key.register(owner)
    expect((await key.signIn(browser(), { challenge: "AAAAAAAAAAAAAAAA" })).status).toBeGreaterThanOrEqual(400)
    expect((await key.signIn(browser(), { origin: "https://evil.example" })).status).toBeGreaterThanOrEqual(400)

    // A challenge counts once: the same answer sent again finds no challenge.
    const b = browser()
    const request = await b.call("GET", "/api/auth/passkey/generate-authenticate-options")
    const response = key.assertion(request.json)
    const challengeCookies = new Map(b.cookies)
    expect((await b.call("POST", "/api/auth/passkey/verify-authentication", { body: { response } })).status).toBe(200)
    const replay = browser()
    for (const [name, value] of challengeCookies) replay.cookies.set(name, value)
    const again = await replay.call("POST", "/api/auth/passkey/verify-authentication", { body: { response } })
    expect(again.status).toBe(400)

    // The challenge of a registration does not sign in.
    const creation = await owner.call("GET", "/api/auth/passkey/generate-register-options")
    const crossed = await owner.call("POST", "/api/auth/passkey/verify-authentication", {
      body: { response: key.assertion({ challenge: creation.json.challenge, rpId: "127.0.0.1" }) },
    })
    expect(crossed.status).toBe(400)
  })

  it("works with a synced passkey whose counter stays 0, and with a counter above 2^31", async () => {
    const synced = new SoftwarePasskey(TEST_ORIGIN, "zero")
    const high = new SoftwarePasskey(TEST_ORIGIN, 3_000_000_000)
    const owner = await enrolled()
    await synced.register(owner, "synced")
    await high.register(owner, "high")
    for (let i = 0; i < 2; i++) {
      expect((await synced.signIn(browser())).status).toBe(200)
      expect((await high.signIn(browser())).status).toBe(200)
    }
    const stored = await passkeys()
    expect(stored.find((p) => p.name === "high")?.counter).toBeGreaterThan(3_000_000_000)
  })

  it("is limited to 5 attempts per 5 minutes per address", async () => {
    const key = new SoftwarePasskey(TEST_ORIGIN)
    await key.register(await enrolled())
    const ip = nextIp()
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await key.signIn(browser(ip), { uv: false })).status)
    expect(statuses.at(-1)).toBe(429)
  })

  it("survives the server's password reset, as the owner decided (two-factor stays as well)", async () => {
    const key = new SoftwarePasskey(TEST_ORIGIN)
    await key.register(await enrolled())
    await resetOwnerPassword({ ...testAuthBase(t, new URL(TEST_ORIGIN)), sessionIdleDays: 30 })
    expect(await t.ctx.db.select().from(authSession)).toHaveLength(0)
    expect((await key.signIn(browser())).status).toBe(200)
  })
})

describe("managing passkeys", () => {
  it("renames and removes one with audit rows; a removed passkey no longer signs in", async () => {
    const key = new SoftwarePasskey(TEST_ORIGIN)
    const b = await enrolled()
    await key.register(b, "old name")
    const [stored] = await passkeys()
    const id = stored?.id ?? ""
    expect((await b.call("POST", "/api/auth/passkey/update-passkey", { body: { id, name: "new name" } })).status).toBe(
      200,
    )
    expect(
      (await b.call("POST", "/api/auth/passkey/update-passkey", { body: { id, name: "x".repeat(33) } })).json.code,
    ).toBe("INVALID_PASSKEY_NAME")
    expect((await b.call("POST", "/api/auth/passkey/delete-passkey", { body: { id } })).status).toBe(200)
    expect((await rows("account.passkey_rename")).map((r) => [r.entityId, r.after])).toEqual([
      [id, { name: "new name" }],
    ])
    expect((await rows("account.passkey_delete")).map((r) => [r.entityId, r.after])).toEqual([
      [id, { name: "new name" }],
    ])
    expect(await passkeys()).toHaveLength(0)
    expect((await key.signIn(browser())).status).toBe(401)
    // A passkey that does not exist: the plugin's answer, no row.
    expect((await b.call("POST", "/api/auth/passkey/delete-passkey", { body: { id } })).status).toBe(404)
    expect(await rows("account.passkey_delete")).toHaveLength(1)
  })

  it("refuses an Authorization header on every passkey route, with or without a cookie", async () => {
    const b = await enrolled()
    const anonymous = browser()
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/auth/passkey/generate-register-options"],
      ["POST", "/api/auth/passkey/verify-registration", { response: {} }],
      ["GET", "/api/auth/passkey/list-user-passkeys"],
      ["POST", "/api/auth/passkey/update-passkey", { id: "x", name: "y" }],
      ["POST", "/api/auth/passkey/delete-passkey", { id: "x" }],
      ["GET", "/api/auth/passkey/generate-authenticate-options"],
      ["POST", "/api/auth/passkey/verify-authentication", { response: {} }],
    ]
    for (const who of [b, anonymous])
      for (const [method, path, body] of routes) {
        const answer = await who.call(method, path, { body, headers: { authorization: "Bearer anything" } })
        expect([path, answer.status, answer.json?.code]).toEqual([path, 403, "AUTHORIZATION_NOT_ALLOWED"])
      }
  })
})

describe("a gap the owner accepted", () => {
  it("removing a passkey while a sign-in with it is past its signature check still lets that sign-in finish", async () => {
    // Library gap: the plugin reads the passkey, checks the signature and then creates the session without reading it
    // again. The documented authentication.afterVerification pauses the sign-in at that point. Adiutor adds no lock;
    // the Account page tells the owner to sign out the other browsers after removing a lost passkey.
    let reached = () => {}
    const atPause = new Promise<void>((resolve) => {
      reached = resolve
    })
    let resume = () => {}
    const pause = new Promise<void>((resolve) => {
      resume = resolve
    })
    build({
      auth: {
        afterPasskeyVerified: async () => {
          reached()
          await pause
        },
      },
    })
    const key = new SoftwarePasskey(TEST_ORIGIN)
    const owner = await enrolled()
    await key.register(owner)
    const [stored] = await passkeys()
    const thief = browser()
    const signingIn = key.signIn(thief)
    await atPause
    const removed = await owner.call("POST", "/api/auth/passkey/delete-passkey", { body: { id: stored?.id } })
    expect(removed.status).toBe(200)
    expect(await passkeys()).toHaveLength(0)
    resume()
    expect((await signingIn).status).toBe(200)
    expect((await v1(thief)).status).toBe(200)
  })
})
