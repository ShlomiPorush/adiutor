import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { and, eq, isNull, like, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import he from "../../shared/locales/he.json"
import { resetOwnerPassword } from "../auth/recovery.ts"
import { agentConnections, agentConsent, agentIdentityChanges, audit, oauthStore } from "../db/schema.ts"
import { morning } from "../services/reads.ts"
import { TEST_AUTH_SECRET } from "../testing/app.ts"
import { TEST_PASSWORD } from "../testing/browser.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import {
  agentCall,
  answerConsent,
  browserCall,
  confirmCode,
  connectBrowser,
  connectWithCode,
  deviceRequest,
  type OAuthHarness,
  oauthHarness,
  ownerBy,
  pollDevice,
  refresh,
  register,
  uidOf,
  wideLimits,
} from "../testing/oauth.ts"
import { totp } from "../testing/totp.ts"
import { WindowLimit } from "./limits.ts"
import { processStart, procfs } from "./process.ts"
import { CLI_CLIENT_ID } from "./provider.ts"
import { openDeviceRequests, roomForClient, sha256 } from "./store.ts"

/*
 * Every way a connection ends, for good (testing.md, OAuth and Consent): the owner's disconnect and disconnect all,
 * agents turned off, the idle rule, a new issuer, the owner's identity changes; the approval API's refusals; the limits.
 */

let t: TestDatabase
let h: OAuthHarness

beforeAll(async () => {
  t = await createTestDatabase("oauth_ending")
  h = await oauthHarness(t)
})
afterAll(async () => {
  await h?.close()
  await t?.close()
})
beforeEach(async () => {
  await h.access.saveSettings(ownerBy, { enabled: true, idleDays: 90 })
})
afterEach(() => {
  vi.useRealTimers()
})

const live = async () => (await t.ctx.db.select().from(agentConnections).where(isNull(agentConnections.endedAt))).length
async function connectionOfToken(token: string, resource: "mcp" | "rest" = "rest") {
  const check = await h.access.checkToken(token, resource)
  if (!check.ok) throw new Error("the token is not live")
  return check.connection
}
const rowOf = async (id: string) =>
  (await t.ctx.db.select().from(agentConnections).where(eq(agentConnections.id, id)))[0]

describe("the sync shown as disconnected", () => {
  it("after a reused refresh token ends its connection, the morning read says the sync is disconnected", async () => {
    const sync = await connectWithCode(h, { scope: "sync", label: "Laptop sync", areas: ["sync"] })
    expect((await morning(t.ctx)).sync.connected).toBe(true)
    // A refresh whose answer was lost, sent again: the spent token is reuse, and the whole connection ends.
    const first = await refresh(h.issuer, CLI_CLIENT_ID, sync.tokens.body.refresh_token)
    expect(first.status).toBe(200)
    expect((await refresh(h.issuer, CLI_CLIENT_ID, sync.tokens.body.refresh_token)).status).toBe(400)
    expect((await h.access.checkToken(first.body.access_token, "rest")).ok).toBe(false)
    expect((await morning(t.ctx)).sync.connected).toBe(false)
  })

  it("past the idle days, before the sweep ends it, the morning read already says the sync is disconnected", async () => {
    const sync = await connectWithCode(h, { scope: "sync", label: "Idle sync", areas: ["sync"] })
    const row = await connectionOfToken(sync.tokens.body.access_token)
    expect((await morning(t.ctx)).sync.connected).toBe(true)
    const old = new Date(Date.now() - 91 * 86_400_000)
    await t.ctx.db
      .update(agentConnections)
      .set({ approvedAt: old, lastUsedAt: old })
      .where(eq(agentConnections.id, row.id))
    expect((await rowOf(row.id))?.endedAt).toBeNull()
    expect((await morning(t.ctx)).sync.connected).toBe(false)
  })
})

