import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"
import * as schema from "./schema.ts"

export type Db = PostgresJsDatabase<typeof schema>

/*
 * "New since your last visit" compares write times (taken inside the write's transaction) with the time of
 * a visit. A write that started before a read and committed after it is not in that read, yet its time is
 * before the read's. What keeps such a write from being hidden:
 *
 * 1. The app's transactions are short: a few statements each. Every statement of the app pool ends after
 *    STATEMENT_TIMEOUT_MS (`statement_timeout`), and a transaction left idle ends after
 *    IDLE_IN_TRANSACTION_TIMEOUT_MS (`idle_in_transaction_session_timeout`).
 * 2. A visit is recorded VISIT_SAFETY_MARGIN_MS before the start of the read it marks as seen. The margin
 *    is larger than any transaction of the app takes in practice, so a write the read did not see has a
 *    later time than the visit.
 * 3. The morning message counts "new" the same way: its job_runs row stores, as `covers_until`, the start
 *    of its read minus VISIT_SAFETY_MARGIN_MS, and the next message counts from there.
 *
 * The bound is practical, not hard: PostgreSQL 16 has no timeout for a whole transaction
 * (`transaction_timeout` is PostgreSQL 17 or newer), so a transaction of many statements could in theory run
 * longer than the margin. A write that commits more than the margin after it took its time could then show
 * as not new. Items written in the margin may show as new twice.
 */
export const STATEMENT_TIMEOUT_MS = 15_000
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000
export const VISIT_SAFETY_MARGIN_MS = 60_000

/** The settings every connection of the app pool starts with (see above). PostgreSQL 16 knows each of them. */
export const POOL_CONNECTION_SETTINGS = {
  statement_timeout: STATEMENT_TIMEOUT_MS,
  idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
}

export type Database = {
  db: Db
  migrate(migrationsFolder: string): Promise<void>
  ping(): Promise<boolean>
  close(): Promise<void>
}

/** Why a migration failed: the innermost cause's message (PostgreSQL's text), not Drizzle's "Failed query: ...". */
export function migrationFailure(error: unknown): string {
  let e = error
  for (let depth = 0; depth < 5 && e instanceof Error && e.cause instanceof Error; depth++) e = e.cause
  return e instanceof Error ? e.message : String(e)
}

export function createDatabase(url: string): Database {
  const sql = postgres(url, { max: 10, onnotice: () => {}, connection: POOL_CONNECTION_SETTINGS })
  const db = drizzle(sql, { schema })
  return {
    db,
    async migrate(migrationsFolder) {
      // A connection of its own, without the pool's time limits: a migration may take longer.
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
