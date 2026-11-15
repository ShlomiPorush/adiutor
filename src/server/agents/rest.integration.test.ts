import { randomBytes, randomUUID } from "node:crypto"
import { request as httpRequest } from "node:http"
import { connect as netConnect } from "node:net"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createApp } from "../app.ts"
import { agentConnections, audit, items, notes } from "../db/schema.ts"
import { createItem } from "../services/items.ts"
import { createNote } from "../services/notes.ts"
import { createProject } from "../services/projects.ts"
import { createAgentKey } from "../testing/app.ts"
import { createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import { holdRow as holdRowIn } from "../testing/locks.ts"
import {
  browserCall,
  connectBrowser,
  connectWithCode,
  type OAuthHarness,
  oauthHarness,
  ownerBy,
} from "../testing/oauth.ts"
import { channelLimits } from "./channel.ts"
import { HEADERS, OPEN, REVISION } from "./policy.ts"

/*
 * The agent REST channel over real HTTP with real OAuth connections (the agent-access standard, "Policy and channels"):
 * the reserved refusals and their order, the policy and kind headers, the areas, people's credentials, the limits and
 * the audit of every call. The key path and the owner's browser without agent access are covered by
 * http/api.integration.test.ts, unchanged.
 */

let t: TestDatabase
let h: OAuthHarness

/** A 64 KiB answer cap makes the large answer quick to test; the deadline is the real one. */
const LIMITS = { ...channelLimits(), answerBytes: 64 * 1024 }
/** A 3-second deadline, on a harness of its own ("the deadline" below), so no other call can run into it. */
const SHORT = { ...channelLimits(), deadlineMs: 3_000 }

beforeAll(async () => {
  t = await createTestDatabase("agents_rest")
  h = await oauthHarness(t, {
    channel: LIMITS,
    // Each test that counts invalid tokens names its own address.
    clientIp: (c) => c.req.header("x-test-ip") ?? "127.0.0.1",
  })
})
afterAll(async () => {
  await h?.close()
  await t?.close()
})

// biome-ignore lint/suspicious/noExplicitAny: test answers are loose JSON whose shape each test asserts
type Res = { status: number; headers: Headers; text: string; body: any }

async function res(r: Response): Promise<Res> {
  const text = await r.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {}
  return { status: r.status, headers: r.headers, text, body }
}

/** A connection by the device flow (the skill's way) with `areas` granted; its access token and its record. */
async function connect(areas: string[] = ["read", "write"], label = "Test agent") {
  const c = await connectWithCode(h, { scope: areas.join(" "), areas, label })
  const token = String(c.tokens.body.access_token)
  const check = await h.access.checkToken(token, "rest")
  if (!check.ok) throw new Error("the new connection is not valid")
  return { token, id: check.connection.id }
}

const kindOf = (method: string) => (method === "GET" || method === "HEAD" ? "read" : "act")

/** An agent call with the policy headers the skill sends, unless `headers` overrides them. */
async function call(
  token: string | null,
  method: string,
  path: string,
  init: { json?: unknown; headers?: Record<string, string>; raw?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {
    [HEADERS.policy]: REVISION,
    [HEADERS.kind]: kindOf(method),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...init.headers,
  }
  for (const [k, v] of Object.entries(headers)) if (v === "") delete headers[k]
  let body: string | undefined
  if (init.json !== undefined || init.raw !== undefined) {
    headers["content-type"] = "application/json"
    body = init.raw ?? JSON.stringify(init.json)
  }
  return res(await fetch(`${h.issuer}${path}`, { method, headers, body }))
}

/**
 * A request with header lines exactly as given (repeated names stay repeated), on a raw Node client and a connection
 * of its own (the server may close it after an early answer).
 */
function rawCall(method: string, path: string, headers: string[], body?: string): Promise<Res> {
  const url = new URL(h.issuer)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        path,
        method,
        agent: false,
        headers: [
          "host",
          url.host,
          ...headers,
          ...(body === undefined
            ? []
            : ["content-type", "application/json", "content-length", String(Buffer.byteLength(body))]),
        ],
      },
      (answer) => {
        let text = ""
        answer.setEncoding("utf8")
        answer.on("data", (chunk: string) => {
          text += chunk
        })
        answer.on("end", () => {
          let body: unknown = null
          try {
            body = text ? JSON.parse(text) : null
          } catch {}
          const out = new Headers()
          for (const [k, v] of Object.entries(answer.headers)) if (typeof v === "string") out.set(k, v)
          resolve({ status: answer.statusCode ?? 0, headers: out, text, body })
        })
      },
    )
    req.on("error", reject)
    req.end(body)
  })
}

/** The agent call entries of a connection, oldest first. */
async function calls(connectionId: string) {
  // A call's row is written once its answer went out: wait for every row begun.
  await h.mount.drain()
  return t.ctx.db
    .select()
    .from(audit)
    .where(and(inArray(audit.action, ["agent.api_call", "agent.tool_call"]), eq(audit.entityId, connectionId)))
    .orderBy(audit.id)
}

const holdRow = (table: "items" | "notes" | "agent_connections", id: string) => holdRowIn(t, table, id)

async function anItem(title = `Item ${randomUUID()}`) {
  return createItem(t.ctx, owner, { type: "task", title })
}

const RESOURCE_METADATA = () => `${h.issuer}/.well-known/oauth-protected-resource/api/v1`

