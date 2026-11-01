import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
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
    core: {
      ctx: t.ctx,
      config: { ownerToken: OWNER, agentToken: AGENT, publicUrl: new URL(publicUrl), version: "test" },
      limiter: new RateLimiter(10, 60_000),
      clientIp: (c) => c.req.header("x-test-ip") ?? "client",
    },
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

/** Pairs a browser and returns its cookie header. */
async function pair(label = "Desktop") {
  const res = await call("/pair", { method: "POST", body: { token: OWNER, label }, headers: browser })
  expect(res.status).toBe(201)
  const cookie = res.headers.get("set-cookie") ?? ""
  return { cookie: cookie.split(";")[0] ?? "", raw: cookie, deviceId: res.json.data.device.id as string }
}

describe("authentication", () => {
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
      ["GET", "/devices", undefined],
      ["POST", "/devices/end-all", undefined],
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
    const pairing = await call("/pair", {
      method: "POST",
      body: { token: OWNER },
      headers: { ...browser, "x-test-ip": "attacker" },
    })
    expect(pairing.status).toBe(429)
    expect((await call("/projects", { token: OWNER, headers: { "x-test-ip": "someone-else" } })).status).toBe(200)
  })
})

describe("browser pairing", () => {
  it("sets a host-only HttpOnly Lax cookie for 400 days, without Secure on a loopback http URL", async () => {
    const { raw, deviceId } = await pair()
    expect(raw).toMatch(/^mikud_device=[A-Za-z0-9_-]{43};/)
    expect(raw).toContain("Max-Age=34560000")
    expect(raw).toContain("HttpOnly")
    expect(raw).toContain("SameSite=Lax")
    expect(raw).toContain("Path=/")
    expect(raw).not.toMatch(/Domain=/i)
    expect(raw).not.toContain("Secure")
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("sets Secure for any other public URL", async () => {
    app = build("https://mikud.example.com")
    const res = await call("/pair", {
      method: "POST",
      body: { token: OWNER },
      headers: { "x-mikud-request": "1", origin: "https://mikud.example.com" },
    })
    expect(res.status).toBe(201)
    expect(res.headers.get("set-cookie")).toContain("Secure")
  })

  it("pairs only with the owner token, from the Mikud page", async () => {
    expect((await call("/pair", { method: "POST", body: { token: AGENT }, headers: browser })).status).toBe(403)
    expect((await call("/pair", { method: "POST", body: { token: "nope" }, headers: browser })).status).toBe(401)
    expect((await call("/pair", { method: "POST", body: { token: OWNER } })).status).toBe(403)
    expect(
      (
        await call("/pair", {
          method: "POST",
          body: { token: OWNER },
          headers: { ...browser, origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403)
  })

  it("lets a paired browser act as the owner, with the CSRF header and Origin on changes", async () => {
    const { cookie, deviceId } = await pair()
    const session = await call("/session", { cookie })
    expect(session.json.data).toEqual({ actor: { kind: "owner", label: "device:Desktop" }, via: "cookie", deviceId })

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
    const ok = await call("/items", { method: "POST", cookie, body, headers: browser })
    expect(ok.status).toBe(201)
    expect(ok.json.data.createdBy).toBe("owner")
    const history = await call(`/audit?entityId=${ok.json.data.id}`, { cookie })
    expect(history.json.data[0]).toMatchObject({ actorKind: "owner", actorLabel: "device:Desktop", source: "ui" })
  })

  it("refuses a revoked device, and lists devices without their hash", async () => {
    const { cookie, deviceId } = await pair()
    const devices = await call("/devices", { token: OWNER })
    expect(devices.json.data).toHaveLength(1)
    expect(devices.json.data[0]).not.toHaveProperty("secretHash")
    expect((await call(`/devices/${deviceId}`, { method: "DELETE", token: OWNER })).status).toBe(204)
    const res = await call("/session", { cookie })
    expect([res.status, res.json.error.code]).toEqual([401, "unauthorized"])
  })

  it("ends every device, and a browser can end its own session", async () => {
    const one = await pair("One")
    const two = await pair("Two")
    expect((await call("/session", { method: "DELETE", cookie: one.cookie, headers: browser })).status).toBe(204)
    expect((await call("/session", { cookie: one.cookie })).status).toBe(401)
    const ended = await call("/devices/end-all", { method: "POST", cookie: two.cookie, headers: browser })
    expect(ended.json.data).toEqual({ ended: 1 })
    expect((await call("/session", { cookie: two.cookie })).status).toBe(401)
  })

  it("records visits for the browser's device only", async () => {
    const { cookie } = await pair()
    const visit = await call("/visits", { method: "POST", cookie, headers: browser })
    expect(visit.status).toBe(201)
    const view = await call("/morning", { cookie })
    expect(view.json.data.since).toBe(visit.json.data.at)
    expect((await call("/visits", { method: "POST", token: OWNER })).status).toBe(403)
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
    const { cookie } = await pair()
    expect((await call("/sync/t3", { method: "POST", cookie, body: snapshot, headers: browser })).status).toBe(403)
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