describe("disconnecting", () => {
  it("ends one connection at once, and its tokens fail", async () => {
    const c = await connectWithCode(h)
    const row = await connectionOfToken(c.tokens.body.access_token)
    await h.access.disconnect(ownerBy, row.id)
    expect((await h.access.checkToken(c.tokens.body.access_token, "rest")).ok).toBe(false)
    expect((await refresh(h.issuer, CLI_CLIENT_ID, c.tokens.body.refresh_token)).status).toBe(400)
    expect(await rowOf(row.id)).toMatchObject({ endReason: "disconnected", endedBy: "owner" })
    await expect(h.access.disconnect(ownerBy, row.id)).rejects.toMatchObject({ code: "not_found" })
  })

  it("ends every connection, waiting codes, device requests and open approvals, and a new generation starts", async () => {
    const a = await connectWithCode(h)
    await connectBrowser(h)
    const device = await deviceRequest(h.issuer)
    const waitingUid = await confirmCode(h.owner, (await deviceRequest(h.issuer)).body.user_code)
    expect(await live()).toBeGreaterThanOrEqual(2)
    const ended = await h.access.disconnectAll(ownerBy)
    expect(ended).toBeGreaterThanOrEqual(2)
    expect(await live()).toBe(0)
    expect((await h.access.checkToken(a.tokens.body.access_token, "rest")).ok).toBe(false)
    const waiting = await t.ctx.db
      .select()
      .from(oauthStore)
      .where(sql`${oauthStore.type} in ('AuthorizationCode', 'DeviceCode', 'Interaction')`)
    expect(waiting).toEqual([])
    expect(await t.ctx.db.select().from(agentConsent)).toEqual([])
    expect((await pollDevice(h.issuer, device.body.device_code)).status).toBe(400)
    expect((await browserCall(h.owner, `/connect/approve/${waitingUid}/details`)).status).toBe(410)
    const actions = (await t.ctx.db.select().from(audit)).map((r) => r.action)
    expect(actions).toContain("agent.end_all")
  })

  it("stays available with nothing to end", async () => {
    await h.access.disconnectAll(ownerBy)
    const res = await browserCall(h.owner, "/api/v1/agents/connections/disconnect-all", {
      method: "POST",
      json: {},
      headers: { "x-adiutor-request": "1" },
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ended: 0 })
  })

  it("lists and disconnects through the owner's API, and refuses an agent key there", async () => {
    const c = await connectWithCode(h, { label: "Owner list" })
    const list = await browserCall(h.owner, "/api/v1/agents/connections")
    expect(list.status).toBe(200)
    const item = list.body.connections.find((x: { name: string }) => x.name === "Owner list")
    expect(item).toMatchObject({ via: "code", resource: "rest", areas: ["read", "write"], lastUsedAt: null })
    const gone = await browserCall(h.owner, `/api/v1/agents/connections/${item.id}`, {
      method: "DELETE",
      headers: { "x-adiutor-request": "1" },
    })
    expect(gone.status).toBe(204)
    expect((await h.access.checkToken(c.tokens.body.access_token, "rest")).ok).toBe(false)
    const agentKey = await agentCall(h.issuer, "/api/v1/agents/connections", {
      headers: { authorization: `Bearer ${c.tokens.body.access_token}` },
    })
    expect(agentKey.status).toBe(401)
  })
})

describe("the agents switch", () => {
  it("off ends every connection in the same transaction, answers 404 on every OAuth address, and on revives nothing", async () => {
    const c = await connectWithCode(h)
    const row = await connectionOfToken(c.tokens.body.access_token)
    await h.access.saveSettings(ownerBy, { enabled: false })
    expect(await rowOf(row.id)).toMatchObject({ endReason: "turned_off" })
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/api/v1",
      "/oauth/token",
      "/connect/code",
    ])
      expect((await agentCall(h.issuer, path)).status, path).toBe(404)
    expect(await h.access.checkToken(c.tokens.body.access_token, "rest")).toEqual({ ok: false, reason: "agents_off" })
    await h.access.saveSettings(ownerBy, { enabled: true })
    expect((await h.access.checkToken(c.tokens.body.access_token, "rest")).ok).toBe(false)
    expect(await live()).toBe(0)
  })

  it("ends at start every connection a turn-off left behind", async () => {
    await connectWithCode(h)
    // As if the process stopped between saving the switch and ending the connections.
    await t.ctx.db.execute(sql`update settings set agents_enabled = false`)
    await h.access.reconcile()
    expect(await live()).toBe(0)
  })

  it("saves two changes at once, each on what the other saved", async () => {
    await Promise.all([
      h.access.saveSettings(ownerBy, { idleDays: 30 }),
      h.access.saveSettings(ownerBy, { enabled: true }),
    ])
    expect(await h.access.agentSettings()).toEqual({ enabled: true, idleDays: 30 })
    await expect(h.access.saveSettings(ownerBy, { idleDays: 0 })).rejects.toMatchObject({ code: "validation_failed" })
    await expect(
      h.access.saveSettings({ actor: { kind: "agent", label: "agent" }, source: "api" }, { enabled: false }),
    ).rejects.toMatchObject({ code: "forbidden" })
  })
})