describe("the reserved refusals", () => {
  it("401: a token that is not valid here, with where to start and nothing else", async () => {
    const r = await call(randomBytes(32).toString("base64url"), "GET", "/api/v1/items", {
      headers: { "x-test-ip": "198.51.100.11" },
    })
    expect(r.status).toBe(401)
    expect(r.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${RESOURCE_METADATA()}", error="invalid_token"`,
    )
    expect(r.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate")
    expect(r.text).toBe(
      '{"error":"invalid_token","message":"The token is not valid here, or the connection has ended."}',
    )
  })

  it("401 invalid_request: an empty, malformed, mixed or repeated Authorization header", async () => {
    const { token } = await connect(["read"])
    for (const header of [
      "Bearer",
      "Bearer ",
      `Basic ${token}`,
      `Bearer ${token} x`,
      `Bearer ${token}, Bearer ${token}`,
    ]) {
      const r = await call(null, "GET", "/api/v1/items", { headers: { authorization: header } })
      expect([header, r.status], header).toEqual([header, 401])
      expect(r.body).toEqual({ error: "invalid_request", message: expect.any(String) })
      expect(r.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${RESOURCE_METADATA()}", error="invalid_request"`,
      )
    }
    const twice = await rawCall("GET", "/api/v1/items", [
      "authorization",
      `Bearer ${token}`,
      "authorization",
      `Bearer ${token}`,
      HEADERS.policy,
      REVISION,
      HEADERS.kind,
      "read",
    ])
    expect(twice.status).toBe(401)
    expect(twice.body.error).toBe("invalid_request")
  })

  it("429: the exact busy body, recorded once per window", async () => {
    const { token, id } = await connect(["read", "write"])
    const item = await anItem()
    const row = await holdRow("items", item.id)
    const slow = Array.from({ length: LIMITS.perConnection }, () =>
      call(token, "PATCH", `/api/v1/items/${item.id}`, { json: { version: 1, title: "Changed" } }),
    )
    try {
      // Every slot holds a call that waits for the row.
      await row.waiting(LIMITS.perConnection)
      const busy = await call(token, "GET", "/api/v1/items")
      const again = await call(token, "GET", "/api/v1/items")
      expect(busy.status).toBe(429)
      expect(busy.text).toBe(
        '{"error":"busy","message":"This connection runs too many calls at once. Nothing was sent; try again."}',
      )
      expect(again.status).toBe(429)
    } finally {
      await row.release()
    }
    const answers = await Promise.all(slow)
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409, 409])
    const entries = await calls(id)
    expect(entries.filter((e) => (e.after as { status?: number }).status === 429)).toHaveLength(1)
    // A connection that is not busy any more gets its slot.
    expect((await call(token, "GET", "/api/v1/items")).status).toBe(200)
  })

  it("409: the exact policy_changed body for a missing, old, unknown, repeated or wrong revision or kind", async () => {
    const { token } = await connect(["read", "write"])
    const exact =
      '{"error":"policy_changed","message":"Adiutor\'s calls changed, or this path names a different call than the list says, or this skill is older than Adiutor. Nothing ran. Run `adiutor endpoints` and take the path from it."}'
    const cases: Record<string, string>[] = [
      { [HEADERS.policy]: "" },
      { [HEADERS.policy]: "0123456789abcdef" },
      { [HEADERS.kind]: "" },
      { [HEADERS.kind]: "write" },
      { [HEADERS.kind]: "act" },
      { [HEADERS.policy]: `${REVISION}, ${REVISION}` },
    ]
    for (const headers of cases) {
      const r = await call(token, "GET", "/api/v1/items", { headers })
      expect([headers, r.status]).toEqual([headers, 409])
      expect(r.text).toBe(exact)
    }
    for (const name of [HEADERS.policy, HEADERS.kind]) {
      const value = name === HEADERS.policy ? REVISION : "read"
      const r = await rawCall("GET", "/api/v1/items", [
        "authorization",
        `Bearer ${token}`,
        HEADERS.policy,
        REVISION,
        HEADERS.kind,
        "read",
        name,
        value,
      ])
      expect([name, r.status]).toEqual([name, 409])
      expect(r.text).toBe(exact)
    }
    // A write declared as a read never runs.
    const title = `Never ${randomUUID()}`
    const read = await call(token, "POST", "/api/v1/items", {
      json: { type: "task", title },
      headers: { [HEADERS.kind]: "read" },
    })
    expect(read.status).toBe(409)
    expect(await t.ctx.db.select().from(items).where(eq(items.title, title))).toEqual([])
  })

  it("answers in the standard's order: 401 for the token, then 403 for the route or area, then 409", async () => {
    const { token } = await connect(["read"])
    const bad = randomBytes(32).toString("base64url")
    const none = { [HEADERS.policy]: "", [HEADERS.kind]: "" }
    expect(
      (await call(bad, "GET", "/api/v1/audit", { headers: { ...none, "x-test-ip": "198.51.100.12" } })).status,
    ).toBe(401)
    const closed = await call(token, "GET", "/api/v1/audit", { headers: none })
    expect(closed.status).toBe(403)
    expect(closed.body).toEqual({ error: "forbidden", message: expect.any(String) })
    const area = await call(token, "POST", "/api/v1/items", { json: { type: "task", title: "x" }, headers: none })
    expect(area.status).toBe(403)
    expect(area.body).toEqual({ error: "area_not_granted", message: expect.any(String), area: "write" })
    expect((await call(token, "GET", "/api/v1/items", { headers: none })).status).toBe(409)
    expect((await call(token, "GET", "/api/v1/items")).status).toBe(200)
  })

  it("never lets a route's own conflict read as a reserved one: version_conflict stays 409 with its own code", async () => {
    const { token } = await connect(["read", "write"])
    const item = await anItem()
    const r = await call(token, "PATCH", `/api/v1/items/${item.id}`, { json: { version: 7, title: "Stale" } })
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ error: "version_conflict", message: expect.any(String), currentVersion: 1 })
    expect(r.headers.get("www-authenticate")).toBeNull()
  })
})

