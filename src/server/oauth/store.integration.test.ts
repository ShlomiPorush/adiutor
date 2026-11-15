import { randomBytes } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { agentConnections, authUser, oauthStore } from "../db/schema.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import {
  agentCall,
  connectBrowser,
  connectWithCode,
  type OAuthHarness,
  oauthHarness,
  pollDevice,
  refresh,
} from "../testing/oauth.ts"
import { CLI_CLIENT_ID } from "./provider.ts"
import { HASHED_KINDS, sha256, storeAdapter } from "./store.ts"

/*
 * What the store relies on and what the library does with lifetimes:
 * - the pinning tests of the undocumented behaviour the hashing rests on (D1-X 1): they fail when a library update
 *   changes it;
 * - D1k: a spent code or refresh token presented after its expiry, before and after the sweep, by a moved clock.
 */

type Call = { kind: string; method: string; id: string; payload?: Record<string, unknown> }
const calls: Call[] = []

let t: TestDatabase
let h: OAuthHarness

beforeAll(async () => {
  t = await createTestDatabase("oauth_store")
  h = await oauthHarness(t, {
    observeStore: (call) => calls.push({ ...call, payload: call.payload ? { ...call.payload } : undefined }),
  })
})
afterAll(async () => {
  await h?.close()
  await t?.close()
})
afterEach(() => {
  vi.useRealTimers()
})

const connectionsOf = (clientId: string) =>
  t.ctx.db.select().from(agentConnections).where(eq(agentConnections.clientId, clientId))

describe("the hashing's pinned assumptions (D1-X 1)", () => {
  it("stores access tokens, refresh tokens and codes under the value they issue, which is their jti, and looks them up only by it", async () => {
    calls.length = 0
    const c = await connectBrowser(h)
    const next = await refresh(h.issuer, c.clientId, c.tokens.body.refresh_token)
    await agentCall(h.issuer, "/oauth/revoke", { form: { token: next.body.access_token, client_id: c.clientId } })
    const device = await connectWithCode(h)
    await refresh(h.issuer, CLI_CLIENT_ID, device.tokens.body.refresh_token)

    const hashed = calls.filter((x) => HASHED_KINDS.has(x.kind))
    expect(new Set(hashed.map((x) => x.kind))).toEqual(new Set(["AccessToken", "RefreshToken", "AuthorizationCode"]))
    const saved = new Set<string>()
    for (const call of hashed.filter((x) => x.method === "upsert")) {
      // The opaque value equals the record's id and its jti.
      expect(call.payload?.jti).toBe(call.id)
      saved.add(call.id)
    }
    // Every value the client got is a saved id.
    for (const value of [c.code, c.tokens.body.access_token, c.tokens.body.refresh_token, next.body.refresh_token])
      expect(saved.has(value)).toBe(true)
    // Found, consumed and destroyed only by a value the library issued; never by user code or uid.
    for (const call of hashed.filter((x) => x.method !== "upsert")) {
      expect(["find", "consume", "destroy"]).toContain(call.method)
      expect(saved.has(call.id) || call.method === "find").toBe(true)
    }
    expect(hashed.some((x) => x.method === "findByUid" || x.method === "findByUserCode")).toBe(false)
    // Device codes are found again by their user code and by the id an interaction holds: why they are not hashed.
    expect(calls.some((x) => x.kind === "DeviceCode" && x.method === "findByUserCode")).toBe(true)
  })

  it("refuses to store a hashed record whose id is not its jti, and what a database read gives is no token", async () => {
    const Store = storeAdapter(h.storeDb.db, { now: () => new Date(), onReuse: async () => {} })
    const id = randomBytes(32).toString("base64url")
    await expect(
      new Store("AccessToken").upsert(id, { jti: randomBytes(32).toString("base64url") }, 60),
    ).rejects.toThrow()
    await expect(new Store("AccessToken").upsert(id, {}, 60)).rejects.toThrow()
    expect(await new Store("AccessToken").find(id)).toBeUndefined()
    const c = await connectWithCode(h)
    const [row] = await t.ctx.db
      .select()
      .from(oauthStore)
      .where(eq(oauthStore.id, sha256(c.tokens.body.access_token)))
    expect(row?.type).toBe("AccessToken")
    expect(row?.payload).not.toHaveProperty("jti")
    expect((await h.access.checkToken(row?.id ?? "", "rest")).ok).toBe(false)
    expect((await h.access.checkToken(c.tokens.body.access_token, "rest")).ok).toBe(true)
  })
})

