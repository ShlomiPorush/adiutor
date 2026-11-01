import { inspect } from "node:util"
import { count, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp } from "../app.ts"
import { createAuth, passwordHasher } from "../auth/auth.ts"
import { createDatabase, type Database } from "../db/client.ts"
import { audit, authAccount, authSession, authTwoFactor, authUser, authVerification, settings } from "../db/schema.ts"
import { changePassword, resetPassword } from "../services/account.ts"
import { AUTH_LOCK_KEY } from "../services/context.ts"
import { sweepSessions } from "../services/session-policy.ts"
import { TEST_AUTH_SECRET, testCore } from "../testing/app.ts"
import { TEST_ORIGIN, TEST_PASSWORD, TestBrowser } from "../testing/browser.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import { totp, wrongTotp } from "../testing/totp.ts"
import { RateLimiter } from "./auth.ts"
import type { AuthTestHooks } from "./auth-guard.ts"

const OWNER = "owner-token-for-tests-only-000000000000"
const AGENT = "agent-token-for-tests-only-000000000000"
const DAY = 86_400_000

let t: TestDatabase
let app: ReturnType<typeof createApp>
let core: ReturnType<typeof testCore>

function build(lockAuth?: Database["lockAuth"], authTestHooks?: AuthTestHooks, beforeUserUpdate?: () => Promise<void>) {
  core = testCore(t, {
    config: { ownerToken: OWNER, agentToken: AGENT, publicUrl: new URL(TEST_ORIGIN), version: "test" },
    limiter: new RateLimiter(10, 60_000),
    attempts: new RateLimiter(5, 300_000),
    clientIp: (c) => c.req.header("x-test-ip") ?? "client",
  })
  if (lockAuth) core.lockAuth = lockAuth
  core.authTestHooks = authTestHooks
  if (beforeUserUpdate)
    core.auth = createAuth({
      db: t.ctx.db,
      secret: TEST_AUTH_SECRET,
      publicUrl: new URL(TEST_ORIGIN),
      beforeUserUpdate,
    })
  app = createApp({ checkDatabase: async () => true, core })
}

const browser = (ip = "client") => new TestBrowser((request) => app.fetch(request), TEST_ORIGIN, { "x-test-ip": ip })

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  t = await createTestDatabase("auth")
})
afterAll(async () => {
  await t?.close()
  vi.restoreAllMocks()
})
beforeEach(async () => {
  await t.reset()
  build()
})

const sessions = async () => t.ctx.db.select().from(authSession)
const liveProved = async () => (await sessions()).filter((s) => s.twoFactorAt && !s.endedReason)
const actions = async () => (await t.ctx.db.select({ action: audit.action }).from(audit)).map((a) => a.action)
const api = (b: TestBrowser, path = "/api/v1/session") => b.call("GET", path)

describe("first run", () => {
  it("creates the owner once, as the username plugin stores it, and signs him in for enrolment", async () => {
    const b = browser()
    expect((await api(b, "/api/setup/status")).json.data).toEqual({ hasUser: false, session: "none" })
    const created = await b.setup("Owner.Name")
    expect([created.status, created.json.data]).toEqual([201, { username: "owner.name", signedIn: true }])
    const [user] = await t.ctx.db.select().from(authUser)
    expect(user).toMatchObject({
      username: "owner.name",
      displayUsername: "Owner.Name",
      email: "owner.name@mikud.local",
      twoFactorEnabled: false,
    })
    const [account] = await t.ctx.db.select().from(authAccount)
    expect(account).toMatchObject({ providerId: "credential", accountId: user?.id, userId: user?.id })
    expect((await api(b, "/api/setup/status")).json.data).toEqual({ hasUser: true, session: "enrol" })
    // Signed in by password only: the app refuses it until TOTP is proved.
    const refused = await api(b)
    expect([refused.status, refused.json.error.code]).toEqual([403, "totp_required"])

    const again = await browser("other").setup("someone")
    expect([again.status, again.json.error.code]).toEqual([409, "already_set_up"])
    expect(await actions()).toEqual(["account.setup", "session.sign_in"])
  })

  it("refuses a setup that does not come from the Mikud page, and a bad name or password", async () => {
    const b = browser()
    expect(
      (
        await b.call("POST", "/api/setup/account", {
          body: { username: "owner", password: TEST_PASSWORD },
          page: false,
        })
      ).status,
    ).toBe(403)
    const evil = await b.call("POST", "/api/setup/account", {
      body: { username: "owner", password: TEST_PASSWORD },
      headers: { origin: "https://evil.example" },
    })
    expect(evil.status).toBe(403)
    for (const body of [
      { username: "ab", password: TEST_PASSWORD },
      { username: " owner", password: TEST_PASSWORD },
      { username: "owner-name", password: TEST_PASSWORD },
      { username: "a".repeat(31), password: TEST_PASSWORD },
      { username: "owner", password: "short" },
      { username: "owner", password: "p".repeat(129) },
    ])
      expect((await browser(JSON.stringify(body)).call("POST", "/api/setup/account", { body })).status).toBe(400)
    expect(await t.ctx.db.select().from(authUser)).toHaveLength(0)
  })

  it("creates one owner when setups race", async () => {
    const answers = await Promise.all(
      ["one", "two", "three", "four", "five"].map((name, i) => browser(`ip${i}`).setup(`owner_${name}`)),
    )
    expect(answers.map((a) => a.status).sort()).toEqual([201, 409, 409, 409, 409])
    const [row] = await t.ctx.db.select({ n: count() }).from(authUser)
    expect(row?.n).toBe(1)
  })
})