describe("the route the router picked", () => {
  it("is looked up by method and template: letter case, ; parameters, escapes and unknown paths never reach route code", async () => {
    const { token } = await connect(["read", "write"])
    const title = `Escaped ${randomUUID()}`
    for (const path of ["/api/v1/Items", "/api/v1/items;x=1", "/api/v1/items/", "/api/v1/nothing", "/api/v1"]) {
      const r = await call(token, "POST", path, { json: { type: "task", title } })
      expect([path, r.status], path).toEqual([path, 403])
    }
    // An escape the router decodes names the same route; declared as a read it is refused, never run.
    const escaped = await call(token, "POST", "/api/v1/item%73", {
      json: { type: "task", title },
      headers: { [HEADERS.kind]: "read" },
    })
    expect([403, 409]).toContain(escaped.status)
    expect(await t.ctx.db.select().from(items).where(eq(items.title, title))).toEqual([])
  })

  it("counts HEAD as GET", async () => {
    const { token } = await connect(["read"])
    expect((await call(token, "HEAD", "/api/v1/items")).status).toBe(200)
    expect((await call(token, "HEAD", "/api/v1/items", { headers: { [HEADERS.kind]: "act" } })).status).toBe(409)
  })

  it("refuses a bearer token outside the paths with checks of their own: the UI's pages and first-run setup", async () => {
    const { token } = await connect(["read"])
    for (const path of ["/", "/projects", "/api/setup/status"]) {
      const r = await call(token, "GET", path)
      expect([path, r.status]).toEqual([path, 403])
    }
  })
})

describe("areas", () => {
  it("opens each route only to a connection granted its area, on every route of the open map", async () => {
    const project = await createProject(t.ctx, owner, { name: `Areas ${randomUUID()}` })
    const item = await anItem()
    const note = await createNote(t.ctx, owner, { title: `Area note ${randomUUID()}` })
    const fill = (path: string) =>
      path.replace("{id}", path.includes("/projects/") ? project.id : path.includes("/notes/") ? note.id : item.id)
    const read = await connect(["read"], "Reader")
    const write = await connect(["write"], "Writer")
    for (const route of OPEN) {
      const path = fill(route.path)
      const holders =
        route.area === null ? [read, write] : route.area === "read" ? [read] : route.area === "write" ? [write] : []
      const others = [read, write].filter((c) => !holders.includes(c))
      for (const c of others) {
        const r = await call(c.token, route.method, path, { json: route.method === "GET" ? undefined : {} })
        expect([route.path, r.status, r.body?.error]).toEqual([route.path, 403, "area_not_granted"])
      }
      for (const c of holders) {
        const r = await call(c.token, route.method, path, { json: route.method === "GET" ? undefined : {} })
        // Reached the route: its own answer (an empty body is refused by the route itself, 400).
        expect([route.path, r.status === 403 || r.status === 409 || r.status === 401]).toEqual([route.path, false])
      }
    }
  })

  it("lets a connection granted sync push a snapshot, and no other", async () => {
    const sync = await connect(["sync"], "Sync")
    const snapshot = { collectedAt: new Date().toISOString(), projects: [], threads: [] }
    const pushed = await call(sync.token, "POST", "/api/v1/sync/t3", { json: snapshot })
    expect(pushed.status).toBe(200)
    expect((await call(sync.token, "GET", "/api/v1/items")).status).toBe(403)
    const other = await connect(["read", "write"])
    expect((await call(other.token, "POST", "/api/v1/sync/t3", { json: snapshot })).status).toBe(403)
  })

  it("refuses a token made for /mcp on /api/v1", async () => {
    const mcp = await connectBrowser(h, { resource: `${h.issuer}/mcp` })
    const r = await call(String(mcp.tokens.body.access_token), "GET", "/api/v1/items")
    expect(r.status).toBe(401)
    expect(r.body.error).toBe("invalid_token")
  })
})

describe("access and endpoints", () => {
  it("answer without the policy headers: whose account, the areas granted and not, the never list, the end", async () => {
    const { token, id } = await connect(["read"], "Access check")
    const none = { [HEADERS.policy]: "", [HEADERS.kind]: "" }
    const access = await call(token, "GET", "/api/v1/agent/access", { headers: none })
    expect(access.status).toBe(200)
    expect(access.body).toMatchObject({
      account: expect.any(String),
      name: "Access check",
      connection: { via: "code", resource: "rest" },
      areas: [{ area: "read", kinds: ["read"], sentence: expect.any(String) }],
      notGranted: [
        { area: "write", kinds: ["act"] },
        { area: "sync", kinds: ["act"] },
      ],
      never: expect.arrayContaining([expect.stringContaining("Delete items")]),
      ends: { rule: expect.stringContaining("90 days"), lastUsedAt: null, endsAt: expect.any(String) },
      version: "test",
    })
    const list = await call(token, "GET", "/api/v1/agent/endpoints", { headers: none })
    expect(list.status).toBe(200)
    expect(list.body.revision).toBe(REVISION)
    expect(list.body.endpoints.every((e: { area: string }) => e.area === "read" || e.area === "any")).toBe(true)
    expect(list.body.endpoints.find((e: { path: string }) => e.path === "/api/v1/items/{id}")).toMatchObject({
      method: "GET",
      kind: "read",
      parameters: [{ name: "id", in: "path", required: true }],
    })
    expect((await call(token, "GET", "/api/v1/agent/endpoints?area=write", { headers: none })).body.count).toBe(2)
    expect((await call(token, "GET", "/api/v1/agent/endpoints?area=x", { headers: none })).status).toBe(400)
    // Neither counts as use.
    const [row] = await t.ctx.db.select().from(agentConnections).where(eq(agentConnections.id, id))
    expect(row?.lastUsedAt).toBeNull()
  })
})

