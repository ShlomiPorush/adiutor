import { randomBytes } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
import { createAuth } from "../auth/auth.ts"
import { RateLimiter } from "../http/auth.ts"
import { createSecretScanner } from "../services/secrets.ts"
import { TEST_AUTH_SECRET } from "../testing/app.ts"
import { TestBrowser } from "../testing/browser.ts"
import { createDatabase, type Database } from "./client.ts"

// The upgrade from the schema on main before sign-in (migrations 0000 to 0002, browsers paired with a device
// cookie) to Better Auth: invented data survives, the old device cookie is refused, setup runs once, and the
// agent token and the sync work unchanged.

const OWNER = "owner-token-for-tests-only-000000000000"
const AGENT = "agent-token-for-tests-only-000000000000"
const ORIGIN = "http://127.0.0.1:8090"
const BEFORE_AUTH = 3 // migrations 0000_initial, 0001_job-skipped, 0002_morning-covers-until

const migrations = fileURLToPath(new URL("../../../drizzle", import.meta.url))
let admin: postgres.Sql
let name: string
let url: string
let database: Database
let oldFolder: string

/** The migrations folder as it was on main before sign-in. */
function folderBeforeAuth(): string {
  const dir = mkdtempSync(join(tmpdir(), "mikud-upgrade-"))
  cpSync(migrations, dir, { recursive: true })
  const journalPath = join(dir, "meta", "_journal.json")
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number; tag: string }[] }
  for (const entry of journal.entries.filter((e) => e.idx >= BEFORE_AUTH)) rmSync(join(dir, `${entry.tag}.sql`))
  journal.entries = journal.entries.filter((e) => e.idx < BEFORE_AUTH)
  writeFileSync(journalPath, JSON.stringify(journal))
  return dir
}

beforeAll(async () => {
  const adminUrl = process.env.MIKUD_TEST_DATABASE_URL
  if (!adminUrl) throw new Error("MIKUD_TEST_DATABASE_URL is required (scripts/verify.sh sets it)")
  admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  name = `mikud_upgrade_${randomBytes(4).toString("hex")}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const u = new URL(adminUrl)
  u.pathname = `/${name}`
  url = u.toString()
  database = createDatabase(url)
  oldFolder = folderBeforeAuth()
})
afterAll(async () => {
  await database?.close()
  await admin?.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin?.end()
  if (oldFolder) rmSync(oldFolder, { recursive: true, force: true })
})

describe("upgrading a database from before sign-in", () => {
  it("keeps the data, refuses the old device cookie, runs setup once, and serves agents and the sync", async () => {
    await database.migrate(oldFolder)
    const sql = postgres(url, { max: 1, onnotice: () => {} })
    const deviceSecret = "old-device-secret-from-pairing-000000000000"
    try {
      const [device] = await sql`
        insert into devices (secret_hash, label, last_seen_at)
        values (encode(sha256(${deviceSecret}::bytea), 'hex'), 'Phone', now()) returning id`
      await sql`insert into devices (secret_hash, label, revoked_at) values ('ended-hash', 'Old desktop', now())`
      await sql`insert into visits (device_id, at) values (${device?.id}, now() - interval '1 hour')`
      const [project] =
        await sql`insert into projects (name, slug) values ('Lantern Garden', 'lantern-garden') returning id`
      await sql`
        insert into items (project_id, type, status, title, status_set_by, created_by)
        values (${project?.id}, 'task', 'todo', 'Sketch the plant card', 'owner', 'owner')`
      await sql`
        insert into audit (actor_kind, actor_label, action, entity_type, entity_id, source)
        values ('owner', 'device:Phone', 'device.pair', 'device', ${device?.id}, 'ui')`
    } finally {
      await sql.end()
    }

    await database.migrate(migrations)

    const after = postgres(url, { max: 1, onnotice: () => {} })
    try {
      const devices = await after`select id, label, revoked_at from devices order by label`
      expect(devices.map((d) => d.label)).toEqual(["Old desktop", "Phone"])
      const columns = await after`select column_name from information_schema.columns where table_name = 'devices'`
      expect(columns.map((c) => c.column_name)).not.toContain("secret_hash")
      const [visit] = await after`select device_id from visits`
      expect(visit?.device_id).toBe(devices.find((d) => d.label === "Phone")?.id)
      expect((await after`select title from items`).map((i) => i.title)).toEqual(["Sketch the plant card"])
      expect((await after`select action from audit`).map((a) => a.action)).toEqual(["device.pair"])
    } finally {
      await after.end()
    }

    const ctx = { db: database.db, secrets: createSecretScanner([]), clock: () => new Date() }
    const publicUrl = new URL(ORIGIN)
    const app = createApp({
      checkDatabase: async () => true,
      core: {
        ctx,
        config: { ownerToken: OWNER, agentToken: AGENT, publicUrl, version: "test" },
        auth: createAuth({ db: database.db, secret: TEST_AUTH_SECRET, publicUrl }),
        lockAuth: database.lockAuth,
        limiter: new RateLimiter(10, 60_000),
        attempts: new RateLimiter(5, 300_000),
      },
    })

    // The paired browser's cookie means nothing now: it has to sign in.
    const old = await app.request("/api/v1/session", { headers: { cookie: `mikud_device=${deviceSecret}` } })
    expect(old.status).toBe(401)

    // Setup runs once.
    const status = await app.request("/api/setup/status")
    expect(((await status.json()) as { data: unknown }).data).toEqual({ hasUser: false, session: "none" })
    const owner = new TestBrowser((request) => app.fetch(request))
    await owner.owner("owner")
    expect((await owner.call("GET", "/api/v1/session")).status).toBe(200)
    expect((await new TestBrowser((request) => app.fetch(request)).setup("second")).status).toBe(409)

    // Agents and the sync are unchanged.
    const bearer = { authorization: `Bearer ${AGENT}`, "content-type": "application/json" }
    const created = await app.request("/api/v1/items", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ type: "idea", title: "Water the seedlings" }),
    })
    expect(created.status).toBe(201)
    const sync = await app.request("/api/v1/sync/t3", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        collectedAt: new Date().toISOString(),
        projects: [{ t3ProjectId: "demo-lantern", title: "Lantern Garden" }],
        threads: [],
      }),
    })
    expect(sync.status).toBe(200)
    expect(((await sync.json()) as { data: { outcome: string } }).data.outcome).toBe("succeeded")
  })
})
