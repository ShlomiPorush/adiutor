import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { getTableName, is } from "drizzle-orm"
import { PgTable } from "drizzle-orm/pg-core"
import postgres from "postgres"
import { createDatabase, type Database } from "../db/client.ts"
import * as schema from "../db/schema.ts"
import type { By, Ctx } from "../services/context.ts"
import { ReloadableSecretScanner } from "../services/secrets.ts"

// Support for *.integration.test.ts: a database of its own per test file, migrated, dropped at the end.
// MIKUD_TEST_DATABASE_URL is a role that may create databases (scripts/verify.sh sets it).

export const owner: By = { actor: { kind: "owner", label: "owner" }, source: "ui" }
export const agent: By = { actor: { kind: "agent", label: "agent" }, source: "mcp" }
export const bot: By = { actor: { kind: "bot", label: "telegram" }, source: "telegram" }

/** A clock tests can move: the real time plus an offset. */
export class TestClock {
  offsetMs = 0
  now = () => new Date(Date.now() + this.offsetMs)
  travel(ms: number) {
    this.offsetMs += ms
  }
}

export type TestDatabase = {
  ctx: Ctx
  url: string
  clock: TestClock
  database: Database
  /** Empties every table. */
  reset(): Promise<void>
  close(): Promise<void>
}

export async function createTestDatabase(prefix: string, privateDomains: string[] = []): Promise<TestDatabase> {
  const adminUrl = process.env.MIKUD_TEST_DATABASE_URL
  if (!adminUrl) throw new Error("MIKUD_TEST_DATABASE_URL is required (scripts/verify.sh sets it)")
  const name = `mikud_${prefix}_${randomBytes(4).toString("hex")}`
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const database = createDatabase(url.toString())
  await database.migrate(fileURLToPath(new URL("../../../drizzle", import.meta.url)))
  const clock = new TestClock()
  const ctx: Ctx = { db: database.db, secrets: new ReloadableSecretScanner(privateDomains), clock: clock.now }
  const tables = Object.values(schema)
    .filter((value) => is(value, PgTable))
    .map((table) => `"${getTableName(table as PgTable)}"`)
  return {
    ctx,
    url: url.toString(),
    clock,
    database,
    async reset() {
      await database.db.execute(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`)
      clock.offsetMs = 0
    },
    async close() {
      await database.close()
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      await admin.end()
    },
  }
}