describe("the idle rule", () => {
  it("ends a connection not used for the idle days, for good, by Adiutor's clock; a refresh is not use", async () => {
    const used = await connectWithCode(h)
    const idle = await connectWithCode(h)
    const idleRow = await connectionOfToken(idle.tokens.body.access_token)
    expect((await h.access.checkToken(used.tokens.body.access_token, "rest", { use: true })).ok).toBe(true)
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60 * 86_400_000 })
    const usedNext = await refresh(h.issuer, CLI_CLIENT_ID, used.tokens.body.refresh_token)
    expect((await h.access.checkToken(usedNext.body.access_token, "rest", { use: true })).ok).toBe(true)
    // Refreshed, never used for a call.
    const idleNext = await refresh(h.issuer, CLI_CLIENT_ID, idle.tokens.body.refresh_token)
    expect(idleNext.status).toBe(200)
    vi.setSystemTime(Date.now() + 40 * 86_400_000)
    await h.access.sweep()
    expect(await rowOf(idleRow.id)).toMatchObject({ endReason: "unused", endedBy: "system" })
    expect((await h.access.checkToken(idleNext.body.access_token, "rest")).ok).toBe(false)
    const usedNow = await refresh(h.issuer, CLI_CLIENT_ID, usedNext.body.refresh_token)
    expect((await h.access.checkToken(usedNow.body.access_token, "rest", { use: true })).ok).toBe(true)
    // A longer idle period saved later revives nothing.
    await h.access.saveSettings(ownerBy, { idleDays: 365 })
    expect((await h.access.checkToken(idleNext.body.access_token, "rest")).ok).toBe(false)
  })

  it("ends a connection the check finds past the idle days, and keeps one used while the sweep was on its way", async () => {
    const c = await connectWithCode(h)
    const row = await connectionOfToken(c.tokens.body.access_token)
    // The sweep picked it as unused; a call came in before it ended it.
    await t.ctx.db.update(agentConnections).set({ lastUsedAt: new Date() }).where(eq(agentConnections.id, row.id))
    expect(await h.access.end({ id: row.id }, "unused", ownerBy, new Date(Date.now() - 86_400_000))).toBeNull()
    expect((await rowOf(row.id))?.endedAt).toBeNull()
    await t.ctx.db
      .update(agentConnections)
      .set({ lastUsedAt: new Date(Date.now() - 91 * 86_400_000), approvedAt: new Date(Date.now() - 91 * 86_400_000) })
      .where(eq(agentConnections.id, row.id))
    expect((await h.access.checkToken(c.tokens.body.access_token, "rest")).ok).toBe(false)
    expect(await rowOf(row.id)).toMatchObject({ endReason: "unused" })
  })

  it("ends a connection already past the period in force when a longer one is saved, before the sweep saw it", async () => {
    const c = await connectWithCode(h)
    const row = await connectionOfToken(c.tokens.body.access_token)
    await t.ctx.db
      .update(agentConnections)
      .set({ approvedAt: new Date(Date.now() - 91 * 86_400_000) })
      .where(eq(agentConnections.id, row.id))
    await h.access.saveSettings(ownerBy, { idleDays: 365 })
    expect(await rowOf(row.id)).toMatchObject({ endReason: "unused", endedBy: "owner" })
    expect((await h.access.checkToken(c.tokens.body.access_token, "rest")).ok).toBe(false)
    expect((await refresh(h.issuer, CLI_CLIENT_ID, c.tokens.body.refresh_token)).status).toBe(400)
  })

  it("ends at once every connection idle longer than fewer idle days saved", async () => {
    const c = await connectWithCode(h)
    const row = await connectionOfToken(c.tokens.body.access_token)
    await t.ctx.db
      .update(agentConnections)
      .set({ approvedAt: new Date(Date.now() - 10 * 86_400_000) })
      .where(eq(agentConnections.id, row.id))
    await h.access.saveSettings(ownerBy, { idleDays: 5 })
    expect(await rowOf(row.id)).toMatchObject({ endReason: "unused", endedBy: "owner" })
  })
})

describe("the issuer", () => {
  it("ends every connection when the public URL changes, and changing it back revives none", async () => {
    const { createAgentAccess } = await import("./access.ts")
    const { createSettingsCipher } = await import("../settings/crypto.ts")
    const { TEST_SETTINGS_KEY } = await import("../testing/app.ts")
    const { testSecret } = await import("../testing/secrets.ts")
    const c = await connectWithCode(h)
    const row = await connectionOfToken(c.tokens.body.access_token)
    const options = {
      ctx: t.ctx,
      cookieKeys: [testSecret()],
      storeDb: h.storeDb.db,
      cipher: createSettingsCipher([{ version: 1, value: TEST_SETTINGS_KEY }]),
    }
    const moved = await createAgentAccess({ ...options, publicUrl: h.issuer.replace("127.0.0.1", "localhost") })
    await moved.reconcile()
    expect(await rowOf(row.id)).toMatchObject({ endReason: "issuer_changed", endedBy: "system" })
    // Back to the first address: the process that runs it sees the change at its first check.
    expect((await h.access.checkToken(c.tokens.body.access_token, "rest")).ok).toBe(false)
    expect((await rowOf(row.id))?.endReason).toBe("issuer_changed")
    expect(await live()).toBe(0)
  })

  it("ends every connection when the public URL becomes one agents cannot use, and changing back revives none", async () => {
    const { createAgentAccess } = await import("./access.ts")
    const { createSettingsCipher } = await import("../settings/crypto.ts")
    const { TEST_SETTINGS_KEY } = await import("../testing/app.ts")
    const { testSecret } = await import("../testing/secrets.ts")
    const c = await connectWithCode(h)
    const row = await connectionOfToken(c.tokens.body.access_token)
    // The same host, refused as an issuer (a path makes it no origin).
    const refused = await createAgentAccess({
      ctx: t.ctx,
      cookieKeys: [testSecret()],
      storeDb: h.storeDb.db,
      cipher: createSettingsCipher([{ version: 1, value: TEST_SETTINGS_KEY }]),
      publicUrl: `${h.issuer}/adiutor`,
    })
    expect(refused.issuer).toBeNull()
    await refused.reconcile()
    expect(await rowOf(row.id)).toMatchObject({ endReason: "issuer_changed", endedBy: "system" })
    // Back to the first address.
    await h.access.reconcile()
    expect((await h.access.checkToken(c.tokens.body.access_token, "rest")).ok).toBe(false)
    expect((await refresh(h.issuer, CLI_CLIENT_ID, c.tokens.body.refresh_token)).status).toBe(400)
    expect(await live()).toBe(0)
  })

  it("refuses a public URL agents cannot use: every OAuth address answers 404 and the settings say why", async () => {
    const other = await createTestDatabase("oauth_http")
    try {
      const plain = await oauthHarness(other, { publicUrl: (origin) => origin.replace("127.0.0.1", "localhost.") })
      try {
        expect(plain.access.issuer).toBeNull()
        expect(plain.access.issuerProblem).toBe("plain_http")
        for (const path of ["/.well-known/oauth-authorization-server", "/oauth/token", "/oauth/register"])
          expect((await agentCall(plain.issuer, path)).status, path).toBe(404)
        const settings = await browserCall(plain.owner, "/api/v1/agents/settings")
        expect(settings.body).toMatchObject({ issuer: null, issuerProblem: "plain_http" })
      } finally {
        await plain.close()
      }
    } finally {
      await other.close()
    }
  })
})