describe("what counts as use", () => {
  it("a real call that ran does, a refused one does not", async () => {
    const { token, id } = await connect(["read"])
    const used = async () =>
      (await t.ctx.db.select().from(agentConnections).where(eq(agentConnections.id, id)))[0]?.lastUsedAt ?? null
    expect((await call(token, "POST", "/api/v1/items", { json: {} })).status).toBe(403)
    expect((await call(token, "GET", "/api/v1/items", { headers: { [HEADERS.kind]: "act" } })).status).toBe(409)
    expect(await used()).toBeNull()
    expect((await call(token, "GET", "/api/v1/items")).status).toBe(200)
    expect(await used()).toBeInstanceOf(Date)
  })

  it("a connection that ended after its token was checked runs nothing (401)", async () => {
    const { token, id } = await connect(["read", "write"])
    const row = await holdRow("agent_connections", id)
    const title = `After the end ${randomUUID()}`
    // The token is checked (reads), then the call waits to record its use behind the held row.
    const pending = call(token, "POST", "/api/v1/items", { json: { type: "task", title } })
    try {
      await row.waiting()
    } finally {
      // The end commits while the call waits: its update then finds the connection ended.
      await row.release((tx) =>
        tx.execute(
          sql`update agent_connections set ended_at = now(), end_reason = 'disconnected', ended_by = 'owner' where id = ${id}`,
        ),
      )
    }
    const r = await pending
    expect(r.status).toBe(401)
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"')
    expect(await t.ctx.db.select().from(items).where(eq(items.title, title))).toEqual([])
    expect((await calls(id)).at(-1)?.after).toMatchObject({
      route: "POST /api/v1/items",
      outcome: "denied",
      status: 401,
    })
  })
})

describe("people's credentials", () => {
  it("never serve an agent request: the owner's cookie beside a bearer is ignored, also on a closed route", async () => {
    const { token } = await connect(["read"])
    const cookie = h.owner.cookieHeader
    const withCookie = await call(token, "GET", "/api/v1/session", { headers: { cookie } })
    expect(withCookie.status).toBe(403)
    const settings = await call(token, "GET", "/api/v1/settings", { headers: { cookie, "x-adiutor-request": "1" } })
    expect(settings.status).toBe(403)
    const bad = await call(randomBytes(32).toString("base64url"), "GET", "/api/v1/projects", {
      headers: { cookie, "x-test-ip": "198.51.100.13" },
    })
    expect(bad.status).toBe(401)
    const key = await call(token, "GET", "/api/v1/agents/connections", { headers: { cookie, "x-api-key": "x" } })
    expect(key.status).toBe(403)
    // The cookie alone is still the owner's browser, with today's answers.
    const browser = await browserCall(h.owner, "/api/v1/session")
    expect(browser.status).toBe(200)
    expect(browser.body.data.actor.kind).toBe("owner")
  })

  it("refuses an agent key where agent access is mounted: it is not an access token", async () => {
    const key = await createAgentKey(h.core, "old key")
    const r = await call(key, "GET", "/api/v1/projects", { headers: { "x-test-ip": "198.51.100.14" } })
    expect(r.status).toBe(401)
    expect(r.body.error).toBe("invalid_token")
  })

  it("keeps the owner's browser contract on /api/v1: its answers and its error shape", async () => {
    const ok = await browserCall(h.owner, "/api/v1/projects")
    expect(ok.status).toBe(200)
    expect(Array.isArray(ok.body.data)).toBe(true)
    const missing = await browserCall(h.owner, `/api/v1/items/${randomUUID()}`)
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ error: { code: "not_found", message: expect.any(String) } })
  })
})

describe("invalid tokens", () => {
  it("are limited per address, logged once per window", async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)))
    const ip = "198.51.100.99"
    try {
      const max = LIMITS.badTokens.max
      for (let i = 0; i < max; i++) {
        const r = await call(randomBytes(32).toString("base64url"), "GET", "/api/v1/items", {
          headers: { "x-test-ip": ip },
        })
        expect(r.status).toBe(401)
      }
      const blocked = await call(randomBytes(32).toString("base64url"), "GET", "/api/v1/items", {
        headers: { "x-test-ip": ip },
      })
      expect(blocked.status).toBe(429)
      expect(blocked.body.error).toBe("rate_limited")
      await call(randomBytes(32).toString("base64url"), "GET", "/api/v1/items", { headers: { "x-test-ip": ip } })
    } finally {
      spy.mockRestore()
    }
    expect(lines.filter((l) => l.includes("too many invalid tokens"))).toHaveLength(1)
    const blockedRows = await t.ctx.db.select().from(audit).where(eq(audit.action, "agent.blocked"))
    expect(blockedRows.filter((r) => (r.after as { address?: string }).address === ip)).toHaveLength(1)
    // Another address is not limited, and valid tokens give their place back.
    const { token } = await connect(["read"])
    for (let i = 0; i <= LIMITS.badTokens.max; i++)
      expect((await call(token, "GET", "/api/v1/items", { headers: { "x-test-ip": "198.51.100.98" } })).status).toBe(
        200,
      )
  })

  it("are counted before the token is checked, so a burst sent at once cannot all be checked", async () => {
    const max = LIMITS.badTokens.max
    const answers = await Promise.all(
      Array.from({ length: max + 5 }, () =>
        call(randomBytes(32).toString("base64url"), "GET", "/api/v1/items", {
          headers: { "x-test-ip": "198.51.100.97" },
        }),
      ),
    )
    expect(answers.filter((a) => a.status === 401)).toHaveLength(max)
    expect(answers.filter((a) => a.status === 429)).toHaveLength(5)
  })
})

