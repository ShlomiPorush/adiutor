import { and, eq, isNull, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { agentConnections, oauthStore } from "../db/schema.ts"
import type { Tx } from "../services/context.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import {
  answerConsent,
  browserCall,
  confirmCode,
  connectWithCode,
  deviceRequest,
  type OAuthHarness,
  oauthHarness,
  ownerBy,
  pollDevice,
  refresh,
} from "../testing/oauth.ts"
import { AGENT_GATE_KEY } from "./gate.ts"
import { CLI_CLIENT_ID } from "./provider.ts"
import { sha256 } from "./store.ts"

/*
 * The race matrix (testing.md): a "make" and an "end" at the same time. Each test holds one point that matters (the
 * gate, or a store row), starts both sides, and checks in pg_blocking_pids that each really waits there before it lets
 * them go, in each order. The expected result of every pair: the connection is made and then ended, or it is refused;
 * a live connection never remains, and a token issued meanwhile is refused at once.
 */

let t: TestDatabase
let h: OAuthHarness

beforeAll(async () => {
  t = await createTestDatabase("oauth_races")
  h = await oauthHarness(t)
})
afterAll(async () => {
  await h?.close()
  await t?.close()
})
beforeEach(async () => {
  await h.access.saveSettings(ownerBy, { enabled: true })
  await h.access.disconnectAll(ownerBy)
})

const live = async () => (await t.ctx.db.select().from(agentConnections).where(isNull(agentConnections.endedAt))).length

/** Holds something in a transaction of its own until released; `pid` is its backend. */
async function hold(take: (tx: Tx) => Promise<void>) {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let ready: (pid: number) => void = () => {}
  const started = new Promise<number>((resolve) => {
    ready = resolve
  })
  const done = t.ctx.db.transaction(async (tx) => {
    const [row] = [...(await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))]
    await take(tx)
    ready(row?.pid ?? 0)
    await held
  })
  const pid = await started
  const handle = {
    pid,
    async release() {
      release()
      await done
    },
  }
  holders.push(handle)
  return handle
}
/** Every hold of a test, let go after it whatever happened. */
const holders: { release(): Promise<void> }[] = []
afterEach(async () => {
  for (const handle of holders.splice(0)) await handle.release().catch(() => {})
})