describe("the approval API", () => {
  async function openRequest() {
    const device = await deviceRequest(h.issuer)
    return confirmCode(h.owner, device.body.user_code)
  }

  it("answers only the owner's browser: no bearer, no agent key, no session", async () => {
    const uid = await openRequest()
    const path = `/connect/approve/${uid}/details`
    expect((await browserCall(h.owner, path, { headers: { authorization: "Bearer x" } })).status).toBe(403)
    expect((await browserCall(h.owner, path, { headers: { "x-api-key": "x" } })).status).toBe(403)
    expect((await agentCall(h.issuer, path)).status).toBe(401)
    const ok = await browserCall(h.owner, path)
    expect(ok.status).toBe(200)
    expect(ok.headers.get("cache-control")).toBe("no-store")
    expect(ok.headers.get("x-frame-options")).toBe("DENY")
    expect(ok.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer")
  })

  it("refuses an answer without the issuer's Origin, from another site, or not JSON", async () => {
    const uid = await openRequest()
    await browserCall(h.owner, `/connect/approve/${uid}/details`)
    const path = `/connect/approve/${uid}/decision`
    const cookie = h.owner.cookieHeader
    const post = (headers: Record<string, string>, body: string) =>
      fetch(`${h.issuer}${path}`, { method: "POST", headers: { cookie, ...h.owner.extra, ...headers }, body })
    const json = JSON.stringify({ approve: true, areas: ["read"] })
    expect((await post({ "content-type": "application/json" }, json)).status).toBe(403)
    expect((await post({ "content-type": "application/json", origin: "https://evil.example.com" }, json)).status).toBe(
      403,
    )
    expect(
      (await post({ "content-type": "application/x-www-form-urlencoded", origin: h.issuer }, "approve=true")).status,
    ).toBe(415)
    expect(await live()).toBe(0)
  })

  it("grants only areas shown, never none, and answers once", async () => {
    const device = await agentCall(h.issuer, "/oauth/device", {
      form: { client_id: CLI_CLIENT_ID, scope: "read", resource: `${h.issuer}/api/v1` },
    })
    const uid = await confirmCode(h.owner, device.body.user_code)
    const details = await browserCall(h.owner, `/connect/approve/${uid}/details`)
    expect(details.body.areas).toEqual(["read"])
    const decide = (body: unknown) => browserCall(h.owner, `/connect/approve/${uid}/decision`, { json: body })
    expect((await decide({ approve: true, areas: ["read", "write"] })).status).toBe(400)
    expect((await decide({ approve: true, areas: ["sync"] })).status).toBe(400)
    expect((await decide({ approve: true, areas: [] })).status).toBe(400)
    expect((await decide({ approve: true, areas: ["read"], extra: 1 })).status).toBe(400)
    const answers = await Promise.all([
      decide({ approve: true, areas: ["read"] }),
      decide({ approve: false }),
      decide({ approve: true, areas: ["read"] }),
    ])
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1)
    expect(answers.filter((a) => a.status === 410)).toHaveLength(2)
    expect(await live()).toBeLessThanOrEqual(1)
  })

  it("never offers sync to an MCP client, and offers read and write when it asked for nothing known", async () => {
    const c = await connectBrowser(h, { scope: "sync admin" })
    expect(c.consent.details.body.areas).toEqual(["read", "write"])
  })

  it("refuses a request that began before every connection ended", async () => {
    const uid = await openRequest()
    await browserCall(h.owner, `/connect/approve/${uid}/details`)
    const before = await t.ctx.db.select().from(agentConsent)
    const stored = await t.ctx.db
      .select()
      .from(oauthStore)
      .where(sql`${oauthStore.type} in ('Interaction', 'Session', 'DeviceCode')`)
    await h.access.disconnectAll(ownerBy)
    // As if the library stored the request's records after the end: only the generation refuses it now.
    await t.ctx.db.insert(agentConsent).values(before)
    await t.ctx.db.insert(oauthStore).values(stored)
    const res = await browserCall(h.owner, `/connect/approve/${uid}/decision`, {
      json: { approve: true, areas: ["read"] },
    })
    expect(res.status).toBe(410)
    expect(await live()).toBe(0)
  })
})

