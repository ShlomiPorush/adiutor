import { randomBytes, randomUUID } from "node:crypto"
import { request as httpRequest } from "node:http"
import { connect } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { and, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createApp } from "../app.ts"
import { agentConnections, audit, items } from "../db/schema.ts"
import { AGENT_INSTRUCTIONS } from "../mcp/server.ts"
import { createItem } from "../services/items.ts"
import { createNote } from "../services/notes.ts"
import { createAgentKey } from "../testing/app.ts"
import { createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import { holdRow } from "../testing/locks.ts"
import { connectBrowser, connectWithCode, type OAuthHarness, oauthHarness } from "../testing/oauth.ts"
import { channelLimits } from "./channel.ts"
import { DATA_SENTENCE, NEVER, TOOLS } from "./policy.ts"

/*
 * /mcp for agents connected by approval, over real HTTP with the MCP SDK's own client and real OAuth connections: the
 * token check and its 401s, tools/list by the token's areas, each tool through the policy core (the connection checked
 * again, the slots, the deadline, the answer cap) and its audit entry. The key path is mcp/mcp.integration.test.ts,
 * unchanged.
 */

let t: TestDatabase
let h: OAuthHarness
/** A 64 KiB answer cap makes the large answer quick to test; the deadline is the real one. */
const LIMITS = { ...channelLimits(), answerBytes: 64 * 1024 }
/** A 3-second deadline, on a harness of its own ("the deadline of a tool call"), so no other call can run into it. */
const SHORT = { ...channelLimits(), deadlineMs: 3_000 }

beforeAll(async () => {
  t = await createTestDatabase("agents_mcp")
  h = await oauthHarness(t, { channel: LIMITS, clientIp: (c) => c.req.header("x-test-ip") ?? "127.0.0.1" })
})
afterAll(async () => {
  await h?.close()
  await t?.close()
})

/** An MCP client's connection through the browser flow, with `areas` ticked; its token and its record. */
async function connectMcp(areas: string[] = ["read", "write"]) {
  const c = await connectBrowser(h, { scope: "read write", areas })
  const token = String(c.tokens.body.access_token)
  const check = await h.access.checkToken(token, "mcp")
  if (!check.ok) throw new Error("the new connection is not valid")
  return { token, id: check.connection.id }
}

async function client(token: string, headers: Record<string, string> = {}) {
  const c = new Client({ name: "adiutor-agent-test", version: "1.0.0" })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${h.issuer}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } },
    }),
  )
  return c
}

// biome-ignore lint/suspicious/noExplicitAny: tool answers are JSON whose shape each test asserts
type ToolAnswer = { isError: boolean; body: any }

async function tool(c: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  const result = (await c.callTool({ name, arguments: args })) as {
    isError?: boolean
    content: { type: string; text: string }[]
  }
  const text = result.content[0]?.text ?? "null"
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {}
  return { isError: Boolean(result.isError), body }
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
}

