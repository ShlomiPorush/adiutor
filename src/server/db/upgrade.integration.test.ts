import { randomBytes } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { twoFactor, username } from "better-auth/plugins"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createApp } from "../app.ts"
import { ReloadableSecretScanner } from "../services/secrets.ts"
import { TEST_AUTH_SECRET, testCore } from "../testing/app.ts"
import { TEST_ORIGIN, TEST_PASSWORD, TestBrowser } from "../testing/browser.ts"
import type { TestDatabase } from "../testing/db.ts"
import { totp } from "../testing/totp.ts"
import { createDatabase, type Database } from "./client.ts"
import { authAccount, authSession, authTwoFactor, authUser, authVerification } from "./schema.ts"

// The upgrade from the schema on main before this change (migrations 0000 to 0004: Better Auth behind Mikud's wrapper,
// with per-session TOTP proof and the auth epoch) to Better Auth as it documents itself: invented data survives, every
// session ends once (G14), a second sign-up is refused, and the TOTP secret encrypted with MIKUD_AUTH_SECRET still
// verifies through Better Auth's legacy `secret` fallback.

const BEFORE = 5 // migrations 0000 to 0004

const migrations = fileURLToPath(new URL("../../../drizzle", import.meta.url))
let admin: postgres.Sql
let name: string
let url: string
let database: Database
let oldFolder: string

/** The migrations folder as it was on main before this change. */
function folderBefore(): string {
  const dir = mkdtempSync(join(tmpdir(), "mikud-upgrade-"))
  cpSync(migrations, dir, { recursive: true })
  const journalPath = join(dir, "meta", "_journal.json")
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number; tag: string }[] }
  for (const entry of journal.entries.filter((e) => e.idx >= BEFORE)) rmSync(join(dir, `${entry.tag}.sql`))
  journal.entries = journal.entries.filter((e) => e.idx < BEFORE)
  writeFileSync(journalPath, JSON.stringify(journal))
  return dir
}

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  const adminUrl = process.env.MIKUD_TEST_DATABASE_URL
  if (!adminUrl) throw new Error("MIKUD_TEST_DATABASE_URL is required (scripts/verify.sh sets it)")
  admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  name = `mikud_upgrade_${randomBytes(4).toString("hex")}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const u = new URL(adminUrl)
  u.pathname = `/${name}`
  url = u.toString()
  database = createDatabase(url)
  oldFolder = folderBefore()
})
afterAll(async () => {
  await database?.close()
  await admin?.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin?.end()
  if (oldFolder) rmSync(oldFolder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("upgrading a database from Better Auth behind the wrapper", () => {
  it("keeps the data, ends every session once, does not carry session_max_days over (idle days start at 30), refuses a second owner, and still reads the TOTP secret", async () => {
    await database.migrate(oldFolder)
    const sql = postgres(url, { max: 1, onnotice: () => {} })
    try {
      const [project] =
        await sql`insert into projects (name, slug) values ('Lantern Garden', 'lantern-garden') returning id`
      await sql`
        insert into items (project_id, type, status, title, status_set_by, created_by)
        values (${project?.id}, 'task', 'todo', 'Sketch the plant card', 'owner', 'owner')`
      await sql`insert into settings (id, session_max_days) values (1, 14)
        on conflict (id) do update set session_max_days = 14`
    } finally {
      await sql.end()
    }

    // The owner as the old server created it: Better Auth with only the legacy `secret` (MIKUD_AUTH_SECRET).
    const legacy = betterAuth({
      secret: TEST_AUTH_SECRET,
      baseURL: TEST_ORIGIN,
      basePath: "/api/auth",
      trustedOrigins: [TEST_ORIGIN],
      telemetry: { enabled: false },
      logger: { level: "error" },
      rateLimit: { enabled: false },
      database: drizzleAdapter(database.db, {
        provider: "pg",
        schema: {
          user: authUser,
          session: authSession,
          account: authAccount,
          verification: authVerification,
          twoFactor: authTwoFactor,
        },
      }),
      emailAndPassword: { enabled: true, minPasswordLength: 12 },
      plugins: [username(), twoFactor({ issuer: "Mikud" })],
    })
    const old = new TestBrowser((request) => legacy.handler(request), TEST_ORIGIN, {
      "x-forwarded-for": "198.51.100.7",
    })
    expect((await old.setup()).status).toBe(200)
    const { secret } = await old.enable()
    expect((await old.verify(totp(secret))).status).toBe(200)

    await database.migrate(migrations)

    const after = postgres(url, { max: 1, onnotice: () => {} })
    try {
      expect((await after`select title from items`).map((i) => i.title)).toEqual(["Sketch the plant card"])
      expect(await after`select id from auth_session`).toHaveLength(0)
      const columns = await after`
        select table_name, column_name from information_schema.columns
        where table_name in ('auth_session', 'auth_user', 'settings')`
      const names = columns.map((c) => `${c.table_name}.${c.column_name}`)
      for (const gone of ["auth_session.two_factor_at", "auth_session.auth_epoch", "auth_user.auth_epoch"])
        expect(names).not.toContain(gone)
      // Not carried over: the old session_max_days (14 here) is dropped, and the idle days start at the default 30.
      const [settings] = await after`select session_idle_days, private_domains, otp_via_telegram from settings`
      expect(settings).toEqual({ session_idle_days: 30, private_domains: [], otp_via_telegram: false })
    } finally {
      await after.end()
    }

    // The new server: MIKUD_AUTH_SECRETS with a new current secret, MIKUD_AUTH_SECRET kept as the legacy fallback.
    const t = { ctx: { db: database.db, secrets: new ReloadableSecretScanner(), clock: () => new Date() } }
    const newSecret = ["upgraded", "auth", "secret", "for", "tests", "only", "00"].join("-")
    const core = testCore(t as unknown as TestDatabase, {
      config: { publicUrl: new URL(TEST_ORIGIN), version: "test" },
      auth: { secrets: [{ version: 2, value: newSecret }], legacySecret: TEST_AUTH_SECRET },
    })
    const app = createApp({ checkDatabase: async () => true, core })
    const b = new TestBrowser((request) => app.fetch(request), TEST_ORIGIN, { "x-forwarded-for": "198.51.100.8" })
    // The old cookie is gone with its session.
    b.cookies.clear()
    for (const [k, v] of old.cookies) b.cookies.set(k, v)
    expect((await b.call("GET", "/api/v1/session")).status).toBe(401)
    b.cookies.clear()
    const second = await b.setup("second")
    expect([second.status, second.json.code]).toEqual([403, "ALREADY_SET_UP"])
    await b.signIn(secret, "Owner.Name", TEST_PASSWORD)
    expect((await b.call("GET", "/api/v1/session")).status).toBe(200)
  })
})
