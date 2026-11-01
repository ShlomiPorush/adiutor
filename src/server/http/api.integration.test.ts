import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp } from "../app.ts"
import { VISIT_SAFETY_MARGIN_MS } from "../db/client.ts"
import { testCore } from "../testing/app.ts"
import { TestBrowser } from "../testing/browser.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import { RateLimiter } from "./auth.ts"

const OWNER = "owner-token-for-tests-only-000000000000"
const AGENT = "agent-token-for-tests-only-000000000000"
const ORIGIN = "http://127.0.0.1:8090"

let t: TestDatabase
let app: ReturnType<typeof createApp>

function build(publicUrl = ORIGIN) {
  return createApp({
    checkDatabase: async () => true,
    core: testCore(t, {
      config: { ownerToken: OWNER, agentToken: AGENT, publicUrl: new URL(publicUrl), version: "test" },
      limiter: new RateLimiter(10, 60_000),
      clientIp: (c) => c.req.header("x-test-ip") ?? "client",
    }),
  })
}

beforeAll(async () => {
  t = await createTestDatabase("http")
})
afterAll(async () => {
  await t?.close()
})
beforeEach(async () => {
  await t.reset()
  app = build()
})

type Init = { method?: string; token?: string; cookie?: string; body?: unknown; headers?: Record<string, string> }