describe("spent values after their expiry (D1k)", () => {
  const DAY = 86_400_000

  it("an authorization code spent and presented after it expired is refused, and its grant stays (an accepted gap), before and after the sweep", async () => {
    const c = await connectBrowser(h)
    const exchange = () =>
      agentCall(h.issuer, "/oauth/token", {
        form: {
          grant_type: "authorization_code",
          code: c.code,
          code_verifier: c.verifier,
          client_id: c.clientId,
          redirect_uri: c.redirect,
          resource: c.resource,
        },
      })
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 120_000 })
    const late = await exchange()
    expect(late.status).toBe(400)
    expect(late.body.error).toBe("invalid_grant")
    let tokens = (await refresh(h.issuer, c.clientId, c.tokens.body.refresh_token)).body
    expect(tokens.access_token).toBeTruthy()
    vi.setSystemTime(Date.now() + 2 * DAY)
    await h.access.sweep()
    const swept = await exchange()
    expect(swept.status).toBe(400)
    tokens = (await refresh(h.issuer, c.clientId, tokens.refresh_token)).body
    expect((await h.access.checkToken(tokens.access_token, "mcp")).ok).toBe(true)
    expect((await connectionsOf(c.clientId))[0]?.endedAt).toBeNull()
  })

  it("a device code collected and presented after it expired gets expired_token, and its grant stays, before and after the sweep", async () => {
    const c = await connectWithCode(h)
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11 * 60_000 })
    const late = await pollDevice(h.issuer, c.device.body.device_code)
    expect(late.body.error).toBe("expired_token")
    let tokens = (await refresh(h.issuer, CLI_CLIENT_ID, c.tokens.body.refresh_token)).body
    expect(tokens.access_token).toBeTruthy()
    vi.setSystemTime(Date.now() + 2 * DAY)
    await h.access.sweep()
    const swept = await pollDevice(h.issuer, c.device.body.device_code)
    expect(swept.body.error).toBe("invalid_grant")
    tokens = (await refresh(h.issuer, CLI_CLIENT_ID, tokens.refresh_token)).body
    expect((await h.access.checkToken(tokens.access_token, "rest")).ok).toBe(true)
  })

  for (const sweepFirst of [false, true])
    it(`a connection kept in use past 365 days ends when its first spent refresh token comes back (${sweepFirst ? "after" : "before"} the sweep)`, async () => {
      const c = await connectWithCode(h)
      const first = c.tokens.body.refresh_token
      let tokens = c.tokens.body
      const check = await h.access.checkToken(tokens.access_token, "rest")
      if (!check.ok) throw new Error("not connected")
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() })
      // Five steps of 80 days, each shorter than the 90 idle days, with a real call after every refresh.
      for (let step = 1; step <= 5; step++) {
        vi.setSystemTime(Date.now() + 80 * DAY)
        const next = await refresh(h.issuer, CLI_CLIENT_ID, tokens.refresh_token)
        expect(next.status, `day ${step * 80}`).toBe(200)
        tokens = next.body
        expect((await h.access.checkToken(tokens.access_token, "rest", { use: true })).ok).toBe(true)
        await h.access.sweep()
      }
      if (sweepFirst) await h.access.sweep()
      const replay = await refresh(h.issuer, CLI_CLIENT_ID, first)
      expect(replay.status).toBe(400)
      expect((await h.access.checkToken(tokens.access_token, "rest")).ok).toBe(false)
      await vi.waitFor(async () => {
        const [row] = await t.ctx.db.select().from(agentConnections).where(eq(agentConnections.id, check.connection.id))
        expect(row?.endReason).toBe("refresh_reused")
      })
    })
})

// Last in this file: it removes the owner.
describe("the owner", () => {
  it("is checked on every call: a connection whose owner is gone ends for good, and the library issues nothing more", async () => {
    const c = await connectWithCode(h)
    const check = await h.access.checkToken(c.tokens.body.access_token, "rest")
    if (!check.ok) throw new Error("not connected")
    await t.ctx.db.delete(authUser)
    expect((await h.access.checkToken(c.tokens.body.access_token, "rest")).ok).toBe(false)
    const [row] = await t.ctx.db.select().from(agentConnections).where(eq(agentConnections.id, check.connection.id))
    expect(row?.endReason).toBe("person_changed")
    expect((await refresh(h.issuer, CLI_CLIENT_ID, c.tokens.body.refresh_token)).status).toBe(400)
  })
})