describe("limits", () => {
  it("refuses a body over the cap before the route reads it, with nothing changed", async () => {
    const { token } = await connect(["read", "write"])
    const title = `Large ${randomUUID()}`
    const r = await rawCall(
      "POST",
      "/api/v1/notes",
      ["authorization", `Bearer ${token}`, HEADERS.policy, REVISION, HEADERS.kind, "act"],
      JSON.stringify({ title, body: "x".repeat(LIMITS.bodyBytes.default + 1) }),
    )
    expect(r.status).toBe(413)
    expect(r.body).toEqual({ error: "too_large", message: expect.any(String) })
    expect(await t.ctx.db.select().from(notes).where(eq(notes.title, title))).toEqual([])
  })

  it("withholds an answer over the cap, and says when the action ran", async () => {
    const { token } = await connect(["read", "write"])
    const note = await createNote(t.ctx, owner, { title: `Long ${randomUUID()}`, body: "y".repeat(70_000) })
    const read = await call(token, "GET", `/api/v1/notes/${note.id}`)
    expect(read.status).toBe(422)
    expect(read.body.error).toBe("answer_too_large")
    expect(read.body.message).not.toContain("action ran")
    const act = await call(token, "PATCH", `/api/v1/notes/${note.id}`, { json: { version: 1, title: "Renamed long" } })
    expect(act.status).toBe(422)
    expect(act.body.message).toContain("The action ran")
    const [after] = await t.ctx.db.select().from(notes).where(eq(notes.id, note.id))
    expect(after?.title).toBe("Renamed long")
  })
})

describe("the deadline", () => {
  // Every helper above runs on `h` and `t`: here they are a harness with the short deadline.
  let main: { h: OAuthHarness; t: TestDatabase }
  beforeAll(async () => {
    main = { h, t }
    t = await createTestDatabase("agents_deadline")
    h = await oauthHarness(t, { channel: SHORT })
  })
  afterAll(async () => {
    await h?.close()
    await t?.close()
    ;({ h, t } = main)
  })

  it("answers a call past its deadline 504 outcome_unknown, records it unknown, and keeps its slot until it ends", async () => {
    const { token, id } = await connect(["read", "write"])
    const item = await anItem()
    const row = await holdRow("items", item.id)
    let slow: Res
    let more: Promise<Res>[] = []
    try {
      slow = await call(token, "PATCH", `/api/v1/items/${item.id}`, { json: { version: 1, title: "Late" } })
      // Answered, still running: it keeps its slot, so the connection's other slots are all it has left.
      more = Array.from({ length: LIMITS.perConnection - 1 }, () =>
        call(token, "PATCH", `/api/v1/items/${item.id}`, { json: { version: 1, title: "Later" } }),
      )
      await row.waiting(LIMITS.perConnection)
      expect((await call(token, "GET", "/api/v1/items")).status).toBe(429)
    } finally {
      await row.release()
    }
    await Promise.all(more)
    expect(slow.status).toBe(504)
    expect(slow.text).toBe(
      '{"error":"outcome_unknown","message":"The call took too long, and it may still be running. Read the state it was to change before you try again."}',
    )
    // The work went on: the change was made once.
    await vi.waitFor(async () => {
      const [after] = await t.ctx.db.select().from(items).where(eq(items.id, item.id))
      expect(after?.title).toBe("Late")
    })
    const entries = (await calls(id)).map((e) => e.after as { route: string; outcome: string; status?: number })
    expect(entries.filter((e) => e.outcome === "unknown")).toEqual([
      expect.objectContaining({ route: "PATCH /api/v1/items/{id}", outcome: "unknown" }),
    ])
    expect(entries.filter((e) => e.status === 429)).toHaveLength(1)
  })
})

describe("calls at once", () => {
  it("counts calls in total across connections", async () => {
    const item = await anItem()
    const connections: Awaited<ReturnType<typeof connect>>[] = []
    for (let i = 0; i < LIMITS.total / LIMITS.perConnection; i++)
      connections.push(await connect(["read", "write"], `Total ${i}`))
    const other = await connect(["read"], "Total other")
    const row = await holdRow("items", item.id)
    const slow = connections.flatMap((c) =>
      Array.from({ length: LIMITS.perConnection }, () =>
        call(c.token, "PATCH", `/api/v1/items/${item.id}`, { json: { version: 1, title: "Total" } }),
      ),
    )
    try {
      await row.waiting(LIMITS.total)
      const busy = await call(other.token, "GET", "/api/v1/items")
      expect(busy.status).toBe(429)
      expect(busy.body.error).toBe("busy")
    } finally {
      await row.release()
    }
    await Promise.all(slow)
    expect((await call(other.token, "GET", "/api/v1/items")).status).toBe(200)
  })
})