describe("TOTP", () => {
  it("is set up with a code, proves the new session, and ends every other session of the owner", async () => {
    const setupTab = browser()
    await setupTab.setup()
    // Another browser signs in with the password before enrolment.
    const early = browser("early")
    expect((await early.passwordSignIn()).status).toBe(200)
    expect((await api(early)).json.error.code).toBe("totp_required")

    const enabled = await setupTab.call("POST", "/api/auth/two-factor/enable", { body: { password: TEST_PASSWORD } })
    expect(enabled.status).toBe(200)
    expect(enabled.json.totpURI).toMatch(/^otpauth:\/\/totp\/Mikud:/)
    expect(enabled.json).not.toHaveProperty("backupCodes")
    const secret = new URL(enabled.json.totpURI).searchParams.get("secret") ?? ""

    // A wrong code keeps the session as it was: no new session, no proof, still refused by the API.
    const before = (await sessions()).map((s) => s.id).sort()
    const wrong = await setupTab.verify(wrongTotp(secret))
    expect(wrong.status).toBe(401)
    expect((await sessions()).map((s) => s.id).sort()).toEqual(before)
    expect((await sessions()).every((s) => s.twoFactorAt === null)).toBe(true)
    expect((await api(setupTab)).json.error.code).toBe("totp_required")

    const right = await setupTab.verify(totp(secret))
    expect(right.status).toBe(200)
    expect((await api(setupTab)).status).toBe(200)
    expect(await liveProved()).toHaveLength(1)
    // The browser signed in before enrolment is ended.
    expect((await api(early)).status).toBe(401)
    expect((await t.ctx.db.select().from(authUser))[0]?.twoFactorEnabled).toBe(true)
    expect(await actions()).toContain("account.totp_enable")

    // Enrolment is over: no second enable, and a proved session cannot verify again.
    expect(
      (await setupTab.call("POST", "/api/auth/two-factor/enable", { body: { password: TEST_PASSWORD } })).status,
    ).toBe(403)
    const twice = await setupTab.verify(totp(secret))
    expect([twice.status, twice.json.code]).toEqual([400, "totp_already_proved"])
  })

  it("marks the current session when enrolment issues no replacement", async () => {
    const b = browser()
    await b.setup()
    const secret = await b.enable()
    // The factor is verified already (as after an earlier enrolment that failed to record), the session is not.
    await t.ctx.db.update(authTwoFactor).set({ verified: true })
    await t.ctx.db.update(authUser).set({ twoFactorEnabled: true })
    const [current] = await sessions()
    expect((await b.verify(totp(secret))).status).toBe(200)
    const after = await sessions()
    expect(after.map((s) => s.id)).toEqual([current?.id])
    expect(after[0]?.twoFactorAt).not.toBeNull()
    expect((await api(b)).status).toBe(200)
  })

  it("signs in with the password and then the code, case-insensitive in the username", async () => {
    const secret = await browser().owner()
    const b = browser("phone")
    const first = await b.passwordSignIn("OWNER.NAME")
    expect([first.status, first.json.twoFactorRedirect]).toEqual([200, true])
    expect(first.setCookies.some((c) => c.includes("session_token=") && !/max-age=0/i.test(c))).toBe(false)
    const count1 = (await sessions()).length

    // A wrong code without a session creates nothing.
    expect((await b.verify(wrongTotp(secret))).status).toBe(401)
    expect((await sessions()).length).toBe(count1)
    expect((await api(b)).status).toBe(401)

    expect((await b.verify(totp(secret))).status).toBe(200)
    expect((await api(b)).json.data.actor).toEqual({ kind: "owner", label: "owner.name" })
    expect(await liveProved()).toHaveLength(2)
    const wrongPassword = await browser("x").passwordSignIn("owner.name", "not the password at all")
    expect(wrongPassword.status).toBe(401)
  })
})

