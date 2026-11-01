import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"
import * as schema from "./schema.ts"

export type Db = PostgresJsDatabase<typeof schema>

/*
 * "New since your last visit" compares write times (taken inside the write's transaction) with the time of
 * a visit. A write that started before a read and committed after it is not in that read, yet its time is
 * before the read's. The invariant that keeps it from being hidden:
 *
 * 1. No transaction of the app pool lives longer than TRANSACTION_TIMEOUT_MS: PostgreSQL ends it
 *    (`transaction_timeout`, PostgreSQL 17 or newer; an idle open transaction ends sooner).
 * 2. A visit is recorded VISIT_SAFETY_MARGIN_MS before the start of the read it marks as seen. The margin
 *    is larger than the transaction bound, so every write the read did not see has a later time than the
 *    visit.
 *
 * Items written in the margin may show as new on two visits; none is ever hidden.
 */
export const TRANSACTION_TIMEOUT_MS = 30_000
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000
export const VISIT_SAFETY_MARGIN_MS = 60_000

/** The settings every connection of the app pool starts with (see the invariant above). */
export const POOL_CONNECTION_SETTINGS = {
  transaction_timeout: TRANSACTION_TIMEOUT_MS,
  idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
}

export type Database = {
  db: Db
  migrate(migrationsFolder: string): Promise<void>
  ping(): Promise<boolean>
  close(): Promise<void>
}

export function createDatabase(url: string): Database {
  const sql = postgres(url, { max: 10, onnotice: () => {}, connection: POOL_CONNECTION_SETTINGS })
  const db = drizzle(sql, { schema })
  return {
    db,
    async migrate(migrationsFolder) {
      // A connection of its own, without the pool's transaction bound: a migration may take longer.
      const once = postgres(url, { max: 1, onnotice: () => {} })
      try {
        await migrate(drizzle(once), { migrationsFolder })
      } finally {
        await once.end({ timeout: 5 })
      }
    },
    async ping() {
      try {
        await sql`select 1`
        return true
      } catch {
        return false
      }
    },
    async close() {
      await sql.end({ timeout: 5 })
    },
  }
}