async function post(headers: Record<string, string>, body: unknown = initialize) {
  const r = await fetch(`${h.issuer}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: r.status, headers: r.headers, text, json: json as { error?: string } | null }
}

async function toolCalls(connectionId: string) {
  // A call's row is written once its answer went out: wait for every row begun.
  await h.mount.drain()
  return t.ctx.db
    .select()
    .from(audit)
    .where(and(eq(audit.action, "agent.tool_call"), eq(audit.entityId, connectionId)))
    .orderBy(audit.id)
}

const METADATA = () => `${h.issuer}/.well-known/oauth-protected-resource/mcp`

describe("the token on /mcp", () => {
  it("asks for one with the protected resource metadata, and refuses one that is not valid here", async () => {
    const none = await post({})
    expect(none.status).toBe(401)
    expect(none.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA()}"`)
    expect(none.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate")
    const bad = await post({
      authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
      "x-test-ip": "198.51.100.21",
    })
    expect(bad.status).toBe(401)
    expect(bad.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA()}", error="invalid_token"`)
    expect(bad.json?.error).toBe("invalid_token")
  })

  it("refuses a token made for /api/v1, and an agent key", async () => {
    const rest = await connectWithCode(h, { scope: "read write", label: "REST" })
    const r = await post({ authorization: `Bearer ${rest.tokens.body.access_token}` })
    expect(r.status).toBe(401)
    expect(r.json?.error).toBe("invalid_token")
    const key = await createAgentKey(h.core, "old key")
    expect((await post({ authorization: `Bearer ${key}`, "x-test-ip": "198.51.100.22" })).status).toBe(401)
  })

  it("takes exactly one Authorization header", async () => {
    const { token } = await connectMcp(["read"])
    const url = new URL(h.issuer)
    const body = JSON.stringify(initialize)
    const answer = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: url.hostname,
          port: Number(url.port),
          path: "/mcp",
          method: "POST",
          agent: false,
          headers: [
            "host",
            url.host,
            "content-type",
            "application/json",
            "accept",
            "application/json, text/event-stream",
            "content-length",
            String(Buffer.byteLength(body)),
            "authorization",
            `Bearer ${token}`,
            "authorization",
            `Bearer ${token}`,
          ],
        },
        (res) => {
          let text = ""
          res.setEncoding("utf8")
          res.on("data", (chunk: string) => {
            text += chunk
          })
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }))
        },
      )
      req.on("error", reject)
      req.end(body)
    })
    expect(answer.status).toBe(401)
    expect(JSON.parse(answer.text).error).toBe("invalid_request")
    const mixed = await post({ authorization: `Bearer ${token}, Bearer ${token}` })
    expect(mixed.status).toBe(401)
  })

  it("ignores the owner's cookie beside a bearer: an invalid token is refused, a valid one acts as the agent", async () => {
    const cookie = h.owner.cookieHeader
    const bad = await post({
      authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
      cookie,
      "x-test-ip": "198.51.100.23",
    })
    expect(bad.status).toBe(401)
    expect((await post({ cookie })).status).toBe(401)
    const { token, id } = await connectMcp(["read", "write"])
    const c = await client(token, { cookie })
    try {
      const created = await tool(c, "adiutor_create_item", { type: "task", title: `By the agent ${randomUUID()}` })
      expect(created.isError).toBe(false)
      const [row] = await t.ctx.db
        .select()
        .from(audit)
        .where(and(eq(audit.action, "item.create"), eq(audit.entityId, created.body.data.id)))
      expect([row?.actorKind, row?.source]).toEqual(["agent", "mcp"])
      expect((await toolCalls(id)).at(-1)?.after).toMatchObject({ tool: "adiutor_create_item", outcome: "ok" })
    } finally {
      await c.close()
    }
  })

  it("refuses a page of another site before the token, as before", async () => {
    const r = await post({ origin: "https://elsewhere.example" })
    expect(r.status).toBe(403)
  })
})

describe("tools by area", () => {
  it("lists only the tools of the areas granted, and get_access", async () => {
    const expected = (area: string) =>
      Object.entries(TOOLS)
        .filter(([, rule]) => rule.area === null || rule.area === area)
        .map(([name]) => name)
        .sort()
    for (const area of ["read", "write"]) {
      const { token } = await connectMcp([area])
      const c = await client(token)
      try {
        const { tools } = await c.listTools()
        expect(tools.map((x) => x.name).sort()).toEqual(expected(area))
        for (const x of tools) {
          expect(x.description, x.name).toContain(DATA_SENTENCE)
          expect(x.annotations?.readOnlyHint, x.name).toBe(TOOLS[x.name]?.kind === "read")
        }
      } finally {
        await c.close()
      }
    }
  })

  it("refuses a tool of an area not granted when it is called", async () => {
    const { token } = await connectMcp(["read"])
    const c = await client(token)
    const title = `Not granted ${randomUUID()}`
    try {
      const refused = await c.callTool({ name: "adiutor_create_item", arguments: { type: "task", title } }).then(
        (r) => ({ isError: Boolean((r as { isError?: boolean }).isError) }),
        () => ({ isError: true }),
      )
      expect(refused.isError).toBe(true)
    } finally {
      await c.close()
    }
    expect(await t.ctx.db.select().from(items).where(eq(items.title, title))).toEqual([])
  })

  it("gives the instructions: get_access first, the never list, the data sentence, the outcome rule", async () => {
    const { token } = await connectMcp(["read"])
    const c = await client(token)
    try {
      const instructions = c.getInstructions() ?? ""
      expect(instructions).toBe(AGENT_INSTRUCTIONS)
      expect(instructions).toContain("Call get_access first")
      expect(instructions).toContain("acts for the owner, within the areas the owner granted it")
      for (const line of NEVER) expect(instructions).toContain(line)
      expect(instructions).toContain(DATA_SENTENCE)
      expect(instructions).toContain("When an action's outcome is unknown, read its result before trying again.")
    } finally {
      await c.close()
    }
  })
})

