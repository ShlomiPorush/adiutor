import { and, eq, isNull, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { agentConnections, agentIdentityChanges, oauthStore } from "../db/schema.ts"
import type { Tx } from "../services/context.ts"
import { createSettingsCipher } from "../settings/crypto.ts"
import { TEST_SETTINGS_KEY } from "../testing/app.ts"
import { TEST_PASSWORD } from "../testing/browser.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import {
  agentCall,
  answerConsent,
  browserCall,
  confirmCode,
  connectWithCode,
  deviceRequest,
  type OAuthHarness,
  oauthHarness,
  ownerBy,
  pkce,
  pollDevice,
  refresh,
  register,
  uidOf,
} from "../testing/oauth.ts"
import { testSecret } from "../testing/secrets.ts"
import { createAgentAccess } from "./access.ts"
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
  await h.access.saveSettings(ownerBy, { enabled: true, idleDays: 90 })
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

/** An MCP client's approved authorization code, not exchanged yet, and its exchange. */
async function approvedCode() {
  const redirect = "http://127.0.0.1:33418/callback"
  const reg = await register(h.issuer, { redirect_uris: [redirect] })
  const clientId = String(reg.body.client_id)
  const { verifier, challenge } = pkce()
  const resource = `${h.issuer}/mcp`
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: "read",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  })
  const authorize = await browserCall(h.owner, `/oauth/authorize?${query}`)
  const { decision } = await answerConsent(h.owner, uidOf(authorize.location), { approve: true })
  const back = await browserCall(h.owner, String(decision.body.redirectTo))
  const code = new URL(back.location ?? "").searchParams.get("code") ?? ""
  const exchange = () =>
    agentCall(h.issuer, "/oauth/token", {
      form: {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: redirect,
        resource,
      },
    })
  return { code, exchange }
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

  for (const order of ["the exchange first", "the end first"] as const)
    it(`authorization code exchange against disconnect all, ${order}`, async () => {
      const { code, exchange } = await approvedCode()
      const row = await holdRow("AuthorizationCode", sha256(code))
      let exchanged: ReturnType<typeof exchange>
      let ended: Promise<number>
      if (order === "the exchange first") {
        exchanged = exchange()
        await waitForBlocked(row.pid, 1)
        ended = h.access.disconnectAll(ownerBy)
        await waitForBlocked(row.pid, 2)
      } else {
        ended = h.access.disconnectAll(ownerBy)
        await waitForBlocked(row.pid, 1)
        exchanged = exchange()
        await waitForBlocked(row.pid, 2)
      }
      await row.release()
      const [res, count] = await Promise.all([exchanged, ended])
      expect(count).toBe(1)
      expect(await live()).toBe(0)
      if (res.status === 200) {
        expect((await h.access.checkToken(res.body.access_token, "mcp")).ok).toBe(false)
        await h.access.sweep()
        expect(await h.access.provider?.AccessToken.find(res.body.access_token)).toBeUndefined()
      }
    })

  for (const order of ["the change first", "the answer first"] as const)
    it(`consent answer against an identity change, ${order}`, async () => {
      const { uid } = await openRequest()
      const gate = await holdGate()
      const decide = () =>
        browserCall(h.owner, `/connect/approve/${uid}/decision`, { json: { approve: true, areas: ["read"] } })
      let answer: ReturnType<typeof decide>
      let change: Promise<string>
      if (order === "the change first") {
        change = h.access.identity.begin(ownerBy)
        await waitForBlocked(gate.pid, 1)
        answer = decide()
        await waitForBlocked(gate.pid, 2)
      } else {
        answer = decide()
        await waitForBlocked(gate.pid, 1)
        change = h.access.identity.begin(ownerBy)
        await waitForBlocked(gate.pid, 2)
      }
      await gate.release()
      const [res, id] = await Promise.all([answer, change])
      expect(res.status).toBe(order === "the change first" ? 410 : 200)
      expect(await live()).toBe(0)
      if (order === "the answer first") {
        const ended = await t.ctx.db
          .select()
          .from(agentConnections)
          .where(eq(agentConnections.endReason, "person_changed"))
        expect(ended.length).toBeGreaterThan(0)
      }
      await h.access.identity.finish(id, ownerBy)
    })

  for (const order of ["the change first", "the answer first"] as const)
    it(`consent answer against a new issuer, ${order}`, async () => {
      const moved = await createAgentAccess({
        ctx: t.ctx,
        cookieKeys: [testSecret()],
        storeDb: h.storeDb.db,
        cipher: createSettingsCipher([{ version: 1, value: TEST_SETTINGS_KEY }]),
        publicUrl: h.issuer.replace("127.0.0.1", "localhost"),
      })
      const { uid } = await openRequest()
      const gate = await holdGate()
      const decide = () =>
        browserCall(h.owner, `/connect/approve/${uid}/decision`, { json: { approve: true, areas: ["read"] } })
      let answer: ReturnType<typeof decide>
      let change: Promise<void>
      try {
        if (order === "the change first") {
          change = moved.reconcile()
          await waitForBlocked(gate.pid, 1)
          answer = decide()
          await waitForBlocked(gate.pid, 2)
        } else {
          answer = decide()
          await waitForBlocked(gate.pid, 1)
          change = moved.reconcile()
          await waitForBlocked(gate.pid, 2)
        }
        await gate.release()
        const [res] = await Promise.all([answer, change])
        expect(res.status).toBe(order === "the change first" ? 410 : 200)
        expect(await live()).toBe(0)
      } finally {
        // Back to this harness's issuer for the next tests: that ends everything again and revives nothing.
        await gate.release()
        await h.access.reconcile()
      }
      expect(await live()).toBe(0)
    })

  for (const order of ["the refresh first", "the save first"] as const)
    it(`refresh against saving a shorter idle period that the connection is past, ${order}`, async () => {
      const c = await connectWithCode(h)
      const check = await h.access.checkToken(c.tokens.body.access_token, "rest")
      if (!check.ok) throw new Error("not connected")
      await t.ctx.db
        .update(agentConnections)
        .set({ approvedAt: new Date(Date.now() - 10 * 86_400_000) })
        .where(eq(agentConnections.id, check.connection.id))
      const row = await holdRow("RefreshToken", sha256(c.tokens.body.refresh_token))
      let refreshed: ReturnType<typeof refresh>
      let saved: Promise<void>
      if (order === "the refresh first") {
        refreshed = refresh(h.issuer, CLI_CLIENT_ID, c.tokens.body.refresh_token)
        await waitForBlocked(row.pid, 1)
        saved = h.access.saveSettings(ownerBy, { idleDays: 5 })
        await waitForBlocked(row.pid, 2)
      } else {
        saved = h.access.saveSettings(ownerBy, { idleDays: 5 })
        await waitForBlocked(row.pid, 1)
        refreshed = refresh(h.issuer, CLI_CLIENT_ID, c.tokens.body.refresh_token)
        await waitForBlocked(row.pid, 2)
      }
      await row.release()
      const [res] = await Promise.all([refreshed, saved])
      expect(await live()).toBe(0)
      const [ended] = await t.ctx.db.select().from(agentConnections).where(eq(agentConnections.id, check.connection.id))
      expect(ended?.endReason).toBe("unused")
      if (res.status === 200) expect((await h.access.checkToken(res.body.access_token, "rest")).ok).toBe(false)
    })

  it("a password change Better Auth refuses (a wrong current password) leaves no change under way, and approvals work", async () => {
    const wrong = await h.owner.call("POST", "/api/auth/change-password", {
      body: { currentPassword: `${TEST_PASSWORD}x`, newPassword: TEST_PASSWORD },
    })
    expect(wrong.status).toBe(400)
    expect(await t.ctx.db.select().from(agentIdentityChanges)).toEqual([])
    await connectWithCode(h)
    expect(await live()).toBe(1)
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
