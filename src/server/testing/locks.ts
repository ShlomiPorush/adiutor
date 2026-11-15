import { sql } from "drizzle-orm"
import { LINK_STRUCTURE_LOCK_KEY, lockLinkStructure } from "../services/context.ts"
import type { TestDatabase } from "./db.ts"

const WAIT_LIMIT_MS = 5_000

type Tx = Parameters<Parameters<TestDatabase["ctx"]["db"]["transaction"]>[0]>[0]

/**
 * Holds `select ... for update` on one row of `table` in a transaction of its own until `release`: a call that changes
 * the row waits behind it, a controlled slow call. `waiting(n)` resolves once `n` backends of this database really wait
 * for a lock (pg_blocking_pids), never on a timer. `release(last)` runs `last` in the holding transaction first, so a
 * change commits exactly when the lock goes.
 */
export async function holdRow(t: TestDatabase, table: "items" | "notes" | "agent_connections", id: string) {
  let release: (last?: (tx: Tx) => Promise<unknown>) => void = () => {}
  const released = new Promise<((tx: Tx) => Promise<unknown>) | undefined>((resolve) => {
    release = resolve
  })
  let locked = () => {}
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve
  })
  const holder = t.ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${sql.raw(table)} where id = ${id} for update`)
    locked()
    const last = await released
    await last?.(tx)
  })
  await isLocked
  return {
    async waiting(n = 1): Promise<void> {
      const until = Date.now() + 10_000
      while (Date.now() < until) {
        const [row] = [
          ...(await t.ctx.db.execute<{ n: number }>(sql`
            select count(*)::int as n from pg_stat_activity
            where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`)),
        ]
        if ((row?.n ?? 0) >= n) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`fewer than ${n} backends waited for the held row`)
    },
    async release(last?: (tx: Tx) => Promise<unknown>) {
      release(last)
      await holder
    },
  }
}

/**
 * Runs `work` while another transaction holds the link structure lock, and checks that `work` takes that
 * lock as the first statement of its transaction: it must wait for the lock, and while it waits its
 * backend holds no lock on any table or row and has written nothing. Returns what `work` returns (or
 * rejects as it rejects) once the lock is released.
 */
export async function expectLinkLockFirst<T>(t: TestDatabase, work: () => Promise<T>): Promise<T> {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let ready = () => {}
  const locked = new Promise<void>((resolve) => {
    ready = resolve
  })
  const holder = t.ctx.db.transaction(async (tx) => {
    await lockLinkStructure(tx)
    ready()
    await held
  })
  let settled = false
  let running: Promise<T> | undefined
  try {
    await locked
    running = work().finally(() => {
      settled = true
    })
    running.catch(() => {})
    const pid = await waitingPid(t, () => settled)
    const locks = await t.ctx.db.execute<{ locktype: string; relation: string | null; mode: string }>(sql`
      select locktype, relation::regclass::text as relation, mode from pg_locks
      where pid = ${pid} and granted and locktype <> 'virtualxid'`)
    if (locks.length > 0)
      throw new Error(`locks held while waiting for the link structure lock: ${JSON.stringify([...locks])}`)
  } finally {
    release()
    await holder
  }
  if (!running) throw new Error("the work did not start")
  return running
}

/** The backend that waits for the link structure lock, or a failure when `work` finished without waiting. */
async function waitingPid(t: TestDatabase, done: () => boolean): Promise<number> {
  const until = Date.now() + WAIT_LIMIT_MS
  while (Date.now() < until) {
    const rows = await t.ctx.db.execute<{ pid: number }>(sql`
      select pid from pg_locks
      where locktype = 'advisory' and not granted and classid = 0 and objsubid = 1
        and objid = ${sql.raw(String(LINK_STRUCTURE_LOCK_KEY))}
        and database = (select oid from pg_database where datname = current_database())`)
    const [row] = [...rows]
    if (row) return row.pid
    if (done()) throw new Error("the work finished without waiting for the link structure lock")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("the work did not wait for the link structure lock")
}
