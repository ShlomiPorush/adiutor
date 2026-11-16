import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { CONNECT_CLIENT_ID } from "../../shared/auth.ts"
import { disconnectEvery } from "../../web/pages/settings/disconnectAll.ts"
import { createApp } from "../app.ts"
import { audit, authApiKey, authDeviceCode, authSession } from "../db/schema.ts"
import { createAgentKey, type TestCore, testCore } from "../testing/app.ts"
import { TEST_ORIGIN, TestBrowser } from "../testing/browser.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import { totp } from "../testing/totp.ts"

// The agent approval of the releases before agent access, closed by it (D12, src/server/auth/auth.ts): `adiutor
// connect` asked Better Auth's deviceAuthorization for a code, received a session token, sent it with bearer() to
// /api-key/create and ended that session. Its routes and /api-key/create now answer 404 over HTTP, bearer() is gone,
// and Better Auth's routes take no Authorization header, so no key can be made and no session works as a bearer.
// The keys left over are listed and deleted in Settings until the clean-up release (Phase 4). Agent access refusing
// those keys on /api/v1 and /mcp is in agents/rest and agents/mcp, and an old skill copy in oauth/clients.

let t: TestDatabase
let core: TestCore
let app: ReturnType<typeof createApp>
let lastIp = 0

/** A documentation address of its own for each client: Better Auth keys its rate limits on X-Forwarded-For. */
const nextIp = () => `192.0.2.${(lastIp++ % 250) + 1}`

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  t = await createTestDatabase("approval")
})
afterAll(async () => {
  await t?.close()
  vi.restoreAllMocks()
})
beforeEach(async () => {
  await t.reset()
  core = testCore(t, { config: { publicUrl: new URL(TEST_ORIGIN), version: "test" } })
  app = createApp({ checkDatabase: async () => true, core })
})
afterEach(async () => {
  await core.telegramService.stop()
})

const browser = () => new TestBrowser((request) => app.fetch(request), TEST_ORIGIN, { "x-forwarded-for": nextIp() })

/** The owner's signed-in browser (two-factor on). */
async function owner(): Promise<TestBrowser> {
  const b = browser()
  await b.owner()
  return b
}

type Reply = { status: number; json: Record<string, unknown> & { [key: string]: unknown } }