describe("the guard in front of Better Auth", () => {
  it("answers 404 to every route Mikud does not use", async () => {
    const secret = await browser().owner()
    const b = browser("b")
    await b.signIn(secret)
    for (const [method, path] of [
      ["POST", "/api/auth/sign-up/email"],
      ["POST", "/api/auth/sign-in/email"],
      ["GET", "/api/auth/list-sessions"],
      ["POST", "/api/auth/revoke-sessions"],
      ["POST", "/api/auth/revoke-other-sessions"],
      ["POST", "/api/auth/change-password"],
      ["POST", "/api/auth/two-factor/disable"],
      ["POST", "/api/auth/two-factor/generate-backup-codes"],
      ["POST", "/api/auth/two-factor/verify-backup-code"],
      ["POST", "/api/auth/is-username-available"],
      ["GET", "/api/auth/sign-out"],
      ["DELETE", "/api/auth/get-session"],
    ] as const) {
      const res = await b.call(method, path, { body: method === "GET" ? undefined : {} })
      expect([method, path, res.status]).toEqual([method, path, 404])
    }
  })

  it("refuses POSTs without the page's headers, before reading the body, and lets get-session read plainly", async () => {
    const b = browser()
    await b.setup()
    const pages: Record<string, string>[] = [{ origin: "https://evil.example" }, { "x-mikud-request": "0" }]
    for (const headers of pages) {
      const res = await b.call("POST", "/api/auth/sign-in/username", {
        body: { username: "owner.name", password: TEST_PASSWORD },
        headers,
      })
      expect(res.status).toBe(403)
    }
    const bare = await b.call("POST", "/api/auth/sign-out", { page: false })
    expect([bare.status, bare.json.code]).toEqual([403, "forbidden"])
    const session = await b.call("GET", "/api/auth/get-session")
    expect([session.status, session.json.user.username]).toEqual([200, "owner.name"])
  })

  it("refuses remember-me off, trusted devices and other second factors", async () => {
    const secret = await browser().owner()
    const b = browser("b")
    const off = await b.call("POST", "/api/auth/sign-in/username", {
      body: { username: "owner.name", password: TEST_PASSWORD, rememberMe: false },
    })
    expect([off.status, off.json.code]).toEqual([400, "remember_me_unsupported"])
    await b.passwordSignIn()
    const trust = await b.call("POST", "/api/auth/two-factor/verify-totp", {
      body: { code: totp(secret), trustDevice: true },
    })
    expect([trust.status, trust.json.code]).toEqual([400, "trust_device_unsupported"])
  })

  it("limits sign-in and code attempts by socket address; a forged forwarding header changes nothing", async () => {
    await browser().owner()
    for (let i = 0; i < 5; i++)
      expect((await browser("attacker").passwordSignIn("owner.name", "wrong password number one")).status).toBe(401)
    const blocked = await browser("attacker").call("POST", "/api/auth/sign-in/username", {
      body: { username: "owner.name", password: TEST_PASSWORD },
      headers: { "x-forwarded-for": "198.51.100.23", "x-real-ip": "198.51.100.24" },
    })
    expect([blocked.status, blocked.json.code]).toEqual([429, "rate_limited"])
    expect((await browser("someone-else").passwordSignIn()).status).toBe(200)
  })
})

describe("session clocks", () => {
  it("ends a session at its maximum length, says why, and audits it once", async () => {
    const b = browser()
    await b.owner()
    t.clock.travel(30 * DAY + 1000)
    const ended = await api(b)
    expect([ended.status, ended.json.error.code, ended.json.error.reason]).toEqual([401, "session_ended", "max"])
    expect((await api(b)).json.error.reason).toBe("max")
    expect((await b.call("GET", "/api/auth/get-session")).json).toBeNull()
    expect((await actions()).filter((a) => a === "session.end")).toHaveLength(1)
    // Ended sessions are swept a day later.
    t.clock.travel(DAY + 1000)
    expect(await sweepSessions(t.ctx)).toEqual({ ended: 0, removed: 1 })
    expect(await sessions()).toHaveLength(0)
  })

  it("ends an idle session when the owner turned the idle limit on; only reported input counts", async () => {
    const b = browser()
    await b.owner()
    const patched = await b.call("PATCH", "/api/v1/settings", { body: { sessionIdle: true, sessionIdleMinutes: 5 } })
    expect(patched.json.data).toMatchObject({ sessionIdle: true, sessionIdleMinutes: 5, sessionMaxDays: 30 })
    t.clock.travel(4 * 60_000)
    // Polling does not count as activity.
    expect((await api(b)).status).toBe(200)
    const activity = await b.call("POST", "/api/v1/session/activity")
    expect(activity.json.data.clocks.idle).toEqual({ timeoutSec: 300, remainingSec: 300 })
    t.clock.travel(4 * 60_000)
    expect((await api(b)).status).toBe(200)
    t.clock.travel(2 * 60_000)
    const ended = await api(b)
    expect([ended.status, ended.json.error.reason]).toEqual([401, "idle"])
    expect((await b.call("PATCH", "/api/v1/settings", { body: { sessionMaxDays: 91 } })).status).toBe(401)
  })

  it("refuses clock settings out of range", async () => {
    const b = browser()
    await b.owner()
    for (const body of [
      { sessionMaxDays: 0 },
      { sessionMaxDays: 91 },
      { sessionIdleMinutes: 4 },
      { sessionIdleMinutes: 1441 },
    ])
      expect((await b.call("PATCH", "/api/v1/settings", { body })).status).toBe(400)
  })
})