describe("refusals of every act route are 4xx when nothing changed", () => {
  it("answers each refusal path with a 4xx and the agent contract's body", async () => {
    const { token } = await connect(["read", "write", "sync"])
    const project = await createProject(t.ctx, owner, { name: `Refusals ${randomUUID()}` })
    const item = await anItem()
    const note = await createNote(t.ctx, owner, { title: `Refusal note ${randomUUID()}` })
    const missing = randomUUID()
    const secret = `token=${randomBytes(12).toString("hex")}`
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const cases: [string, string, unknown, number, string][] = [
      ["POST", "/api/v1/threads/start", {}, 400, "validation_failed"],
      [
        "POST",
        "/api/v1/threads/start",
        { threadId: "t-child", parentThreadId: "t-parent", title: "x" },
        422,
        "not_top_level",
      ],
      ["POST", "/api/v1/items", {}, 400, "validation_failed"],
      ["POST", "/api/v1/items", { type: "task", title: secret }, 422, "secret_suspected"],
      ["POST", "/api/v1/items", { type: "task", title: "x", projectId: missing }, 404, "not_found"],
      ["PATCH", `/api/v1/items/${item.id}`, {}, 400, "validation_failed"],
      ["PATCH", `/api/v1/items/${missing}`, { version: 1 }, 404, "not_found"],
      ["PATCH", `/api/v1/items/${item.id}`, { version: 9 }, 409, "version_conflict"],
      ["POST", `/api/v1/items/${item.id}/comments`, {}, 400, "validation_failed"],
      ["POST", `/api/v1/items/${missing}/comments`, { text: "x" }, 404, "not_found"],
      ["POST", `/api/v1/items/${item.id}/comments`, { text: secret }, 422, "secret_suspected"],
      ["POST", `/api/v1/items/${item.id}/threads`, {}, 400, "validation_failed"],
      ["POST", `/api/v1/items/${item.id}/threads`, { threadId: "t-c", parentThreadId: "t-p" }, 422, "not_top_level"],
      ["POST", `/api/v1/items/${missing}/threads`, { threadId: "t-x" }, 404, "not_found"],
      ["POST", "/api/v1/capture", {}, 400, "validation_failed"],
      ["POST", "/api/v1/capture", { text: secret }, 422, "secret_suspected"],
      ["PATCH", `/api/v1/projects/${project.id}`, { name: "Renamed" }, 403, "forbidden"],
      ["PATCH", `/api/v1/projects/${project.id}`, { stage: "production" }, 403, "forbidden"],
      ["PATCH", `/api/v1/projects/${project.id}`, { githubRepo: "a/b" }, 403, "forbidden"],
      ["PATCH", `/api/v1/projects/${project.id}`, { slug: "other" }, 403, "forbidden"],
      ["PATCH", `/api/v1/projects/${missing}`, { whereWeAre: "x" }, 404, "not_found"],
      ["POST", `/api/v1/projects/${project.id}/stage-proposals`, {}, 400, "validation_failed"],
      ["POST", `/api/v1/projects/${missing}/stage-proposals`, { stage: "poc" }, 404, "not_found"],
      ["POST", "/api/v1/notes", {}, 400, "validation_failed"],
      ["POST", "/api/v1/notes", { title: secret }, 422, "secret_suspected"],
      ["PATCH", `/api/v1/notes/${note.id}`, {}, 400, "validation_failed"],
      ["PATCH", `/api/v1/notes/${note.id}`, { version: 9, title: "x" }, 409, "version_conflict"],
      ["PATCH", `/api/v1/notes/${missing}`, { version: 1, title: "x" }, 404, "not_found"],
      ["POST", "/api/v1/sync/t3", {}, 400, "validation_failed"],
      ["POST", "/api/v1/sync/t3", { collectedAt: future, projects: [], threads: [] }, 400, "validation_failed"],
      ["POST", "/api/v1/sync/security", {}, 400, "validation_failed"],
      ["POST", "/api/v1/sync/security", { collectedAt: future, repos: [] }, 400, "validation_failed"],
    ]
    for (const [method, path, body, status, code] of cases) {
      const r = await call(token, method, path, { json: body })
      expect([method, path, r.status, r.body?.error]).toEqual([method, path, status, code])
      expect(typeof r.body.message).toBe("string")
    }
    // Every act route has a refusal case.
    for (const route of OPEN.filter((r) => r.kind === "act")) {
      const prefix = route.path.split("{")[0] ?? route.path
      expect(
        cases.some(([m, p]) => m === route.method && p.startsWith(prefix)),
        route.path,
      ).toBe(true)
    }
    // Nothing of these changed the project, the item or the note.
    const [p] = await t.ctx.db.execute<{ name: string }>(sql`select name from projects where id = ${project.id}`)
    expect(p?.name).toBe(project.name)
  })
})