/** The old CLI: no cookie, no Origin, its own User-Agent and address. */
async function cli(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.fetch(
    new Request(`${TEST_ORIGIN}${path}`, {
      method,
      headers: {
        "user-agent": CONNECT_CLIENT_ID,
        "x-forwarded-for": nextIp(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  const text = await response.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: response.status, json } as Reply
}

/** The owner's own session token, as the Account page's browsers list shows it. */
async function sessionToken(b: TestBrowser): Promise<string> {
  const listed = await b.call("GET", "/api/auth/list-sessions")
  return (listed.json as { token: string }[])[0]?.token as string
}

describe("the old agent approval is closed (D12)", () => {
  it("answers 404 to every route of `adiutor connect` and of the owner's approval, with a session or without", async () => {
    const b = await owner()
    const code = await cli("POST", "/api/auth/device/code", { client_id: CONNECT_CLIENT_ID })
    expect([code.status, code.json.code]).toEqual([404, "NOT_FOUND"])
    const poll = await cli("POST", "/api/auth/device/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "a-device-code",
      client_id: CONNECT_CLIENT_ID,
    })
    expect(poll.status).toBe(404)
    for (const [method, path, body] of [
      ["GET", "/api/auth/device?user_code=ABCD-EFGH", undefined],
      ["POST", "/api/auth/device/approve", { userCode: "ABCD-EFGH" }],
      ["POST", "/api/auth/device/deny", { userCode: "ABCD-EFGH" }],
      ["POST", "/api/auth/api-key/create", { name: "sync", expiresIn: 30 * 86_400 }],
    ] as const) {
      const signedIn = await b.call(method, path, body === undefined ? {} : { body })
      expect([path, signedIn.status, signedIn.json?.code]).toEqual([path, 404, "NOT_FOUND"])
      expect([path, (await cli(method, path, body)).status]).toEqual([path, 404])
    }
    expect(await t.ctx.db.select().from(authDeviceCode)).toHaveLength(0)
    expect(await t.ctx.db.select().from(authApiKey)).toHaveLength(0)
    expect(
      (await t.ctx.db.select().from(audit)).map((r) => r.action).filter((a) => /^(device|api_key)\./.test(a)),
    ).toEqual([])
  })
})

describe("bearer() is gone: Better Auth's routes take the browser's session only", () => {
  it("refuses a session token sent as a bearer on every route, ending itself included, with or without the cookie", async () => {
    const b = await owner()
    const token = await sessionToken(b)
    const bearer = { authorization: `Bearer ${token}` }
    for (const [method, path, body] of [
      ["GET", "/api/auth/get-session", undefined],
      ["GET", "/api/auth/list-sessions", undefined],
      ["GET", "/api/auth/api-key/list", undefined],
      ["POST", "/api/auth/api-key/delete", { keyId: "x" }],
      ["POST", "/api/auth/revoke-session", { token }],
      ["POST", "/api/auth/revoke-sessions", {}],
      ["POST", "/api/auth/change-password", { currentPassword: "x", newPassword: "y" }],
      ["POST", "/api/auth/sign-out", {}],
    ] as const) {
      const alone = await cli(method, path, body, bearer)
      expect([path, alone.status, alone.json?.code]).toEqual([path, 403, "AUTHORIZATION_NOT_ALLOWED"])
      const withCookie = await b.call(method, path, { ...(body === undefined ? {} : { body }), headers: bearer })
      expect([path, withCookie.status]).toEqual([path, 403])
    }
    // Any other scheme too: no header stands in for the cookie.
    const basic = await cli("GET", "/api/auth/get-session", undefined, { authorization: `Basic ${token}` })
    expect([basic.status, basic.json.code]).toEqual([403, "AUTHORIZATION_NOT_ALLOWED"])
    // The session itself is untouched.
    expect((await t.ctx.db.select().from(authSession)).some((s) => s.token === token)).toBe(true)
    expect((await b.call("GET", "/api/v1/session")).status).toBe(200)
  })

  it("a session token is no key on /api/v1, /mcp and the sync routes, and the setup status reads the cookie only", async () => {
    const b = await owner()
    const bearer = { authorization: `Bearer ${await sessionToken(b)}` }
    expect((await app.request("/api/v1/session", { headers: bearer })).status).toBe(401)
    expect((await app.request("/api/v1/projects", { headers: bearer })).status).toBe(401)
    const sync = await app.request("/api/v1/sync/t3", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ collectedAt: new Date().toISOString(), projects: [], threads: [] }),
    })
    expect(sync.status).toBe(401)
    const mcp = await app.request("/mcp", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(mcp.status).toBe(401)
    const status = await app.request("/api/setup/status", { headers: bearer })
    expect(((await status.json()) as { data: { session: string } }).data.session).toBe("none")
  })

  it("G10 is closed: a sign-in answer hands page script no session token", async () => {
    const secret = await browser().owner()
    const page = browser()
    expect((await page.passwordSignIn()).json.twoFactorRedirect).toBe(true)
    const signedIn = await page.verify(totp(secret))
    expect(signedIn.status).toBe(200)
    expect(signedIn.headers.get("set-auth-token")).toBeNull()
    expect(signedIn.headers.get("access-control-expose-headers") ?? "").not.toContain("set-auth-token")
    // The session lives in its HttpOnly cookie alone.
    const cookie = signedIn.setCookies.find((c) => c.startsWith("better-auth.session_token="))
    expect(cookie).toContain("HttpOnly")
  })
})

describe("the old agent keys in Settings, until the clean-up release", () => {
  it("lists the keys left over and deletes them, each with its audit row", async () => {
    const b = await owner()
    for (const name of ["sync", "claude", "codex"]) await createAgentKey(core, name)
    const listed = (await b.call("GET", "/api/auth/api-key/list")).json as {
      apiKeys: { id: string; name: string; expiresAt: string | null; createdAt: string }[]
    }
    expect(listed.apiKeys.map((k) => k.name).sort()).toEqual(["claude", "codex", "sync"])
    for (const k of listed.apiKeys)
      expect((await b.call("POST", "/api/auth/api-key/delete", { body: { keyId: k.id } })).status).toBe(200)
    expect(((await b.call("GET", "/api/auth/api-key/list")).json as { total: number }).total).toBe(0)
    const rows = (await t.ctx.db.select().from(audit)).filter((r) => r.action === "api_key.delete")
    expect(rows.map((r) => r.source)).toEqual(["ui", "ui", "ui"])
  })

  it("one list answers at most 100 of 101 keys; listing again after each round deletes every key", async () => {
    const b = await owner()
    const [user] = await t.ctx.db.select({ id: authSession.userId }).from(authSession).limit(1)
    for (let i = 0; i < 101; i++)
      await core.auth.current.api.createApiKey({
        body: { userId: user?.id as string, name: `agent-${i}`, expiresIn: 86_400 },
      })
    // The library's limit, shown to the owner as it is: the database adapter's default of 100 rows.
    const first = (await b.call("GET", "/api/auth/api-key/list")).json as { apiKeys: { id: string }[]; total: number }
    expect([first.apiKeys.length, first.total]).toEqual([100, 100])

    // Each request from its own address: Better Auth allows 100 a minute per address and route.
    const result = await disconnectEvery(
      async () =>
        (
          (await b.call("GET", "/api/auth/api-key/list", { headers: { "x-forwarded-for": nextIp() } })).json as {
            apiKeys: { id: string }[]
          }
        ).apiKeys,
      async (keyId) => {
        const answer = await b.call("POST", "/api/auth/api-key/delete", {
          body: { keyId },
          headers: { "x-forwarded-for": nextIp() },
        })
        if (answer.status !== 200) throw new Error(`delete answered ${answer.status}`)
      },
    )
    expect(result).toEqual({ removed: 101, remaining: 0, atLeast: false })
    expect(await t.ctx.db.select().from(authApiKey)).toHaveLength(0)
  })
})
