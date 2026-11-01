import { sql } from "drizzle-orm"
import { LINK_STRUCTURE_LOCK_KEY, lockLinkStructure } from "../services/context.ts"
import type { TestDatabase } from "./db.ts"

const WAIT_LIMIT_MS = 5_000

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