describe("the audit of every call", () => {
  it("writes exactly one entry per call, with its outcome and the route's template", async () => {
    const { token, id } = await connect(["read"], "Audited")
    const item = await anItem()
    await call(token, "GET", `/api/v1/items/${item.id}`)
    await call(token, "GET", `/api/v1/items/${randomUUID()}`)
    await call(token, "POST", "/api/v1/items", { json: {} })
    await call(token, "GET", "/api/v1/items", { headers: { [HEADERS.kind]: "act" } })
    await call(token, "GET", "/api/v1/audit")
    await call(token, "GET", "/api/v1/agent/access", { headers: { [HEADERS.policy]: "", [HEADERS.kind]: "" } })
    const entries = await calls(id)
    expect(entries.map((e) => [e.after, e.actorKind, e.actorLabel, e.source])).toEqual([
      [
        expect.objectContaining({ route: "GET /api/v1/items/{id}", kind: "read", outcome: "ok", status: 200 }),
        "agent",
        "agent:Audited",
        "api",
      ],
      [
        expect.objectContaining({ route: "GET /api/v1/items/{id}", outcome: "error", status: 404 }),
        "agent",
        "agent:Audited",
        "api",
      ],
      [
        expect.objectContaining({ route: "POST /api/v1/items", outcome: "denied", status: 403 }),
        "agent",
        "agent:Audited",
        "api",
      ],
      [
        expect.objectContaining({ route: "GET /api/v1/items", outcome: "denied", status: 409 }),
        "agent",
        "agent:Audited",
        "api",
      ],
      [
        expect.objectContaining({ route: null, method: "GET", outcome: "denied", status: 403 }),
        "agent",
        "agent:Audited",
        "api",
      ],
      [expect.objectContaining({ route: "GET /api/v1/agent/access", outcome: "ok" }), "agent", "agent:Audited", "api"],
    ])
    for (const e of entries) expect(JSON.stringify(e.after)).not.toContain(token)
  })

  it("names the agent by the label it sends", async () => {
    const { token, id } = await connect(["read"], "Labelled")
    await call(token, "GET", "/api/v1/items", { headers: { "x-adiutor-agent": "codex <thread>" } })
    expect((await calls(id)).at(-1)?.actorLabel).toBe("agent:codex thread")
  })

  it("never changes the answer when the audit write fails", async () => {
    const { token, id } = await connect(["read"], "Unaudited")
    await t.ctx.db.execute(
      sql`alter table audit add constraint test_no_agent_calls check (action <> 'agent.api_call') not valid`,
    )
    const lines: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)))
    try {
      const r = await call(token, "GET", "/api/v1/items")
      expect(r.status).toBe(200)
      expect(Array.isArray(r.body.data)).toBe(true)
      await h.mount.drain()
    } finally {
      spy.mockRestore()
      await t.ctx.db.execute(sql`alter table audit drop constraint test_no_agent_calls`)
    }
    expect(await calls(id)).toEqual([])
    expect(lines.some((l) => l.includes("an agent call was not audited") && l.includes("23514"))).toBe(true)
  })

  it("finishes the entry of a call that runs while the server shuts down", async () => {
    const t2 = await createTestDatabase("agents_shutdown")
    const h2 = await oauthHarness(t2, { channel: { ...channelLimits(), deadlineMs: 30_000 } })
    try {
      const c = await connectWithCode(h2, { scope: "read write", label: "Shutdown" })
      const token = String(c.tokens.body.access_token)
      const check = await h2.access.checkToken(token, "rest")
      if (!check.ok) throw new Error("no connection")
      const item = await createItem(t2.ctx, owner, { type: "task", title: "Shutdown item" })
      let release = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let locked = () => {}
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve
      })
      const holder = t2.ctx.db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from items where id = ${item.id} for update`)
        locked()
        await held
      })
      await isLocked
      const pending = fetch(`${h2.issuer}/api/v1/items/${item.id}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [HEADERS.policy]: REVISION,
          [HEADERS.kind]: "act",
        },
        body: JSON.stringify({ version: 1, title: "During shutdown" }),
      })
      await vi.waitFor(async () => {
        const n = [
          ...(await t2.ctx.db.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%from "items"%'`,
          )),
        ]
        expect(n[0]?.n).toBe(1)
      })
      // index.ts's order: the server stops taking requests and waits for open ones, then the database closes.
      const closed = new Promise<void>((resolve) => h2.server.close(() => resolve()))
      release()
      await holder
      expect((await pending).status).toBe(200)
      await closed
      // The agent access release's shutdown: drain before the database closes.
      await h2.mount.drain()
      const rows = await t2.ctx.db
        .select()
        .from(audit)
        .where(and(eq(audit.action, "agent.api_call"), eq(audit.entityId, check.connection.id)))
        .orderBy(desc(audit.id))
      expect(rows.map((r) => (r.after as { outcome: string }).outcome)).toEqual(["ok"])
    } finally {
      await h2.close()
      await t2.close()
    }
  })
})

describe("without agent access", () => {
  it("answers /api/v1 as before: an agent key works, an access token is not a key", async () => {
    const plain = createApp({ checkDatabase: async () => true, core: h.core })
    const key = await createAgentKey(h.core, "plain")
    const ok = await plain.request(`${h.issuer}/api/v1/session`, { headers: { authorization: `Bearer ${key}` } })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { data: { via: string } }).data.via).toBe("token")
    const { token } = await connect(["read"])
    const refused = await plain.request(`${h.issuer}/api/v1/items`, { headers: { authorization: `Bearer ${token}` } })
    expect(refused.status).toBe(401)
    expect(await refused.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } })
    const access = await plain.request(`${h.issuer}/api/v1/agent/access`, {
      headers: { authorization: `Bearer ${key}` },
    })
    expect(access.status).toBe(404)
  })
})