describe("account", () => {
  it("signs out and audits it; the old cookie is refused", async () => {
    const b = browser()
    await b.owner()
    const cookie = b.cookieHeader
    expect((await b.call("POST", "/api/auth/sign-out")).status).toBe(200)
    expect((await app.request("/api/v1/session", { headers: { cookie } })).status).toBe(401)
    expect(await actions()).toContain("session.sign_out")
  })

  it("lists sessions, ends the others, then all of them", async () => {
    const secret = await browser().owner()
    const desk = browser("desk")
    await desk.signIn(secret)
    const phone = browser("phone")
    await phone.signIn(secret)
    const list = await desk.call("GET", "/api/v1/account/sessions")
    expect(list.json.data.username).toBe("owner.name")
    expect(list.json.data.sessions).toHaveLength(3)
    expect(list.json.data.sessions[0]).toMatchObject({ current: true })
    expect(JSON.stringify(list.json)).not.toMatch(/token/i)
    expect((await desk.call("POST", "/api/v1/account/sessions/end-others", { page: false })).status).toBe(403)
    expect((await desk.call("POST", "/api/v1/account/sessions/end-others")).json.data).toEqual({ ended: 2 })
    expect((await api(phone)).status).toBe(401)
    expect((await desk.call("POST", "/api/v1/account/sessions/end-all")).json.data).toEqual({ ended: 1 })
    expect((await api(desk)).status).toBe(401)
    expect(await actions()).toEqual(expect.arrayContaining(["session.end_others", "session.end_all"]))
  })

  it("changes the password, keeps this session working and ends the others", async () => {
    const secret = await browser().owner()
    const b = browser("b")
    await b.signIn(secret)
    const other = browser("other")
    await other.signIn(secret)
    const before = (await sessions()).find((s) => s.token && b.cookieHeader.includes(s.token))
    const wrong = await b.call("POST", "/api/v1/account/password", {
      body: { currentPassword: "not the password", newPassword: "a brand new passphrase" },
    })
    expect([wrong.status, wrong.json.error.code]).toEqual([400, "wrong_password"])
    const changed = await b.call("POST", "/api/v1/account/password", {
      body: { currentPassword: TEST_PASSWORD, newPassword: "a brand new passphrase" },
    })
    expect(changed.json.data).toEqual({ endedSessions: 2 })
    // This session goes on without signing in again, with its proof and clocks unchanged.
    expect((await api(b)).status).toBe(200)
    const after = (await sessions()).find((s) => s.id === before?.id)
    expect(after?.twoFactorAt?.getTime()).toBe(before?.twoFactorAt?.getTime())
    expect(after?.authenticatedAt.getTime()).toBe(before?.authenticatedAt.getTime())
    expect((await api(other)).status).toBe(401)
    expect((await browser("old").passwordSignIn()).status).toBe(401)
    expect((await browser("new").passwordSignIn("owner.name", "a brand new passphrase")).json.twoFactorRedirect).toBe(
      true,
    )
    expect(await actions()).toContain("account.password_change")
  })
})

describe("recovery CLI", () => {
  it("sets a new password, removes TOTP and every session and challenge, audited as the CLI", async () => {
    const secret = await browser().owner()
    // A pending sign-in challenge (two verification rows) when the reset runs.
    const pending = browser("pending")
    await pending.passwordSignIn()
    expect(
      (await t.ctx.db.select().from(authVerification))
        .map((v) => v.identifier.replace(/[A-Za-z0-9_-]{20}$/, "*"))
        .sort(),
    ).toEqual(["2fa-*", "2fa-attempts-2fa-*"])

    const result = await resetPassword(t.ctx, await passwordHasher(core.auth))
    expect(result?.username).toBe("owner.name")
    expect(await sessions()).toHaveLength(0)
    expect(await t.ctx.db.select().from(authTwoFactor)).toHaveLength(0)
    expect(await t.ctx.db.select().from(authVerification)).toHaveLength(0)
    expect((await pending.verify(totp(secret))).status).toBe(401)
    const [row] = await t.ctx.db.select().from(audit).where(eq(audit.action, "account.password_reset"))
    expect(row).toMatchObject({ actorKind: "system", actorLabel: "cli", source: "cli" })
    expect(JSON.stringify(row)).not.toContain(result?.password ?? "-")

    // The new password signs in to enrolment again.
    const b = browser("after")
    const signed = await b.passwordSignIn("owner.name", result?.password)
    expect(signed.json.twoFactorRedirect).toBeUndefined()
    expect((await api(b)).json.error.code).toBe("totp_required")
    expect((await api(b, "/api/setup/status")).json.data).toEqual({ hasUser: true, session: "enrol" })
    const newSecret = await b.enable(result?.password)
    expect((await b.verify(totp(newSecret))).status).toBe(200)
    expect((await api(b)).status).toBe(200)
  })

  it("answers null when there is no owner", async () => {
    expect(await resetPassword(t.ctx, await passwordHasher(core.auth))).toBeNull()
  })
})

