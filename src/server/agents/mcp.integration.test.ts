import { randomBytes, randomUUID } from "node:crypto"
import { request as httpRequest } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { and, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
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
const LIMITS = { ...channelLimits(), deadlineMs: 3_000, answerBytes: 64 * 1024 }

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