describe("get_access and use", () => {
  it("answers what the REST access route answers, and neither it nor listing tools counts as use", async () => {
    const { token, id } = await connectMcp(["read"])
    const c = await client(token)
    try {
      await c.listTools()
      const access = await tool(c, "get_access")
      expect(access.isError).toBe(false)
      expect(access.body).toMatchObject({
        name: "Test agent",
        connection: { via: "browser", resource: "mcp" },
        areas: [{ area: "read", kinds: ["read"] }],
        notGranted: [{ area: "write", kinds: ["act"] }],
        never: NEVER,
        ends: { lastUsedAt: null },
        version: "test",
      })
      const used = async () =>
        (await t.ctx.db.select().from(agentConnections).where(eq(agentConnections.id, id)))[0]?.lastUsedAt ?? null
      expect(await used()).toBeNull()
      expect((await tool(c, "adiutor_list_projects")).isError).toBe(false)
      expect(await used()).toBeInstanceOf(Date)
    } finally {
      await c.close()
    }
  })
})

describe("each tool call", () => {
  it("is audited once with its outcome, and errors take the agent contract's shape", async () => {
    const { token, id } = await connectMcp(["read", "write"])
    const c = await client(token)
    try {
      expect((await tool(c, "adiutor_find_items", {})).isError).toBe(false)
      const missing = await tool(c, "adiutor_get_item", { itemId: randomUUID() })
      expect(missing).toEqual({ isError: true, body: { error: "not_found", message: expect.any(String) } })
      await tool(c, "get_access")
    } finally {
      await c.close()
    }
    expect((await toolCalls(id)).map((e) => [e.after, e.source])).toEqual([
      [expect.objectContaining({ tool: "adiutor_find_items", kind: "read", outcome: "ok" }), "mcp"],
      [expect.objectContaining({ tool: "adiutor_get_item", outcome: "error" }), "mcp"],
      [expect.objectContaining({ tool: "get_access", outcome: "ok" }), "mcp"],
    ])
  })

  it("is refused when the connection ended while it waited", async () => {
    const { token, id } = await connectMcp(["read", "write"])
    const c = await client(token)
    const title = `After the end ${randomUUID()}`
    try {
      // The request's token was checked; the tool checks the connection again and waits to record its use.
      const row = await holdRow(t, "agent_connections", id)
      const pending = tool(c, "adiutor_create_item", { type: "task", title })
      try {
        await row.waiting()
      } finally {
        await row.release((tx) =>
          tx.execute(
            sql`update agent_connections set ended_at = now(), end_reason = 'disconnected', ended_by = 'owner' where id = ${id}`,
          ),
        )
      }
      const answer = await pending
      expect(answer).toEqual({ isError: true, body: { error: "connection_ended", message: expect.any(String) } })
    } finally {
      await c.close()
    }
    expect(await t.ctx.db.select().from(items).where(eq(items.title, title))).toEqual([])
    expect((await toolCalls(id)).at(-1)?.after).toMatchObject({
      tool: "adiutor_create_item",
      outcome: "denied",
      refusal: "connection_ended",
    })
  })

  it("is refused by the SDK, before the policy core, when its arguments fail the tool's schema (no audit row)", async () => {
    const { token, id } = await connectMcp(["read"])
    const c = await client(token)
    try {
      const refused = await c.callTool({ name: "adiutor_get_item", arguments: { itemId: "not-a-uuid" } }).then(
        (r) => Boolean((r as { isError?: boolean }).isError),
        () => true,
      )
      expect(refused).toBe(true)
    } finally {
      await c.close()
    }
    expect(await toolCalls(id)).toEqual([])
  })
})