describe("the auth lock", () => {
  /** A held lock: the change and the reset each wait for the other on AUTH_LOCK_KEY. */
  function gate() {
    let open = () => {}
    const opened = new Promise<void>((resolve) => {
      open = resolve
    })
    let reached = () => {}
    const at = new Promise<void>((resolve) => {
      reached = resolve
    })
    return { open, opened, reached, at }
  }

  it("refuses a password change when the reset takes the lock first", async () => {
    const b = browser()
    await b.owner()
    const [session] = await liveProved()
    const hasher = await passwordHasher(core.auth)
    const g = gate()
    const reset = resetPassword(t.ctx, hasher, {
      afterLock: async () => {
        g.reached()
        await g.opened
      },
    })
    await g.at
    const change = changePassword(t.ctx, hasher, session?.id ?? "", {
      currentPassword: TEST_PASSWORD,
      newPassword: "a brand new passphrase",
    })
    g.open()
    const done = await reset
    // The session is gone with the reset, so the change is refused; the reset password stays.
    await expect(change).rejects.toMatchObject({ code: "unauthorized" })
    expect((await browser("x").passwordSignIn("owner.name", done?.password)).status).toBe(200)
  })

  it("lets the reset win when the password change takes the lock first", async () => {
    const b = browser()
    await b.owner()
    const [session] = await liveProved()
    const hasher = await passwordHasher(core.auth)
    const g = gate()
    const change = changePassword(
      t.ctx,
      hasher,
      session?.id ?? "",
      { currentPassword: TEST_PASSWORD, newPassword: "a brand new passphrase" },
      {
        afterRead: async () => {
          g.reached()
          await g.opened
        },
      },
    )
    await g.at
    let resetDone = false
    const reset = resetPassword(t.ctx, hasher).then((r) => {
      resetDone = true
      return r
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(resetDone).toBe(false)
    g.open()
    await change
    const done = await reset
    expect((await browser("x").passwordSignIn("owner.name", "a brand new passphrase")).status).toBe(401)
    expect((await browser("y").passwordSignIn("owner.name", done?.password)).status).toBe(200)
  })

  it("makes a sign-in wait while the lock is held, without starving the pool, and releases it after", async () => {
    const secret = await browser().owner()
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked = () => {}
    const holding = new Promise<void>((resolve) => {
      locked = resolve
    })
    const holder = t.ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(AUTH_LOCK_KEY))})`)
      locked()
      await held
    })
    await holding
    // More waiting sign-ins than the pool has connections.
    const waiting = Array.from({ length: 12 }, (_, i) => browser(`w${i}`).passwordSignIn())
    await new Promise((resolve) => setTimeout(resolve, 300))
    const started = Date.now()
    const read = await app.request("/api/v1/projects", { headers: { authorization: `Bearer ${OWNER}` } })
    expect(read.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(2_000)
    release()
    await holder
    // The attempts limiter allows five per address; each waiting browser has its own.
    expect((await Promise.all(waiting)).every((a) => a.status === 200)).toBe(true)
    const left = await t.ctx.db.execute(
      sql`select 1 from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database())`,
    )
    expect([...left]).toHaveLength(0)
    expect(secret).toBeTruthy()
  })

  it("records a sign-in without taking the lock again, so it never waits for its own request", async () => {
    const secret = await browser().owner()
    const b = browser("b")
    await b.passwordSignIn()
    const started = Date.now()
    expect((await b.verify(totp(secret))).status).toBe(200)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it("answers busy when the lock is not free in time", async () => {
    const quick = createDatabase(t.url, { authLockTimeoutMs: 300 })
    try {
      build(quick.lockAuth)
      await browser().owner()
      const holder = (await quick.lockAuth()).release
      try {
        // A request of this process waits its turn behind the holder and gives up after the timeout.
        const res = await browser("b").passwordSignIn()
        expect([res.status, res.json.code]).toEqual([503, "busy"])
      } finally {
        await holder()
      }
    } finally {
      await quick.close()
    }
  })
})

describe("failing closed", () => {
  /** Makes the audit insert of one action fail, as a broken audit table would. */
  async function breakAudit(action: string) {
    await t.ctx.db.execute(
      sql.raw(`alter table audit add constraint test_no_audit check (action <> '${action}') not valid`),
    )
  }
  async function mendAudit() {
    await t.ctx.db.execute(sql`alter table audit drop constraint if exists test_no_audit`)
  }
  beforeEach(mendAudit)

  it("leaves no session when a sign-in cannot be audited, and the factor still works", async () => {
    const secret = await browser().owner()
    await breakAudit("session.sign_in")
    const b = browser("b")
    await b.passwordSignIn()
    const proved = (await liveProved()).length
    const res = await b.verify(totp(secret))
    expect([res.status, res.json.code]).toEqual([500, "internal_error"])
    expect(res.setCookies.filter((c) => c.includes("session_token=") && !/max-age=0/i.test(c))).toEqual([])
    expect(res.setCookies.some((c) => /session_token=;.*max-age=0/i.test(c))).toBe(true)
    expect((await liveProved()).length).toBe(proved)
    expect(await t.ctx.db.select().from(authVerification)).toHaveLength(0)
    expect((await api(b)).status).toBe(401)
    await mendAudit()
    expect((await t.ctx.db.select().from(authUser))[0]?.twoFactorEnabled).toBe(true)
    await browser("c").signIn(secret)
  })

  it("leaves no session when enrolment cannot be audited; the factor and twoFactorEnabled agree", async () => {
    const b = browser()
    await b.setup()
    const secret = await b.enable()
    await breakAudit("account.totp_enable")
    const res = await b.verify(totp(secret))
    expect(res.status).toBe(500)
    expect(await liveProved()).toHaveLength(0)
    const [user] = await t.ctx.db.select().from(authUser)
    const [factor] = await t.ctx.db.select().from(authTwoFactor)
    expect([user?.twoFactorEnabled, factor?.verified]).toEqual([true, true])
    await mendAudit()
    await browser("again").signIn(secret)
  })

  it("leaves no session when a password-only sign-in cannot be audited", async () => {
    await browser().setup()
    await breakAudit("session.sign_in")
    const before = (await sessions()).length
    const res = await browser("b").passwordSignIn()
    expect(res.status).toBe(500)
    expect((await sessions()).length).toBe(before)
  })

  it("still signs out when the sign-out cannot be audited", async () => {
    const b = browser()
    await b.owner()
    await breakAudit("session.sign_out")
    expect((await b.call("POST", "/api/auth/sign-out")).status).toBe(200)
    expect(await sessions()).toHaveLength(0)
  })
})

describe("settings", () => {
  it("starts with a 30-day session and the idle limit off", async () => {
    const [row] = await t.ctx.db.insert(settings).values({ id: 1 }).returning()
    expect(row).toMatchObject({ sessionMaxDays: 30, sessionIdle: false, sessionIdleMinutes: 30 })
  })
})

describe("result review fixes", () => {
  it("keeps the auth lock on its reserved connection when the pool recycles connections", async () => {
    // A lock pool that ends its connections after one second: an unreserved connection would be closed while
    // idle, and its advisory lock with it.
    const short = createDatabase(t.url, { authLockMaxLifetimeSec: 1 })
    try {
      await browser().owner()
      const hasher = await passwordHasher(core.auth)
      const unlock = (await short.lockAuth()).release
      let resetDone = false
      const reset = resetPassword(t.ctx, hasher).then((result) => {
        resetDone = true
        return result
      })
      await new Promise((resolve) => setTimeout(resolve, 2_500))
      expect(resetDone).toBe(false)
      await unlock()
      expect((await reset)?.username).toBe("owner.name")
    } finally {
      await short.close()
    }
  })

  it("deletes the challenges opened with the old password when the password changes", async () => {
    const secret = await browser().owner()
    const desk = browser("desk")
    await desk.signIn(secret)
    // Another browser opens a sign-in challenge with the old password.
    const other = browser("other")
    expect((await other.passwordSignIn()).json.twoFactorRedirect).toBe(true)
    expect(await t.ctx.db.select().from(authVerification)).toHaveLength(2)

    const changed = await desk.call("POST", "/api/v1/account/password", {
      body: { currentPassword: TEST_PASSWORD, newPassword: "a brand new passphrase" },
    })
    expect(changed.status).toBe(200)
    expect(await t.ctx.db.select().from(authVerification)).toHaveLength(0)
    const before = (await sessions()).length
    expect((await other.verify(totp(secret))).status).toBe(401)
    expect((await sessions()).length).toBe(before)
    expect((await api(other)).status).toBe(401)
    expect((await api(desk)).status).toBe(200)
  })

  it("logs a failure inside Better Auth without its query, parameters or token, and answers a safe 500", async () => {
    await browser().setup()
    await t.ctx.db.execute(
      sql`alter table auth_session add constraint test_no_session check (token <> token) not valid`,
    )
    // Every argument of every console method, and every raw write to stdout and stderr, serialized in full.
    const output: string[] = []
    const keep = (...args: unknown[]) =>
      void output.push(args.map((arg) => inspect(arg, { depth: 10, showHidden: true })).join(" "))
    const spies = (["error", "warn", "log", "info", "debug", "trace"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(keep),
    )
    const writes = [process.stdout, process.stderr].map((stream) =>
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
        output.push(String(chunk))
        return true
      }) as typeof stream.write),
    )
    let res: Awaited<ReturnType<TestBrowser["passwordSignIn"]>>
    try {
      res = await browser("b").passwordSignIn()
    } finally {
      for (const spy of [...spies, ...writes]) spy.mockRestore()
      vi.spyOn(console, "error").mockImplementation(() => {})
      await t.ctx.db.execute(sql`alter table auth_session drop constraint if exists test_no_session`)
    }
    expect([res.status, res.json]).toEqual([500, { code: "internal_error", message: expect.any(String) }])
    expect(output.length).toBeGreaterThan(0)
    const logged = `${output.join("\n")}\n${JSON.stringify(res.json)}`
    expect(logged).toContain('"sqlstate":"23514"')
    for (const leak of [
      /SERVER_ERROR/,
      /insert into/i,
      /auth_session/,
      /params/i,
      /parameters/i,
      /failed query/i,
      /test_no_session/,
      /\$\d/,
    ])
      expect(logged).not.toMatch(leak)
    // No value of the rows it tried to write: tokens and ids are long random strings.
    expect(logged).not.toMatch(/[A-Za-z0-9]{32,}/)
  })

  it("survives the lock connection dying while the lock is held; the next request takes the lock", async () => {
    const own = createDatabase(t.url)
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => void uncaught.push(error)
    process.on("uncaughtException", onUncaught)
    process.on("unhandledRejection", onUncaught)
    try {
      build(own.lockAuth)
      const secret = await browser().owner()
      const unlock = (await own.lockAuth()).release
      const holders = await t.ctx.db.execute<{ pid: number }>(sql`
        select pid from pg_locks
        where locktype = 'advisory' and granted and classid = 0 and objsubid = 1
          and objid = ${sql.raw(String(AUTH_LOCK_KEY))}
          and database = (select oid from pg_database where datname = current_database())`)
      const [holder] = [...holders]
      expect(holder?.pid).toBeGreaterThan(0)
      // The server ends the backend that holds the lock, as a network drop or an administrator would.
      await t.ctx.db.execute(sql`select pg_terminate_backend(${holder?.pid ?? 0})`)
      await new Promise((resolve) => setTimeout(resolve, 500))
      // A controlled failure: the release says the lock was lost, and sends nothing to the dead connection.
      await expect(unlock()).rejects.toMatchObject({ name: "AuthLockLost" })
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(uncaught).toEqual([])
      // The next auth request opens a new connection, takes the lock and succeeds.
      await browser("next").signIn(secret)
      expect(uncaught).toEqual([])
    } finally {
      process.off("uncaughtException", onUncaught)
      process.off("unhandledRejection", onUncaught)
      await own.close()
    }
  })

  it("lists only the sessions the clocks allow, and the sweep ends one that expired silently", async () => {
    const secret = await browser().owner()
    const owner = browser()
    await owner.signIn(secret)
    const quiet = browser("quiet")
    await quiet.signIn(secret)
    await owner.call("PATCH", "/api/v1/settings", { body: { sessionIdle: true, sessionIdleMinutes: 5 } })
    t.clock.travel(4 * 60_000)
    await owner.call("POST", "/api/v1/session/activity")
    t.clock.travel(2 * 60_000)
    // The quiet browser went past its idle limit without another request; the owner kept working.
    const list = await owner.call("GET", "/api/v1/account/sessions")
    expect(list.json.data.sessions).toHaveLength(1)
    expect(list.json.data.sessions[0].current).toBe(true)
    const beforeSweep = await actions()
    expect(await sweepSessions(t.ctx)).toEqual({ ended: 2, removed: 0 })
    const ended = (await sessions()).filter((s) => s.endedReason)
    expect(ended.map((s) => s.endedReason)).toEqual(["idle", "idle"])
    expect((await actions()).length - beforeSweep.length).toBe(2)
    expect((await api(quiet)).json.error).toMatchObject({ code: "session_ended", reason: "idle" })
    expect((await api(owner)).status).toBe(200)
  })

  it("fails closed when the lock is lost during a sign-in and a reset runs before it is recorded", async () => {
    const own = createDatabase(t.url)
    let pause: (() => Promise<void>) | undefined
    try {
      build(own.lockAuth, {
        beforeRecord: async (route) => {
          if (route === "verify" && pause) await pause()
        },
      })
      const secret = await browser().owner()
      const hasher = await passwordHasher(core.auth)
      const b = browser("b")
      expect((await b.passwordSignIn()).json.twoFactorRedirect).toBe(true)
      let resetPassword_: string | undefined
      // Better Auth has created the session; before it is recorded, the lock's backend dies and a reset completes.
      pause = async () => {
        pause = undefined
        const holders = await t.ctx.db.execute<{ pid: number }>(sql`
          select pid from pg_locks
          where locktype = 'advisory' and granted and classid = 0 and objsubid = 1
            and objid = ${sql.raw(String(AUTH_LOCK_KEY))}
            and database = (select oid from pg_database where datname = current_database())`)
        const [holder] = [...holders]
        await t.ctx.db.execute(sql`select pg_terminate_backend(${holder?.pid ?? 0})`)
        resetPassword_ = (await resetPassword(t.ctx, hasher))?.password
      }
      const res = await b.verify(totp(secret))
      expect(resetPassword_).toBeDefined()
      expect([res.status, res.json.code]).toEqual([503, "busy"])
      expect(res.setCookies.filter((c) => c.includes("session_token=") && !/max-age=0/i.test(c))).toEqual([])
      expect(res.setCookies.some((c) => /session_token=;.*max-age=0/i.test(c))).toBe(true)
      expect(await sessions()).toHaveLength(0)
      expect((await api(b)).status).toBe(401)
      // The reset's password works; the old one does not.
      expect((await browser("old").passwordSignIn()).status).toBe(401)
      const after = browser("after")
      expect((await after.passwordSignIn("owner.name", resetPassword_)).status).toBe(200)
      expect((await api(after)).json.error.code).toBe("totp_required")
    } finally {
      await own.close()
    }
  })
})

describe("the auth epoch", () => {
  /** Ends the backend that holds the auth lock, as a network drop or an administrator would. */
  async function killLockBackend() {
    const holders = await t.ctx.db.execute<{ pid: number }>(sql`
      select pid from pg_locks
      where locktype = 'advisory' and granted and classid = 0 and objsubid = 1
        and objid = ${sql.raw(String(AUTH_LOCK_KEY))}
        and database = (select oid from pg_database where datname = current_database())`)
    const [holder] = [...holders]
    expect(holder?.pid).toBeGreaterThan(0)
    await t.ctx.db.execute(sql`select pg_terminate_backend(${holder?.pid ?? 0})`)
  }
  const liveSessionCookies = (cookies: string[]) =>
    cookies.filter((c) => c.includes("session_token=") && !/max-age=0/i.test(c))

  it("an enrolment cut across by a reset leaves no usable session, and the next sign-in enrols again", async () => {
    const own = createDatabase(t.url)
    let pause: (() => Promise<void>) | undefined
    try {
      build(own.lockAuth, undefined, async () => {
        const run = pause
        pause = undefined
        await run?.()
      })
      const b = browser()
      await b.setup()
      const secret = await b.enable()
      const hasher = await passwordHasher(core.auth)
      let newPassword: string | undefined
      // Inside Better Auth's verify: it has read the factor and is about to set twoFactorEnabled.
      pause = async () => {
        await killLockBackend()
        newPassword = (await resetPassword(t.ctx, hasher))?.password
      }
      const res = await b.verify(totp(secret))
      expect(newPassword).toBeDefined()
      expect([res.status, res.json.code]).toEqual([503, "busy"])
      expect(liveSessionCookies(res.setCookies)).toEqual([])
      expect((await api(b)).status).toBe(401)
      // The cut-across request set the flag after the reset removed the factor.
      const [flagged] = await t.ctx.db.select().from(authUser)
      expect(flagged?.twoFactorEnabled).toBe(true)
      expect(await t.ctx.db.select().from(authTwoFactor).where(eq(authTwoFactor.verified, true))).toHaveLength(0)

      // The next sign-in repairs the flag and enrols, instead of a challenge no code can answer.
      const after = browser("after")
      const signed = await after.passwordSignIn("owner.name", newPassword)
      expect(signed.status).toBe(200)
      expect(signed.json.twoFactorRedirect).toBeUndefined()
      expect((await api(after)).json.error.code).toBe("totp_required")
      expect(await actions()).toContain("auth.repair")
      const fresh = await after.enable(newPassword)
      expect((await after.verify(totp(fresh))).status).toBe(200)
      expect((await api(after)).status).toBe(200)
    } finally {
      await own.close()
    }
  })

  it("a reset that finishes between the lock check and the commit leaves no usable session", async () => {
    const own = createDatabase(t.url)
    let pause: (() => Promise<void>) | undefined
    try {
      build(own.lockAuth, {
        insideRecord: async (route) => {
          if (route !== "verify") return
          const run = pause
          pause = undefined
          await run?.()
        },
      })
      const secret = await browser().owner()
      const hasher = await passwordHasher(core.auth)
      const b = browser("b")
      expect((await b.passwordSignIn()).json.twoFactorRedirect).toBe(true)
      let newPassword: string | undefined
      pause = async () => {
        await killLockBackend()
        newPassword = (await resetPassword(t.ctx, hasher))?.password
      }
      const res = await b.verify(totp(secret))
      expect(newPassword).toBeDefined()
      expect([res.status, res.json.code]).toEqual([503, "busy"])
      expect(liveSessionCookies(res.setCookies)).toEqual([])
      expect((await api(b)).status).toBe(401)
      // No success was recorded: the only sign-in in the log is the setup's.
      expect((await actions()).filter((a) => a === "session.sign_in")).toHaveLength(1)
      expect((await browser("old").passwordSignIn()).status).toBe(401)
      const after = browser("after")
      expect((await after.passwordSignIn("owner.name", newPassword)).status).toBe(200)
      expect((await api(after)).json.error.code).toBe("totp_required")
    } finally {
      await own.close()
    }
  })

  it("refuses a session whose epoch is stale, everywhere a session is accepted", async () => {
    const secret = await browser().owner()
    const b = browser("b")
    await b.signIn(secret)
    expect((await api(b)).status).toBe(200)
    await t.ctx.db.update(authUser).set({ authEpoch: sql`${authUser.authEpoch} + 1` })
    expect((await api(b)).json.error.code).toBe("unauthorized")
    expect((await b.call("GET", "/api/auth/get-session")).json).toBeNull()
    expect((await api(b, "/api/setup/status")).json.data).toEqual({ hasUser: true, session: "none" })
    expect((await b.call("POST", "/api/v1/account/sessions/end-others")).status).toBe(401)
    // A browser that signs in now gets the current epoch, and lists only itself.
    const fresh = browser("fresh")
    await fresh.signIn(secret)
    const list = await fresh.call("GET", "/api/v1/account/sessions")
    expect(list.json.data.sessions).toHaveLength(1)
    expect(list.json.data.sessions[0].current).toBe(true)
  })
})