describe("identity changes", () => {
  it("a password change by the signed-in owner ends every connection; approvals open again after", async () => {
    await connectWithCode(h)
    const res = await h.owner.call("POST", "/api/auth/change-password", {
      body: { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD },
    })
    expect(res.status).toBe(200)
    expect(await live()).toBe(0)
    const ends = await t.ctx.db.select().from(agentConnections).where(eq(agentConnections.endReason, "person_changed"))
    expect(ends.length).toBeGreaterThan(0)
    expect(await t.ctx.db.select().from(agentIdentityChanges)).toEqual([])
    await connectWithCode(h)
    expect(await live()).toBe(1)
  })

  it("a change refused for a wrong password or without a session ends nothing", async () => {
    await connectWithCode(h)
    const before = await live()
    const wrong = await h.owner.call("POST", "/api/auth/change-password", {
      body: { currentPassword: `${TEST_PASSWORD}x`, newPassword: TEST_PASSWORD },
    })
    expect(wrong.status).toBe(400)
    const anonymous = await agentCall(h.issuer, "/api/auth/change-password", {
      json: { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD },
      headers: { origin: h.issuer },
    })
    expect(anonymous.status).toBe(401)
    expect(await live()).toBe(before)
  })

  it("the recovery command's reset ends every connection", async () => {
    await connectWithCode(h)
    const result = await resetOwnerPassword({
      ctx: t.ctx,
      secrets: [{ version: 1, value: TEST_AUTH_SECRET }],
      publicUrl: new URL(h.issuer),
      trustedProxies: [],
      sessionIdleDays: 30,
      identityChanges: h.access.identity,
    })
    expect(result).not.toBeNull()
    expect(await live()).toBe(0)
    expect(await t.ctx.db.select().from(agentIdentityChanges)).toEqual([])
    // The owner signs in again with the new password.
    await h.owner.signIn(h.ownerSecret, undefined, result?.password)
    await h.owner.call("POST", "/api/auth/change-password", {
      body: { currentPassword: result?.password, newPassword: TEST_PASSWORD },
    })
  })

  it("turning two-factor off ends every connection, and no approval is possible until it is on again", async () => {
    await connectWithCode(h)
    const off = await h.owner.call("POST", "/api/auth/two-factor/disable", { body: { password: TEST_PASSWORD } })
    expect(off.status).toBe(200)
    expect(await live()).toBe(0)
    const uid = await confirmCode(h.owner, (await deviceRequest(h.issuer)).body.user_code)
    expect((await browserCall(h.owner, `/connect/approve/${uid}/details`)).status).toBe(403)
    const enrolment = await h.owner.enable(TEST_PASSWORD)
    expect((await h.owner.verify(totp(enrolment.secret))).status).toBe(200)
    h.ownerSecret = enrolment.secret
  })

  it("answers no approval while a change is under way, however long, and again once it is done", async () => {
    const device = await deviceRequest(h.issuer)
    const uid = await confirmCode(h.owner, device.body.user_code)
    await browserCall(h.owner, `/connect/approve/${uid}/details`)
    const change = await h.access.identity.begin(ownerBy)
    const first = await answerConsent(h.owner, uid, { approve: true, areas: ["read"] })
    expect(first.decision.status).toBe(410)
    await h.access.identity.finish(change, ownerBy)
    await connectWithCode(h)
    expect(await live()).toBe(1)
  })

  it("keeps approvals closed after a change that failed outside Better Auth's errors, until its process is gone", async () => {
    // A failure that is not an APIError between the hooks: the account update itself fails.
    await t.ctx.db.execute(
      sql.raw(`create or replace function adiutor_test_fail() returns trigger language plpgsql as $$
        begin raise exception 'injected'; end $$`),
    )
    await t.ctx.db.execute(
      sql.raw(
        `create trigger adiutor_test_fail before update on auth_account for each row execute function adiutor_test_fail()`,
      ),
    )
    try {
      const res = await h.owner.call("POST", "/api/auth/change-password", {
        body: { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD },
      })
      expect(res.status).toBe(500)
    } finally {
      await t.ctx.db.execute(sql.raw("drop trigger adiutor_test_fail on auth_account"))
    }
    expect(await t.ctx.db.select().from(agentIdentityChanges)).toHaveLength(1)
    const uid = await confirmCode(h.owner, (await deviceRequest(h.issuer)).body.user_code)
    expect((await answerConsent(h.owner, uid, { approve: true, areas: ["read"] })).decision.status).toBe(410)
    // Its process (this one) still runs: a start or a sweep now leaves it under way (open gap, owner's decision).
    await h.access.reconcile()
    await h.access.sweep()
    expect(await t.ctx.db.select().from(agentIdentityChanges)).toHaveLength(1)
    // Once that process is gone, the next start finishes it: its after hook can never run now.
    const dead = await deadProcess()
    await t.ctx.db.update(agentIdentityChanges).set({ pid: dead.pid, processStartedAt: dead.startedAt })
    await h.access.reconcile()
    expect(await t.ctx.db.select().from(agentIdentityChanges)).toEqual([])
    await connectWithCode(h)
    expect(await live()).toBe(1)
  })

  it("finishes at start and in the sweep only changes whose process is certainly gone", async () => {
    const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"])
    try {
      await new Promise((resolve) => alive.once("spawn", resolve))
      const dead = await deadProcess()
      const here = hostname()
      const row = (id: string, pid: number, startedAt: string | null, host = here) => ({
        id,
        startedAt: new Date(),
        host,
        pid,
        processStartedAt: startedAt,
      })
      const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]
      await t.ctx.db.insert(agentIdentityChanges).values([
        // Another process that runs now, such as the recovery command: stays.
        row(ids[0] as string, alive.pid as number, processStart(alive.pid as number)),
        // A process that stopped: finished.
        row(ids[1] as string, dead.pid, dead.startedAt),
        // A live pid that now belongs to a process started at another time: finished.
        row(ids[2] as string, alive.pid as number, "1"),
        // Another host: not certain, stays.
        row(ids[3] as string, dead.pid, dead.startedAt, "another-host"),
        // No start time recorded: not certain, stays.
        row(ids[4] as string, dead.pid, null),
      ])
      await h.access.sweep()
      const left = (await t.ctx.db.select().from(agentIdentityChanges)).map((r) => r.id).sort()
      expect(left).toEqual([ids[0], ids[3], ids[4]].sort())
      await h.access.reconcile()
      expect((await t.ctx.db.select().from(agentIdentityChanges)).length).toBe(3)
    } finally {
      alive.kill()
      await t.ctx.db.delete(agentIdentityChanges)
    }
  })
})