describe("the deadline of a tool call", () => {
  // Every helper above runs on `h` and `t`: here they are a harness with a 3-second deadline.
  let main: { h: OAuthHarness; t: TestDatabase }
  beforeAll(async () => {
    main = { h, t }
    t = await createTestDatabase("agents_mcp_deadline")
    h = await oauthHarness(t, { channel: SHORT })
  })
  afterAll(async () => {
    await h?.close()
    await t?.close()
    ;({ h, t } = main)
  })

  it("answers a body that does not arrive within the deadline 408, nothing run, while the client still sends", async () => {
    const { token } = await connectMcp(["read"])
    const url = new URL(h.issuer)
    const answer = await new Promise<{ status: number; stillSending: boolean } | null>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname)
      let received = ""
      const timer = setTimeout(() => {
        socket.destroy()
        resolve(null)
      }, SHORT.deadlineMs + 3_000)
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string) => {
        received += chunk
        if (received.includes("\r\n\r\n")) {
          clearTimeout(timer)
          resolve({ status: Number(received.split(" ")[1]), stillSending: socket.writable })
          socket.destroy()
        }
      })
      socket.on("error", (error) => reject(error))
      socket.write(
        `POST /mcp HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 1000\r\n\r\n{"jsonrpc":`,
      )
    })
    expect(answer).toEqual({ status: 408, stillSending: true })
  })

  it("keeps the connection's check again under the deadline", async () => {
    const { token, id } = await connectMcp(["read"])
    const c = await client(token)
    try {
      // The check again waits to record the use behind the held row, past the deadline.
      const row = await holdRow(t, "agent_connections", id)
      let answer: ToolAnswer | "hung"
      try {
        answer = await Promise.race([
          tool(c, "adiutor_list_projects"),
          new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), SHORT.deadlineMs + 3_000)),
        ])
      } finally {
        await row.release()
      }
      expect(answer).toEqual({ isError: true, body: { error: "outcome_unknown", message: expect.any(String) } })
    } finally {
      await c.close()
    }
    expect((await toolCalls(id)).map((e) => (e.after as { outcome: string }).outcome)).toEqual(["unknown"])
  })

  it("answers outcome_unknown past the deadline and records it unknown, and busy beyond the connection's slots", async () => {
    const { token, id } = await connectMcp(["read", "write"])
    const item = await createItem(t.ctx, owner, { type: "task", title: "Slow tool" })
    const c = await client(token)
    try {
      const row = await holdRow(t, "items", item.id)
      let late: ToolAnswer
      try {
        const slow = Array.from({ length: LIMITS.perConnection }, (_, i) =>
          tool(c, "adiutor_update_item", { itemId: item.id, version: 1, title: `Slow ${i}` }),
        )
        await row.waiting(LIMITS.perConnection)
        const busy = await tool(c, "adiutor_find_items", {})
        expect(busy).toEqual({ isError: true, body: { error: "busy", message: expect.any(String) } })
        late = (await Promise.all(slow))[0] as ToolAnswer
      } finally {
        await row.release()
      }
      expect(late).toEqual({ isError: true, body: { error: "outcome_unknown", message: expect.any(String) } })
    } finally {
      await c.close()
    }
    const outcomes = (await toolCalls(id)).map((e) => e.after as { outcome: string; refusal?: string })
    expect(outcomes.filter((o) => o.outcome === "unknown")).toHaveLength(LIMITS.perConnection)
    expect(outcomes.filter((o) => o.refusal === "busy")).toHaveLength(1)
  })
})

describe("the answer cap on the wire", () => {
  /** One JSON-RPC message or a batch, posted as is; the parsed answer. */
  async function rpc(token: string, message: unknown) {
    const r = await post({ authorization: `Bearer ${token}` }, message)
    return { status: r.status, json: JSON.parse(r.text) as unknown }
  }
  const textOf = (answer: { result?: { content?: { text: string }[] } }) =>
    JSON.parse(answer.result?.content?.[0]?.text ?? "null") as { error?: string }

  it("counts the request id the answer echoes: a long id brings a small result over the cap", async () => {
    const { token } = await connectMcp(["read"])
    const id = "i".repeat(LIMITS.answerBytes - 1_000)
    const answer = await rpc(token, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "get_access", arguments: {} },
    })
    expect(answer.status).toBe(200)
    expect(textOf(answer.json as never).error).toBe("answer_too_large")
  })
})