async function call(path: string, init: Init = {}) {
  const headers: Record<string, string> = { ...init.headers }
  if (init.token) headers.authorization = `Bearer ${init.token}`
  if (init.cookie) headers.cookie = init.cookie
  if (init.body !== undefined) headers["content-type"] = "application/json"
  const res = await app.request(`/api/v1${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null }
}

const browser = { "x-mikud-request": "1", origin: ORIGIN }

/** The owner, set up and signed in with TOTP; returns the browser and its cookie header. */
async function signedIn() {
  const owner = new TestBrowser((request) => app.fetch(request))
  await owner.owner()
  return { cookie: owner.cookieHeader, owner }
}

describe("authentication", () => {
  it("logs a failing query without its text or parameters", async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)))
    try {
      // PostgreSQL refuses a NUL character in text, so the insert fails with the owner's text as a parameter.
      const marker = "owner-private-note-4711"
      const res = await call("/items", {
        method: "POST",
        token: OWNER,
        body: { type: "task", title: "Logged", body: `${marker}${String.fromCharCode(0)}` },
      })
      expect(res.status).toBe(500)
      expect(res.json.error.code).toBe("internal_error")
    } finally {
      spy.mockRestore()
    }
    const logged = lines.join(" ")
    expect(logged).toContain('"msg":"request failed"')
    expect(logged).toContain('"sqlstate":"22021"')
    expect(logged).not.toContain("owner-private-note-4711")
    expect(logged).not.toMatch(/insert into|params/i)
  })

  it("refuses a request without a token or cookie", async () => {
    const res = await call("/projects")
    expect(res.status).toBe(401)
    expect(res.json).toEqual({ error: { code: "unauthorized", message: expect.any(String) } })
  })

  it("refuses a wrong or malformed token", async () => {
    expect((await call("/projects", { token: `${OWNER}x` })).json.error.code).toBe("unauthorized")
    expect((await call("/projects", { headers: { authorization: OWNER } })).status).toBe(401)
    expect((await call("/projects", { headers: { authorization: "Bearer" } })).status).toBe(401)
  })

  it("accepts the owner and the agent token", async () => {
    expect((await call("/session", { token: OWNER })).json.data.actor).toEqual({ kind: "owner", label: "owner" })
    const agentSession = await call("/session", { token: AGENT, headers: { "x-mikud-agent": "codex <thread>" } })
    expect(agentSession.json.data.actor).toEqual({ kind: "agent", label: "agent:codex thread" })
  })

  it("answers 403 to the agent on owner routes", async () => {
    const item = await call("/items", { method: "POST", token: AGENT, body: { type: "task", title: "Keep" } })
    const project = await call("/projects", { method: "POST", token: OWNER, body: { name: "Example" } })
    const projectId = project.json.data.id
    for (const [method, path, body] of [
      ["DELETE", `/items/${item.json.data.id}`, undefined],
      ["DELETE", `/projects/${projectId}`, undefined],
      ["PATCH", `/projects/${projectId}`, { stage: "production" }],
      ["POST", "/projects", { name: "By agent" }],
      ["GET", "/settings", undefined],
      ["PATCH", "/settings", { closedItemDays: 3 }],
      ["GET", "/account/sessions", undefined],
      ["POST", "/account/sessions/end-all", undefined],
      ["POST", "/account/password", { currentPassword: "x", newPassword: "y".repeat(12) }],
      ["POST", "/session/activity", undefined],
      ["GET", "/suppressions", undefined],
    ] as const) {
      const res = await call(path, { method, token: AGENT, body })
      expect([method, path, res.status, res.json?.error?.code]).toEqual([method, path, 403, "forbidden"])
    }
    expect((await call(`/items/${item.json.data.id}`, { token: AGENT })).status).toBe(200)
  })

  it("rate-limits failed token attempts per client", async () => {
    for (let i = 0; i < 10; i++)
      expect((await call("/projects", { token: "wrong", headers: { "x-test-ip": "attacker" } })).status).toBe(401)
    const blocked = await call("/projects", { token: OWNER, headers: { "x-test-ip": "attacker" } })
    expect(blocked.status).toBe(429)
    expect(blocked.json.error.code).toBe("rate_limited")
    // A forged forwarding header is not the address: the count stays.
    const forged = await call("/projects", {
      token: OWNER,
      headers: { "x-test-ip": "attacker", "x-forwarded-for": "198.51.100.7" },
    })
    expect(forged.status).toBe(429)
    expect((await call("/projects", { token: OWNER, headers: { "x-test-ip": "someone-else" } })).status).toBe(200)
  })
})

describe("browser sessions", () => {
  it("lets a signed-in browser act as the owner, with the CSRF header and Origin on changes", async () => {
    const { cookie } = await signedIn()
    const session = await call("/session", { cookie })
    expect(session.json.data).toMatchObject({ actor: { kind: "owner", label: "owner.name" }, via: "session" })
    expect(session.json.data.clocks.max.remainingSec).toBeGreaterThan(29 * 86_400)
    expect(session.json.data.clocks.idle).toBeNull()

    const body = { type: "task", title: "From the browser" }
    const noHeader = await call("/items", { method: "POST", cookie, body, headers: { origin: ORIGIN } })
    expect([noHeader.status, noHeader.json.error.code]).toEqual([403, "forbidden"])
    const badOrigin = await call("/items", {
      method: "POST",
      cookie,
      body,
      headers: { "x-mikud-request": "1", origin: "https://evil.example" },
    })
    expect(badOrigin.status).toBe(403)
    const noOrigin = await call("/items", { method: "POST", cookie, body, headers: { "x-mikud-request": "1" } })
    expect(noOrigin.status).toBe(403)
    // Reads are plain same-origin reads.
    expect((await call("/account/sessions", { cookie })).status).toBe(200)
    const ok = await call("/items", { method: "POST", cookie, body, headers: browser })
    expect(ok.status).toBe(201)
    expect(ok.json.data.createdBy).toBe("owner")
    const history = await call(`/audit?entityId=${ok.json.data.id}`, { cookie })
    expect(history.json.data[0]).toMatchObject({ actorKind: "owner", actorLabel: "owner.name", source: "ui" })
  })

  it("never lets a session stand in for a token: sync pushes and MCP refuse it", async () => {
    const { cookie } = await signedIn()
    const snapshot = { collectedAt: new Date().toISOString(), projects: [], threads: [] }
    expect((await call("/sync/t3", { method: "POST", cookie, body: snapshot, headers: browser })).status).toBe(403)
    const mcp = await app.request("/mcp", {
      method: "POST",
      headers: {
        cookie,
        ...browser,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(mcp.status).toBe(401)
  })

  it("gives the browser an identity cookie that never authenticates, and records visits for it", async () => {
    const { owner } = await signedIn()
    const first = await owner.call("GET", "/api/v1/session")
    const browserCookie = first.setCookies.find((c) => c.startsWith("mikud_browser="))
    expect(browserCookie).toMatch(/HttpOnly/)
    expect(browserCookie).toMatch(/SameSite=Lax/)
    expect(browserCookie).not.toMatch(/Secure/)
    const browserId = first.json.data.browserId
    // Alone, the identity cookie is nobody.
    const alone = await call("/session", { cookie: `mikud_browser=${browserId}` })
    expect([alone.status, alone.json.error.code]).toEqual([401, "unauthorized"])
    // The same browser keeps its identity.
    expect((await owner.call("GET", "/api/v1/session")).json.data.browserId).toBe(browserId)

    const visit = await owner.call("POST", "/api/v1/visits")
    expect(visit.status).toBe(201)
    const view = await owner.call("GET", "/api/v1/morning")
    expect(view.json.data.since).toBe(visit.json.data.at)
    expect((await call("/visits", { method: "POST", token: OWNER })).status).toBe(403)
  })

  it("keeps a page's boundary on refresh and records a visit no later than the read that was shown", async () => {
    const { owner } = await signedIn()
    const get = async (path: string) => (await owner.call("GET", `/api/v1${path}`)).json
    const first = await get("/morning")
    const { since, now: asOf } = first.data
    expect(new Date(asOf).getTime()).toBeLessThanOrEqual(t.ctx.clock().getTime())
    // Arrives after the read was shown: never marked seen by the visit that follows it.
    t.clock.travel(60_000)
    await call("/items", { method: "POST", token: AGENT, body: { type: "task", title: "Arrived later" } })
    const visit = await owner.call("POST", "/api/v1/visits", { body: { at: asOf } })
    expect(visit.status).toBe(201)
    // Recorded a safety margin before the read (see db/client.ts).
    expect(visit.json.data.at).toBe(new Date(new Date(asOf).getTime() - VISIT_SAFETY_MARGIN_MS).toISOString())

    const titles = (view: { data: { new: { item: { title: string } }[] } }) => view.data.new.map((n) => n.item.title)
    const refresh = await get(`/morning?since=${encodeURIComponent(since)}`)
    expect(refresh.data.since).toBe(since)
    expect(titles(refresh)).toContain("Arrived later")
    const next = await get("/morning")
    expect(next.data.since).toBe(visit.json.data.at)
    expect(titles(next)).toContain("Arrived later")

    // A time after the server's clock is recorded as now; a bad one is refused.
    const future = new Date(t.ctx.clock().getTime() + 86_400_000).toISOString()
    const late = await owner.call("POST", "/api/v1/visits", { body: { at: future } })
    expect(new Date(late.json.data.at).getTime()).toBeLessThanOrEqual(t.ctx.clock().getTime())
    expect((await owner.call("GET", "/api/v1/morning?since=yesterday")).status).toBe(400)
  })
})

describe("routes and error codes", () => {
  it("validates bodies and ids", async () => {
    const bad = await call("/items", { method: "POST", token: AGENT, body: { type: "chore", title: "x" } })
    expect(bad.status).toBe(400)
    expect(bad.json.error).toMatchObject({
      code: "validation_failed",
      issues: [expect.objectContaining({ path: "type" })],
    })
    const notJson = await app.request("/api/v1/items", {
      method: "POST",
      headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" },
      body: "{",
    })
    expect(notJson.status).toBe(400)
    expect((await call("/items/not-a-uuid", { token: AGENT })).json.error.code).toBe("not_found")
    expect((await call("/items/00000000-0000-4000-8000-000000000000", { token: AGENT })).status).toBe(404)
    expect((await call("/nothing-here", { token: AGENT })).json.error.code).toBe("not_found")
  })

  it("answers version_conflict and secret_suspected", async () => {
    const created = await call("/items", { method: "POST", token: AGENT, body: { type: "task", title: "Edit me" } })
    const id = created.json.data.id
    expect(
      (await call(`/items/${id}`, { method: "PATCH", token: AGENT, body: { version: 1, title: "A" } })).status,
    ).toBe(200)
    const stale = await call(`/items/${id}`, { method: "PATCH", token: AGENT, body: { version: 1, title: "B" } })
    expect([stale.status, stale.json.error.code, stale.json.error.currentVersion]).toEqual([409, "version_conflict", 2])
    const token = `${"gh"}p_${"Ab1Cd2Ef3G".repeat(4)}`
    const secret = await call(`/items/${id}/comments`, { method: "POST", token: AGENT, body: { text: `use ${token}` } })
    expect([secret.status, secret.json.error.code, secret.json.error.rule]).toEqual([
      422,
      "secret_suspected",
      "github_token",
    ])
    expect(JSON.stringify(secret.json)).not.toContain(token)
  })

  it("starts threads, refuses child threads, and captures into the inbox", async () => {
    const body = { threadId: "thread-http", parentThreadId: null, title: "Do the thing" }
    const first = await call("/threads/start", { method: "POST", token: AGENT, body })
    const second = await call("/threads/start", { method: "POST", token: AGENT, body })
    expect([first.status, second.status]).toEqual([201, 200])
    expect(second.json.data.item.id).toBe(first.json.data.item.id)
    const child = await call("/threads/start", {
      method: "POST",
      token: AGENT,
      body: { ...body, threadId: "child", parentThreadId: "thread-http" },
    })
    expect([child.status, child.json.error.code]).toEqual([422, "not_top_level"])
    const missingParent = await call("/threads/start", {
      method: "POST",
      token: AGENT,
      body: { threadId: "x", title: "No parent field" },
    })
    expect(missingParent.status).toBe(400)
    const captured = await call("/capture", { method: "POST", token: AGENT, body: { text: "Idea for later" } })
    expect(captured.json.data).toMatchObject({ type: "idea", status: "future", projectId: null })
    // The started thread had no project either: both wait in the inbox.
    expect((await call("/inbox", { token: AGENT })).json.data.map((i: { title: string }) => i.title)).toEqual([
      "Idea for later",
      "Do the thing",
    ])
  })

  it("takes sync pushes with a token only", async () => {
    const snapshot = { collectedAt: new Date().toISOString(), projects: [], threads: [] }
    const res = await call("/sync/t3", { method: "POST", token: AGENT, body: snapshot })
    expect(res.json.data).toMatchObject({ outcome: "succeeded" })
    const security = await call("/sync/security", {
      method: "POST",
      token: AGENT,
      body: { collectedAt: new Date().toISOString(), repos: [] },
    })
    expect(security.status).toBe(200)
    expect((await call("/sync/runs", { token: AGENT })).json.data).toHaveLength(2)
  })

  it("lets the owner delete an item and a suppression shows up", async () => {
    const started = await call("/threads/start", {
      method: "POST",
      token: AGENT,
      body: { threadId: "thread-del", parentThreadId: null, title: "Delete" },
    })
    const id = started.json.data.item.id
    expect((await call(`/items/${id}?version=99`, { method: "DELETE", token: OWNER })).status).toBe(409)
    expect((await call(`/items/${id}`, { method: "DELETE", token: OWNER })).status).toBe(204)
    const suppressions = await call("/suppressions", { token: OWNER })
    expect(suppressions.json.data).toEqual([expect.objectContaining({ kind: "thread", externalId: "thread-del" })])
    const again = await call("/threads/start", {
      method: "POST",
      token: AGENT,
      body: { threadId: "thread-del", parentThreadId: null, title: "Delete" },
    })
    expect([again.status, again.json.error.code]).toEqual([409, "suppressed"])
  })
})