describe("stuck identity changes", () => {
  const rowOfProcess = (id: string, pid: number, startedAt: string | null, host = hostname()) => ({
    id,
    startedAt: new Date(),
    host,
    pid,
    processStartedAt: startedAt,
  })

  it("keeps a change whose process cannot be read (a read or parse failure), never counting it as gone", async () => {
    const dead = await deadProcess()
    const id = randomUUID()
    await t.ctx.db.insert(agentIdentityChanges).values(rowOfProcess(id, dead.pid, dead.startedAt))
    const original = procfs.readStat
    const failures: (() => string)[] = [
      () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" })
      },
      () => "1 (node) S 1 2 3",
    ]
    try {
      for (const failure of failures) {
        procfs.readStat = (pid) => (pid === dead.pid ? failure() : original(pid))
        await h.access.sweep()
        await h.access.reconcile()
        expect((await t.ctx.db.select().from(agentIdentityChanges)).map((r) => r.id)).toEqual([id])
      }
      // Read normally again, the process is gone (ENOENT): finished.
      procfs.readStat = original
      await h.access.sweep()
      expect(await t.ctx.db.select().from(agentIdentityChanges)).toEqual([])
    } finally {
      procfs.readStat = original
      await t.ctx.db.delete(agentIdentityChanges)
    }
  })

  /**
   * Disconnect all with `row` as the only identity change: what is left, the count its audit row names, and whether an
   * approval is still refused afterwards.
   */
  async function disconnectAllWith(row: typeof agentIdentityChanges.$inferInsert) {
    await t.ctx.db.delete(agentIdentityChanges)
    await t.ctx.db.insert(agentIdentityChanges).values(row)
    const before = (await t.ctx.db.select({ id: audit.id }).from(audit)).map((r) => r.id)
    await h.access.disconnectAll(ownerBy)
    const left = (await t.ctx.db.select().from(agentIdentityChanges)).map((r) => r.id)
    const [end] = (await t.ctx.db.select().from(audit).where(eq(audit.action, "agent.end_all"))).filter(
      (r) => !before.includes(r.id),
    )
    const uid = await confirmCode(h.owner, (await deviceRequest(h.issuer)).body.user_code)
    const answer = await answerConsent(h.owner, uid, { approve: true, areas: ["read"] })
    return {
      left,
      cleared: (end?.after as { identityChangesCleared?: number } | undefined)?.identityChangesCleared,
      approval: answer.decision.status,
    }
  }

  async function withLiveProcess<T>(run: (pid: number) => Promise<T>): Promise<T> {
    const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"])
    try {
      await new Promise((resolve) => alive.once("spawn", resolve))
      return await run(alive.pid as number)
    } finally {
      alive.kill()
      await t.ctx.db.delete(agentIdentityChanges)
      await h.access.disconnectAll(ownerBy)
    }
  }

  it("Disconnect all keeps a change of this host whose process cannot be read, and approvals stay blocked", async () => {
    await withLiveProcess(async (pid) => {
      const id = randomUUID()
      const original = procfs.readStat
      procfs.readStat = (p) => {
        if (p === pid) throw Object.assign(new Error("permission denied"), { code: "EACCES" })
        return original(p)
      }
      try {
        const result = await disconnectAllWith(rowOfProcess(id, pid, processStart(pid) ?? "1"))
        expect(result).toEqual({ left: [id], cleared: 0, approval: 410 })
      } finally {
        procfs.readStat = original
      }
    })
  })

  it("Disconnect all keeps a change of this host with no recorded start time whose pid lives", async () => {
    await withLiveProcess(async (pid) => {
      const id = randomUUID()
      expect(await disconnectAllWith(rowOfProcess(id, pid, null))).toEqual({ left: [id], cleared: 0, approval: 410 })
    })
  })

  it("Disconnect all keeps a change of a live process on this host", async () => {
    await withLiveProcess(async (pid) => {
      const id = randomUUID()
      const result = await disconnectAllWith(rowOfProcess(id, pid, processStart(pid)))
      expect(result).toEqual({ left: [id], cleared: 0, approval: 410 })
    })
  })

  it("Disconnect all clears a change of another host (an earlier container), and approvals work again", async () => {
    await withLiveProcess(async (pid) => {
      const row = rowOfProcess(randomUUID(), pid, processStart(pid), "an-earlier-container")
      const result = await disconnectAllWith(row)
      expect(result).toEqual({ left: [], cleared: 1, approval: 200 })
    })
  })

  it("Disconnect all clears a change of this host whose process is gone (ENOENT), and approvals work again", async () => {
    const dead = await deadProcess()
    const result = await disconnectAllWith(rowOfProcess(randomUUID(), dead.pid, dead.startedAt))
    expect(result).toEqual({ left: [], cleared: 1, approval: 200 })
    await h.access.disconnectAll(ownerBy)
  })
})