describe("JSON-RPC batches", () => {
  it("are refused before the transport for an agent connected by approval: nothing runs, a single call still works", async () => {
    const { token, id } = await connectMcp(["read", "write"])
    const item = await createItem(t.ctx, owner, { type: "task", title: "Batch" })
    const update = (requestId: number | undefined, title: string) => ({
      jsonrpc: "2.0",
      ...(requestId === undefined ? {} : { id: requestId }),
      method: "tools/call",
      params: { name: "adiutor_update_item", arguments: { itemId: item.id, version: 1, title } },
    })
    // Two calls with one id (the SDK would run both and answer one), and one without an id (never answered).
    const batch = await post({ authorization: `Bearer ${token}` }, [
      update(7, "Batch one"),
      update(7, "Batch two"),
      update(undefined, "Batch three"),
    ])
    expect(batch.status).toBe(400)
    expect(JSON.parse(batch.text)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32600, message: expect.any(String) },
      id: null,
    })
    const [unchanged] = await t.ctx.db.select().from(items).where(eq(items.id, item.id))
    expect([unchanged?.title, unchanged?.version]).toEqual(["Batch", 1])
    expect(await toolCalls(id)).toEqual([])
    const [row] = await t.ctx.db.select().from(agentConnections).where(eq(agentConnections.id, id))
    expect(row?.lastUsedAt).toBeNull()
    // One message per request still works.
    const single = await post({ authorization: `Bearer ${token}` }, update(8, "Single"))
    expect(single.status).toBe(200)
    const [changed] = await t.ctx.db.select().from(items).where(eq(items.id, item.id))
    expect(changed?.title).toBe("Single")
  })

  it("are still the SDK's on the key path without agent access", async () => {
    const plain = createApp({ checkDatabase: async () => true, core: h.core })
    const key = await createAgentKey(h.core, "batch key")
    const r = await plain.request(`${h.issuer}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]),
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as unknown[]).length).toBe(2)
  })
})

describe("the limits of a tool call", () => {
  it("measures what is sent: text full of escapes below the cap as text, above it once serialized, is withheld", async () => {
    const { token } = await connectMcp(["read"])
    // Each `"` is 2 bytes in the tool's text and 4 once the result is serialized.
    const note = await createNote(t.ctx, owner, { title: `Quotes ${randomUUID()}`, body: '"'.repeat(24_000) })
    const c = await client(token)
    try {
      const read = await tool(c, "adiutor_get_note", { noteId: note.id })
      expect(read.isError).toBe(true)
      expect(read.body.error).toBe("answer_too_large")
    } finally {
      await c.close()
    }
  })

  it("records a tool call whose client left as unknown, also when the action then finished", async () => {
    const { token, id } = await connectMcp(["read", "write"])
    const item = await createItem(t.ctx, owner, { type: "task", title: "MCP left" })
    const row = await holdRow(t, "items", item.id)
    const url = new URL(h.issuer)
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "adiutor_update_item", arguments: { itemId: item.id, version: 1, title: "MCP finished alone" } },
    })
    const req = httpRequest({
      host: url.hostname,
      port: Number(url.port),
      path: "/mcp",
      method: "POST",
      agent: false,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": String(Buffer.byteLength(body)),
      },
    })
    req.on("error", () => undefined)
    req.end(body)
    try {
      await row.waiting()
      req.destroy()
      await new Promise((resolve) => setTimeout(resolve, 100))
    } finally {
      await row.release()
    }
    await vi.waitFor(async () => {
      expect((await toolCalls(id)).length).toBe(1)
    })
    expect((await toolCalls(id))[0]?.after).toMatchObject({
      tool: "adiutor_update_item",
      outcome: "unknown",
      disconnected: true,
    })
    const [after] = await t.ctx.db.select().from(items).where(eq(items.id, item.id))
    expect(after?.title).toBe("MCP finished alone")
  })

  it("withholds an answer over the cap", async () => {
    const { token } = await connectMcp(["read", "write"])
    const note = await createNote(t.ctx, owner, { title: `Long ${randomUUID()}`, body: "z".repeat(70_000) })
    const c = await client(token)
    try {
      const read = await tool(c, "adiutor_get_note", { noteId: note.id })
      expect(read.isError).toBe(true)
      expect(read.body.error).toBe("answer_too_large")
      const act = await tool(c, "adiutor_update_note", { noteId: note.id, version: 1, title: "Renamed by MCP" })
      expect(act.body.error).toBe("answer_too_large")
      expect(act.body.message).toContain("The action ran")
    } finally {
      await c.close()
    }
  })

  it("refuses a body over the shared cap", async () => {
    const { token } = await connectMcp(["read"])
    const big = { ...initialize, params: { ...initialize.params, padding: "x".repeat(LIMITS.bodyBytes.default) } }
    const r = await post({ authorization: `Bearer ${token}` }, big)
    expect(r.status).toBe(413)
  })
})
