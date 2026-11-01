import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"
import { AppError } from "../errors.ts"
import { AUTH_LOCK_KEY } from "../services/context.ts"
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
 * 3. The morning message counts "new" the same way: its job_runs row stores, as `covers_until`, the start
 *    of its read minus VISIT_SAFETY_MARGIN_MS, and the next message counts from there.
 *
 * Items written in the margin may show as new twice; none is ever hidden.
 */
export const TRANSACTION_TIMEOUT_MS = 30_000
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000
export const VISIT_SAFETY_MARGIN_MS = 60_000

/** The settings every connection of the app pool starts with (see the invariant above). */
export const POOL_CONNECTION_SETTINGS = {
  transaction_timeout: TRANSACTION_TIMEOUT_MS,
  idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
}

/** How long a state-changing auth request waits for the auth lock before it answers `busy`. */
export const AUTH_LOCK_TIMEOUT_MS = 10_000

export type Database = {
  db: Db
  /**
   * Takes the auth lock (AUTH_LOCK_KEY) as a session-level advisory lock on a connection of its own, outside
   * the pool, and returns the function that releases it. Requests of this process wait their turn in memory, so
   * at most one holds or waits on that connection and a queue of waiting requests never takes pool connections.
   * Throws `busy` when the lock is not free within AUTH_LOCK_TIMEOUT_MS.
   */
  lockAuth(): Promise<() => Promise<void>>
  migrate(migrationsFolder: string): Promise<void>
  ping(): Promise<boolean>
  close(): Promise<void>
}

export function createDatabase(url: string, options: { authLockTimeoutMs?: number } = {}): Database {
  const lockTimeout = options.authLockTimeoutMs ?? AUTH_LOCK_TIMEOUT_MS
  const sql = postgres(url, { max: 10, onnotice: () => {}, connection: POOL_CONNECTION_SETTINGS })
  const db = drizzle(sql, { schema })
  let lockSql: postgres.Sql | undefined
  let tail: Promise<void> = Promise.resolve()
  const busy = () => new AppError("busy", "Another sign-in change is in progress. Try again in a moment.")
  return {
    db,
    async lockAuth() {
      let done = () => {}
      const turn = new Promise<void>((resolve) => {
        done = resolve
      })
      const previous = tail
      tail = previous.then(() => turn)
      let timer: NodeJS.Timeout | undefined
      const ours = await Promise.race([
        previous.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), lockTimeout)
        }),
      ])
      clearTimeout(timer)
      if (!ours) {
        // Gives up its place once the ones before it are done, so the queue keeps moving.
        void previous.then(done)
        throw busy()
      }
      try {
        lockSql ??= postgres(url, {
          max: 1,
          onnotice: () => {},
          connection: { lock_timeout: lockTimeout },
        })
        await lockSql`select pg_advisory_lock(${AUTH_LOCK_KEY})`
      } catch (error) {
        done()
        if ((error as { code?: string }).code === "55P03") throw busy()
        throw error
      }
      const held = lockSql
      return async () => {
        try {
          await held`select pg_advisory_unlock(${AUTH_LOCK_KEY})`
        } finally {
          done()
        }
      }
    },
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
      await lockSql?.end({ timeout: 5 })
      await sql.end({ timeout: 5 })
    },
  }
}