/** The identity of a process that ran on this host and has ended. */
async function deadProcess(): Promise<{ pid: number; startedAt: string | null }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"])
  await new Promise((resolve) => child.once("spawn", resolve))
  const identity = { pid: child.pid as number, startedAt: processStart(child.pid as number) }
  expect(identity.startedAt).not.toBeNull()
  const exited = new Promise((resolve) => child.once("exit", resolve))
  child.kill()
  await exited
  return identity
}

describe("limits", () => {
  it("lets exactly the limit through when registrations arrive at once, and audits the block once", async () => {
    const other = await createTestDatabase("oauth_limits")
    const limits = { ...wideLimits(), register: new WindowLimit(3, 3_600_000) }
    const tight = await oauthHarness(other, { limits })
    try {
      const answers = await Promise.all(Array.from({ length: 8 }, () => register(tight.issuer)))
      expect(answers.filter((a) => a.status === 201)).toHaveLength(3)
      expect(answers.filter((a) => a.status === 429)).toHaveLength(5)
      const blocked = await other.ctx.db.select().from(audit).where(eq(audit.action, "agent.blocked"))
      expect(blocked).toHaveLength(1)
      expect(JSON.stringify(blocked[0]?.after)).toContain("register")
    } finally {
      await tight.close()
      await other.close()
    }
  })

  it("gives back a device poll whose code is waiting, so waiting agents never spend the refresh quota", async () => {
    const other = await createTestDatabase("oauth_polls")
    const limits = { ...wideLimits(), token: new WindowLimit(3, 600_000) }
    const tight = await oauthHarness(other, { limits })
    try {
      const device = await deviceRequest(tight.issuer)
      for (let i = 0; i < 6; i++)
        expect((await pollDevice(tight.issuer, device.body.device_code)).body.error).toBe("authorization_pending")
      // A poll with a code that cannot succeed stays counted.
      for (let i = 0; i < 3; i++) await pollDevice(tight.issuer, "x".repeat(43))
      expect((await pollDevice(tight.issuer, device.body.device_code)).status).toBe(429)
    } finally {
      await tight.close()
      await other.close()
    }
  })

  it("counts codes typed on the code page per provider session", async () => {
    const other = await createTestDatabase("oauth_codes")
    const limits = { ...wideLimits(), codeSession: new WindowLimit(2, 600_000) }
    const tight = await oauthHarness(other, { limits })
    try {
      let page = await browserCall(tight.owner, "/connect/code")
      const tries = []
      for (let i = 0; i < 3; i++) {
        // Each answer renders the form again with a new xsrf value.
        const xsrf = /name="xsrf" value="([^"]+)"/.exec(page.text)?.[1] ?? ""
        page = await browserCall(tight.owner, "/connect/code", { form: { xsrf, user_code: "BCDF-GHJK" } })
        tries.push(page.status)
      }
      expect(tries).toEqual([200, 200, 429])
    } finally {
      await tight.close()
      await other.close()
    }
  })

  it("holds both caps under parallel requests: registrations evict the oldest unapproved, device requests are refused", async () => {
    const other = await createTestDatabase("oauth_caps")
    const capped = await oauthHarness(other, { caps: { clients: 3, deviceRequests: 2 } })
    try {
      const registrations = await Promise.all(Array.from({ length: 8 }, () => register(capped.issuer)))
      expect(registrations.every((r) => r.status === 201)).toBe(true)
      expect(await other.ctx.db.select().from(oauthStore).where(eq(oauthStore.type, "Client"))).toHaveLength(3)
      const devices = await Promise.all(Array.from({ length: 5 }, () => deviceRequest(capped.issuer)))
      expect(devices.filter((d) => d.status === 200)).toHaveLength(2)
      expect(devices.filter((d) => d.status === 429)).toHaveLength(3)
    } finally {
      await capped.close()
      await other.close()
    }
  })

  it("caps the pending requests under parallel requests, the oldest unanswered going first", async () => {
    const other = await createTestDatabase("oauth_pending")
    const capped = await oauthHarness(other, { maxPending: 3 })
    try {
      const devices = await Promise.all(Array.from({ length: 8 }, () => deviceRequest(capped.issuer)))
      expect(devices.every((d) => d.status === 200)).toBe(true)
      const pending = await other.ctx.db.select().from(agentConsent).where(like(agentConsent.key, "d:%"))
      expect(pending).toHaveLength(3)
      // An evicted request cannot be approved any more.
      const evicted = devices.find((d) => !pending.some((p) => p.key === `d:${sha256(d.body.device_code)}`))
      const uid = await confirmCode(capped.owner, evicted?.body.user_code)
      expect((await answerConsent(capped.owner, uid, { approve: true, areas: ["read"] })).decision.status).toBe(410)
    } finally {
      await capped.close()
      await other.close()
    }
  })

  it("makes room for a registration by evicting the oldest one nobody approved, never an approved one", async () => {
    await h.access.disconnectAll(ownerBy)
    await t.ctx.db.delete(oauthStore).where(eq(oauthStore.type, "Client"))
    const first = await register(h.issuer)
    const second = await register(h.issuer)
    for (const [client, at] of [
      [first, 1],
      [second, 2],
    ] as const)
      await t.ctx.db
        .update(oauthStore)
        .set({ payload: sql`jsonb_set(${oauthStore.payload}, '{client_id_issued_at}', ${String(at)}::jsonb)` })
        .where(and(eq(oauthStore.type, "Client"), eq(oauthStore.id, client.body.client_id)))
    const count = async () => (await t.ctx.db.select().from(oauthStore).where(eq(oauthStore.type, "Client"))).length
    expect(await roomForClient(t.ctx.db, 2)).toBe(true)
    expect(await count()).toBe(1)
    const ids = (await t.ctx.db.select().from(oauthStore).where(eq(oauthStore.type, "Client"))).map((r) => r.id)
    expect(ids).not.toContain(first.body.client_id)
    expect(ids).toContain(second.body.client_id)
    // Only approved clients left: no room is made.
    await h.access.disconnectAll(ownerBy)
    const approved = await connectBrowser(h)
    await t.ctx.db
      .delete(oauthStore)
      .where(and(eq(oauthStore.type, "Client"), sql`${oauthStore.id} <> ${approved.clientId}`))
    expect(await roomForClient(t.ctx.db, 1)).toBe(false)
  })

  it("counts open device requests for their cap, and a failed read in the middleware holds nothing up", async () => {
    const before = await openDeviceRequests(t.ctx.db, new Date())
    await deviceRequest(h.issuer)
    expect(await openDeviceRequests(t.ctx.db, new Date())).toBe(before + 1)
    await t.ctx.db.execute(sql`alter table agent_state rename to agent_state_away`)
    const failed = await deviceRequest(h.issuer)
    await t.ctx.db.execute(sql`alter table agent_state_away rename to agent_state`)
    expect(failed.status).toBeGreaterThanOrEqual(500)
    const next = await Promise.race([
      deviceRequest(h.issuer),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("held up")), 10_000)),
    ])
    expect(next.status).toBe(200)
  })
})