const holdGate = () =>
  hold(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(AGENT_GATE_KEY))})`)
  })

const holdRow = (type: string, id: string) =>
  hold(async (tx) => {
    await tx.execute(sql`select 1 from oauth_store where type = ${type} and id = ${id} for update`)
  })

/**
 * Waits until `n` backends wait behind `holder`, as pg_blocking_pids says: directly, or behind another waiter (a second
 * waiter for a row waits for the first one's tuple lock, which waits for the holder).
 */
async function waitForBlocked(holder: number, n: number) {
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    const rows = await t.ctx.db.execute<{ pid: number; blockers: number[] }>(sql`
      select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity
      where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`)
    const waiting = new Set<number>()
    let grew = true
    while (grew) {
      grew = false
      for (const row of rows)
        if (!waiting.has(row.pid) && row.blockers.some((b) => b === holder || waiting.has(b))) {
          waiting.add(row.pid)
          grew = true
        }
    }
    if (waiting.size >= n) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`fewer than ${n} backends waited for ${holder}`)
}

/** A device request the owner opened on the consent page (bound to the browser), not answered yet. */
async function openRequest() {
  const device = await deviceRequest(h.issuer)
  const uid = await confirmCode(h.owner, device.body.user_code)
  await browserCall(h.owner, `/connect/approve/${uid}/details`)
  return { device, uid }
}

describe("the race matrix", () => {
  for (const order of ["the end first", "the answer first"] as const)
    it(`consent answer against disconnect all, ${order}`, async () => {
      const { uid } = await openRequest()
      const gate = await holdGate()
      const decide = () =>
        browserCall(h.owner, `/connect/approve/${uid}/decision`, { json: { approve: true, areas: ["read"] } })
      let answer: Promise<Awaited<ReturnType<typeof decide>>>
      let ended: Promise<number>
      if (order === "the end first") {
        ended = h.access.disconnectAll(ownerBy)
        await waitForBlocked(gate.pid, 1)
        answer = decide()
        await waitForBlocked(gate.pid, 2)
      } else {
        answer = decide()
        await waitForBlocked(gate.pid, 1)
        ended = h.access.disconnectAll(ownerBy)
        await waitForBlocked(gate.pid, 2)
      }
      await gate.release()
      const [res, count] = await Promise.all([answer, ended])
      if (order === "the end first") {
        expect(res.status).toBe(410)
        expect(count).toBe(0)
      } else {
        expect(res.status).toBe(200)
        expect(count).toBe(1)
      }
      expect(await live()).toBe(0)
    })

  for (const order of ["the collection first", "the switch first"] as const)
    it(`device collection against agents turned off, ${order}`, async () => {
      const { device, uid } = await openRequest()
      const { decision } = await answerConsent(h.owner, uid, { approve: true, areas: ["read"] })
      await browserCall(h.owner, decision.body.redirectTo)
      const row = await holdRow("DeviceCode", device.body.device_code)
      let collected: ReturnType<typeof pollDevice>
      let off: Promise<void>
      if (order === "the collection first") {
        collected = pollDevice(h.issuer, device.body.device_code)
        await waitForBlocked(row.pid, 1)
        off = h.access.saveSettings(ownerBy, { enabled: false })
        await waitForBlocked(row.pid, 2)
      } else {
        off = h.access.saveSettings(ownerBy, { enabled: false })
        await waitForBlocked(row.pid, 1)
        collected = pollDevice(h.issuer, device.body.device_code)
        await waitForBlocked(row.pid, 2)
      }
      await row.release()
      const [res] = await Promise.all([collected, off])
      expect(await live()).toBe(0)
      await h.access.saveSettings(ownerBy, { enabled: true })
      if (res.status === 200) expect((await h.access.checkToken(res.body.access_token, "rest")).ok).toBe(false)
      // Whatever was issued at the moment of the end is gone after the sweep (D1f).
      await h.access.sweep()
      const left = await t.ctx.db
        .select()
        .from(oauthStore)
        .where(sql`${oauthStore.type} in ('AccessToken', 'RefreshToken', 'Grant')`)
      expect(left).toEqual([])
    })

  for (const order of ["the refresh first", "the end first"] as const)
    it(`refresh against disconnect all, ${order}`, async () => {
      const c = await connectWithCode(h)
      const row = await holdRow("RefreshToken", sha256(c.tokens.body.refresh_token))
      let refreshed: ReturnType<typeof refresh>
      let ended: Promise<number>
      if (order === "the refresh first") {
        refreshed = refresh(h.issuer, CLI_CLIENT_ID, c.tokens.body.refresh_token)
        await waitForBlocked(row.pid, 1)
        ended = h.access.disconnectAll(ownerBy)
        await waitForBlocked(row.pid, 2)
      } else {
        ended = h.access.disconnectAll(ownerBy)
        await waitForBlocked(row.pid, 1)
        refreshed = refresh(h.issuer, CLI_CLIENT_ID, c.tokens.body.refresh_token)
        await waitForBlocked(row.pid, 2)
      }
      await row.release()
      const [res, count] = await Promise.all([refreshed, ended])
      expect(count).toBe(1)
      expect(await live()).toBe(0)
      if (res.status === 200) {
        // Issued at the moment of the end (D1f): refused at once, removed by the sweep.
        expect((await h.access.checkToken(res.body.access_token, "rest")).ok).toBe(false)
        await h.access.sweep()
        const at = await h.access.provider?.AccessToken.find(res.body.access_token)
        expect(at).toBeUndefined()
      }
    })

  it("two refreshes with one token at once: one wins, the grant ends, and the winner's new token is refused at once", async () => {
    const c = await connectWithCode(h)
    const check = await h.access.checkToken(c.tokens.body.access_token, "rest")
    if (!check.ok) throw new Error("not connected")
    const row = await holdRow("RefreshToken", sha256(c.tokens.body.refresh_token))
    const both = Promise.all([
      refresh(h.issuer, CLI_CLIENT_ID, c.tokens.body.refresh_token),
      refresh(h.issuer, CLI_CLIENT_ID, c.tokens.body.refresh_token),
    ])
    await waitForBlocked(row.pid, 2)
    await row.release()
    const answers = await both
    expect(answers.map((a) => a.status).sort()).toEqual([200, 400])
    const winner = answers.find((a) => a.status === 200)
    expect((await h.access.checkToken(winner?.body.access_token, "rest")).ok).toBe(false)
    const [ended] = await t.ctx.db
      .select()
      .from(agentConnections)
      .where(and(eq(agentConnections.id, check.connection.id)))
    expect(ended?.endReason).toBe("refresh_reused")
    expect((await refresh(h.issuer, CLI_CLIENT_ID, winner?.body.refresh_token)).status).toBe(400)
  })
})
