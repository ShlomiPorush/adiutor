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

/** The auth lock was lost with its connection (a network drop, or the server ended the backend). */
export class AuthLockLost extends Error {
  override name = "AuthLockLost"
  constructor() {
    super("The auth lock was lost with its database connection.")
  }
}

/** A held auth lock: the backend that holds it, whether its connection closed, and its release. */
export type AuthLock = {
  /** The PostgreSQL backend pid of the reserved connection that holds the lock. */
  pid: number
  /** True once that connection closed: PostgreSQL released the lock with the backend. */
  lost(): boolean
  /** Unlocks and gives the connection back; rejects with AuthLockLost when the connection had closed. */
  release(): Promise<void>
}

export type Database = {
  db: Db
  /**
   * Takes the auth lock (AUTH_LOCK_KEY) as a session-level advisory lock on a reserved connection of its own,
   * outside the pool. Requests of this process wait their turn in memory, so at most one holds or waits on that
   * connection and a queue of waiting requests never takes pool connections. Throws `busy` when the lock is not
   * free within AUTH_LOCK_TIMEOUT_MS.
   */
  lockAuth(): Promise<AuthLock>
  migrate(migrationsFolder: string): Promise<void>
  ping(): Promise<boolean>
  close(): Promise<void>
}

export function createDatabase(
  url: string,
  options: {
    authLockTimeoutMs?: number /** Tests only: recycle the lock pool's connections this fast. */
    authLockMaxLifetimeSec?: number
  } = {},
): Database {
  const lockTimeout = options.authLockTimeoutMs ?? AUTH_LOCK_TIMEOUT_MS
  const sql = postgres(url, { max: 10, onnotice: () => {}, connection: POOL_CONNECTION_SETTINGS })
  const db = drizzle(sql, { schema })
  /** The lock's own pool of one connection; `closed` turns true when that connection closes for any reason. */
  type LockPool = { sql: postgres.Sql; closed: boolean }
  let lockPool: LockPool | undefined
  const openLockPool = (): LockPool => {
    const pool: LockPool = { sql: undefined as unknown as postgres.Sql, closed: false }
    pool.sql = postgres(url, {
      max: 1,
      onnotice: () => {},
      onclose: () => {
        pool.closed = true
      },
      connection: { lock_timeout: lockTimeout },
      ...(options.authLockMaxLifetimeSec ? { max_lifetime: options.authLockMaxLifetimeSec } : {}),
    })
    return pool
  }
  /** Drops a lock pool: the next lock opens a new one. Its connection is destroyed without being sent anything. */
  const retire = (pool: LockPool) => {
    pool.closed = true
    if (lockPool === pool) lockPool = undefined
    void pool.sql.end({ timeout: 0 }).catch(() => {})
  }
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
      // The lock belongs to one database connection: it is reserved for the whole request, so the pool can never
      // recycle it (max_lifetime) or hand it to another query while the lock is held. postgres.js never reconnects
      // a reserved connection, and a query on one that closed can throw outside its promise: a pool whose
      // connection closed is retired, and nothing is sent to a closed connection again.
      if (lockPool?.closed) retire(lockPool)
      lockPool ??= openLockPool()
      const pool = lockPool
      let reserved: postgres.ReservedSql
      let pid = 0
      try {
        reserved = await pool.sql.reserve()
      } catch (error) {
        retire(pool)
        done()
        throw error
      }
      try {
        if (pool.closed) throw new AuthLockLost()
        await reserved`select pg_advisory_lock(${AUTH_LOCK_KEY})`
        const [row] = await reserved<{ pid: number }[]>`select pg_backend_pid() as pid`
        if (!row) throw new AuthLockLost()
        pid = row.pid
      } catch (error) {
        if (pool.closed) retire(pool)
        else reserved.release()
        done()
        if ((error as { code?: string }).code === "55P03") throw busy()
        throw error
      }
      const release = async () => {
        try {
          // A closed connection lost the lock with it: PostgreSQL released it when the backend ended.
          if (pool.closed) throw new AuthLockLost()
          await reserved`select pg_advisory_unlock(${AUTH_LOCK_KEY})`
          reserved.release()
        } catch (error) {
          // A connection that may still hold the lock never goes back to the pool: closing it frees the lock.
          retire(pool)
          throw error
        } finally {
          done()
        }
      }
      return { pid, lost: () => pool.closed, release }
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
      await lockPool?.sql.end({ timeout: 5 }).catch(() => {})
      await sql.end({ timeout: 5 })
    },
  }
}