describe("the audit of approvals", () => {
  it("names the agent, how it connected and the areas, and never a code or token", async () => {
    const c = await connectWithCode(h, { label: "Audit check", areas: ["read"] })
    const [row] = await t.ctx.db
      .select()
      .from(audit)
      .where(and(eq(audit.action, "agent.approve"), sql`${audit.after}->>'name' = 'Audit check'`))
    expect(row?.after).toEqual({ name: "Audit check", via: "code", resource: "rest", areas: ["read"] })
    const dump = JSON.stringify(await t.ctx.db.select().from(audit))
    const hash = createHash("sha256").update(c.device.body.device_code).digest("hex")
    for (const v of [c.device.body.device_code, hash, c.tokens.body.access_token, c.tokens.body.refresh_token])
      expect(dump).not.toContain(v)
  })
})

describe("the authorization code page", () => {
  it("refuses a code that does not exist, and an authorize address with a trailing slash", async () => {
    const page = await browserCall(h.owner, "/connect/code")
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(page.text)?.[1] ?? ""
    const wrong = await browserCall(h.owner, "/connect/code", { form: { xsrf, user_code: "BBBB-BBBB" } })
    expect(wrong.text).toContain(he.agentPages.wrongTitle)
    expect(uidOf(wrong.location)).toBe("")
    expect((await browserCall(h.owner, "/oauth/authorize/")).status).toBe(404)
  })
})