describe("a call whose client left", () => {
  it("is recorded unknown when its answer could not reach the agent, also when the action then finished", async () => {
    const { token, id } = await connect(["read", "write"], "Left")
    const item = await anItem()
    const row = await holdRow("items", item.id)
    const url = new URL(h.issuer)
    const body = JSON.stringify({ version: 1, title: "Finished alone" })
    const req = httpRequest({
      host: url.hostname,
      port: Number(url.port),
      path: `/api/v1/items/${item.id}`,
      method: "PATCH",
      agent: false,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        [HEADERS.policy]: REVISION,
        [HEADERS.kind]: "act",
      },
    })
    req.on("error", () => undefined)
    req.end(body)
    try {
      await row.waiting()
      // The client leaves while the act waits for the row.
      req.destroy()
      await new Promise((resolve) => setTimeout(resolve, 100))
    } finally {
      await row.release()
    }
    await vi.waitFor(async () => {
      expect((await calls(id)).length).toBe(1)
    })
    expect((await calls(id))[0]?.after).toMatchObject({
      route: "PATCH /api/v1/items/{id}",
      outcome: "unknown",
      disconnected: true,
    })
    const [after] = await t.ctx.db.select().from(items).where(eq(items.id, item.id))
    expect(after?.title).toBe("Finished alone")
  })
})

describe("a sync push whose run failed", () => {
  it("is recorded as an error, whole or in part, though it answers 200", async () => {
    const { token, id } = await connect(["sync"], "Sync run")
    const now = new Date().toISOString()
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const thread = (threadId: string, updatedAt: string) => ({
      threadId,
      t3ProjectId: null,
      title: `Thread ${threadId}`,
      status: "running",
      settled: false,
      updatedAt,
    })
    const failed = await call(token, "POST", "/api/v1/sync/t3", {
      json: { collectedAt: now, projects: [], threads: [thread(`t-${randomUUID()}`, future)] },
    })
    expect([failed.status, failed.body.data.outcome]).toEqual([200, "failed"])
    const partial = await call(token, "POST", "/api/v1/sync/t3", {
      json: {
        collectedAt: now,
        projects: [],
        threads: [thread(`t-${randomUUID()}`, now), thread(`t-${randomUUID()}`, future)],
      },
    })
    expect([partial.status, partial.body.data.outcome]).toEqual([200, "partial"])
    const whole = await call(token, "POST", "/api/v1/sync/t3", {
      json: { collectedAt: now, projects: [], threads: [] },
    })
    expect([whole.status, whole.body.data.outcome]).toEqual([200, "succeeded"])
    expect((await calls(id)).map((e) => (e.after as { outcome: string }).outcome)).toEqual(["error", "error", "ok"])
  })
})

describe("a body the limit refused", () => {
  it("is not use: the route never ran", async () => {
    const { token, id } = await connect(["read", "write"], "Too large")
    const r = await rawCall(
      "POST",
      "/api/v1/notes",
      ["authorization", `Bearer ${token}`, HEADERS.policy, REVISION, HEADERS.kind, "act"],
      JSON.stringify({ title: "Large", body: "x".repeat(LIMITS.bodyBytes.default + 1) }),
    )
    expect(r.status).toBe(413)
    const [row] = await t.ctx.db.select().from(agentConnections).where(eq(agentConnections.id, id))
    expect(row?.lastUsedAt).toBeNull()
  })
})

describe("the answer before its row", () => {
  it("goes out before the row is written, and the row says ok once the answer was delivered, though the client left", async () => {
    const { token, id } = await connect(["read"], "Delivered")
    // The audit table locked in a transaction of its own: the call's row waits until it is released.
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked = () => {}
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve
    })
    const holder = t.ctx.db.transaction(async (tx) => {
      await tx.execute(sql`lock table audit in exclusive mode`)
      locked()
      await released
    })
    await isLocked
    let answer: Res | "hung"
    try {
      // The whole answer arrives, and the client's connection closes, while the row is still held.
      answer = await Promise.race([
        rawCall("GET", "/api/v1/items", [
          "authorization",
          `Bearer ${token}`,
          HEADERS.policy,
          REVISION,
          HEADERS.kind,
          "read",
        ]),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ])
    } finally {
      release()
      await holder
    }
    expect(answer === "hung" ? "hung" : answer.status).toBe(200)
    expect((await calls(id)).map((e) => (e.after as { outcome: string }).outcome)).toEqual(["ok"])
  })
})

describe("a connection that ended while its body arrived", () => {
  it("runs nothing: the connection is read again once the whole body is in, also when it was used within the minute", async () => {
    const { token, id } = await connect(["read", "write"], "Slow body")
    // Used now: the next use writes nothing for a minute.
    expect((await call(token, "GET", "/api/v1/items")).status).toBe(200)
    const title = `Slow body ${randomUUID()}`
    const body = JSON.stringify({ type: "task", title })
    const url = new URL(h.issuer)
    const socket = netConnect(Number(url.port), url.hostname)
    let received = ""
    const answered = new Promise<number>((resolve, reject) => {
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string) => {
        received += chunk
        if (received.includes("\r\n\r\n")) resolve(Number(received.split(" ")[1]))
      })
      socket.on("error", reject)
    })
    const chunk = (text: string) => `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`
    socket.write(
      `POST /api/v1/items HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\n${HEADERS.policy}: ${REVISION}\r\n${HEADERS.kind}: act\r\nTransfer-Encoding: chunked\r\n\r\n${chunk(body.slice(0, 10))}`,
    )
    try {
      // The head is in and checked; the owner disconnects the agent while the rest of the body is on its way.
      await new Promise((resolve) => setTimeout(resolve, 300))
      await h.access.disconnect(ownerBy, id)
      socket.write(`${chunk(body.slice(10))}0\r\n\r\n`)
      expect(await answered).toBe(401)
    } finally {
      socket.destroy()
    }
    expect(await t.ctx.db.select().from(items).where(eq(items.title, title))).toEqual([])
  })
})
