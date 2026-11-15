import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { AGENT_AREAS, type AgentArea, RESOURCE_AREAS } from "../../shared/enums.ts"
import { createApp } from "../app.ts"
import type { AuthHolder } from "../auth/auth.ts"
import { ALLOWED_PATHS, OTP_PATHS } from "../auth/auth.ts"
import type { SettingsHandle } from "../http/api.ts"
import { buildMcpServer } from "../mcp/server.ts"
import type { AgentAccess } from "../oauth/access.ts"
import { agentOAuthMount } from "../oauth/routes.ts"
import type { Ctx } from "../services/context.ts"
import { agentStatus, createAgentChannel } from "./channel.ts"
import {
  AREAS,
  CLOSED,
  CLOSED_AUTH_PATHS,
  CLOSED_TOOLS,
  DATA_SENTENCE,
  honoPath,
  listing,
  NEVER_OPEN,
  OPEN,
  REVISION,
  TOOLS,
} from "./policy.ts"

/*
 * The exposure test (the agent-access standard, "The exposure test"): every route of the app, of every method, is in
 * OPEN (agents/policy.ts) or in CLOSED with a reason, and every MCP tool in TOOLS or CLOSED_TOOLS. A new route or tool
 * fails here until someone classifies it in agents/policy.ts. The app is built with everything it can mount: the API,
 * MCP, agent access and the built UI. Nothing here reaches a database.
 */

const ctx = { db: {}, secrets: { find: () => null }, clock: () => new Date() } as unknown as Ctx
const ISSUER = "http://127.0.0.1:8090"
/** Agent access as the routes read it when they are built; no request is made. */
const access = {
  issuer: ISSUER,
  issuerProblem: null,
  provider: null,
  resources: null,
  hooks: {},
} as unknown as AgentAccess

const web = join(tmpdir(), `adiutor-policy-web-${process.pid}`)
let appRoutes: string[] = []
let agentRoutes: string[] = []

beforeAll(() => {
  mkdirSync(web, { recursive: true })
  writeFileSync(join(web, "index.html"), "<html></html>")
  const app = createApp({
    checkDatabase: async () => true,
    core: {
      ctx,
      config: { publicUrl: new URL(ISSUER), version: "test" },
      auth: {} as AuthHolder,
      settings: {} as SettingsHandle,
    },
    agentOAuth: agentOAuthMount(access),
    web: { root: web },
  })
  appRoutes = [...new Set(app.routes.map((r) => `${r.method} ${r.path}`))].sort()
  const channel = createAgentChannel({ ctx, access, version: "test", clientIp: () => "test" })
  agentRoutes = [...new Set(channel.restRoutes.map((r) => `${r.method} ${r.path}`))].sort()
})
afterAll(() => rmSync(web, { recursive: true, force: true }))

const open = new Set(OPEN.map((r) => `${r.method} ${honoPath(r.path)}`))

/** The tools an MCP client lists, through the SDK's own client. */
async function listedTools(areas?: readonly AgentArea[]) {
  const by = { actor: { kind: "agent" as const, label: "agent" }, source: "mcp" as const }
  const server = buildMcpServer(
    ctx,
    by,
    "test",
    areas ? { areas, guard: (_tool, run) => run(), getAccess: async () => ({}) } : undefined,
  )
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "exposure-test", version: "1.0.0" })
  await client.connect(clientSide)
  const { tools } = await client.listTools()
  await client.close()
  return tools
}

describe("the closed route table", () => {
  it("classifies every route of the app, once", () => {
    const unclassified = appRoutes.filter((r) => !open.has(r) && !(r in CLOSED))
    expect(
      unclassified,
      `Classify these routes in src/server/agents/policy.ts: OPEN (area, kind, description, parameters) or CLOSED (with the reason):\n${unclassified.join("\n")}`,
    ).toEqual([])
    for (const r of Object.keys(CLOSED)) expect(open.has(r), `${r} is in both maps`).toBe(false)
  })

  it("names only routes the app has", () => {
    for (const r of Object.keys(CLOSED)) expect(appRoutes, r).toContain(r)
    for (const r of open) expect([...appRoutes, ...agentRoutes], r).toContain(r)
  })

  it("gives agents a router of the open map alone: an unmatched route is closed", () => {
    const own = agentRoutes.filter((r) => r !== "ALL /*")
    expect(own.sort()).toEqual([...open].sort())
    // The token check (first) and the closed catch-all (last) are the only other entries.
    expect(agentRoutes).toContain("ALL /*")
  })

  it("gives every closed route a reason, and every open route a known area, kind, description and parameters", () => {
    for (const [r, reason] of Object.entries(CLOSED)) expect(reason.length, r).toBeGreaterThan(10)
    for (const r of OPEN) {
      expect(r.area === null || (AGENT_AREAS as readonly string[]).includes(r.area), r.path).toBe(true)
      expect(["read", "act"], r.path).toContain(r.kind)
      expect(r.description.length, r.path).toBeGreaterThan(30)
      expect(r.path.startsWith("/api/v1/"), r.path).toBe(true)
      const inPath = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
      expect(
        r.parameters.filter((p) => p.in === "path").map((p) => p.name),
        r.path,
      ).toEqual(inPath)
      for (const p of r.parameters) expect(["path", "query", "body"], `${r.path} ${p.name}`).toContain(p.in)
      if (r.method === "GET")
        expect(
          r.parameters.some((p) => p.in === "body"),
          r.path,
        ).toBe(false)
    }
    for (const area of AGENT_AREAS) expect(AREAS[area].sentence.length).toBeGreaterThan(20)
  })

  it("classifies by effect: every open route that changes something is an act, every one that only reads a read", () => {
    for (const r of OPEN) expect([r.path, r.kind], r.path).toEqual([r.path, r.method === "GET" ? "read" : "act"])
    for (const r of OPEN.filter((x) => x.area !== null)) expect(AREAS[r.area as AgentArea].kinds).toContain(r.kind)
  })

  it("keeps D4's never list closed, the owner's undecided reads, and everything of agent connections", () => {
    for (const r of NEVER_OPEN) {
      expect(open.has(r), r).toBe(false)
      expect(CLOSED[r], r).toBeTruthy()
    }
    for (const r of ["GET /api/v1/morning", "GET /api/v1/inbox", "GET /api/v1/archive"])
      expect(CLOSED[r]).toBe("not used by agents; owner decision pending")
    for (const r of appRoutes.filter((x) => /\/api\/v1\/(agents|audit|settings|suppressions|session)\b/.test(x)))
      expect(open.has(r), r).toBe(false)
    for (const r of appRoutes.filter((x) => / \/(oauth|connect|\.well-known|api\/auth|api\/setup)\b/.test(x)))
      expect(open.has(r), r).toBe(false)
  })

  it("closes every Better Auth route that is open over HTTP, and names no other", () => {
    expect(Object.keys(CLOSED_AUTH_PATHS).sort()).toEqual([...ALLOWED_PATHS, ...OTP_PATHS].sort())
    for (const [p, reason] of Object.entries(CLOSED_AUTH_PATHS)) expect(reason.length, p).toBeGreaterThan(10)
  })

  it("says the data sentence in every description of an open route", () => {
    for (const r of OPEN) expect(r.description, r.path).toContain(DATA_SENTENCE)
  })

  it("keeps sync a REST area only, as the MCP resource offers no sync", () => {
    expect(RESOURCE_AREAS.mcp).not.toContain("sync")
    for (const [name, rule] of Object.entries(TOOLS)) expect(rule.area, name).not.toBe("sync")
  })
})

describe("the MCP tools", () => {
  it("classifies every tool, once, in both modes", async () => {
    for (const name of Object.keys(CLOSED_TOOLS)) expect(TOOLS[name], name).toBeUndefined()
    const all = (await listedTools([...AGENT_AREAS])).map((t) => t.name).sort()
    expect(all).toEqual(Object.keys(TOOLS).sort())
    const keyed = (await listedTools()).map((t) => t.name)
    const unclassified = keyed.filter((name) => !(name in TOOLS) && !(name in CLOSED_TOOLS))
    expect(unclassified, `Classify these tools in TOOLS or CLOSED_TOOLS (agents/policy.ts)`).toEqual([])
  })

  it("lists only the tools of the areas granted, with annotations from their kind and the data sentence", async () => {
    const readOnly = await listedTools(["read"])
    expect(readOnly.map((t) => t.name).sort()).toEqual(
      Object.entries(TOOLS)
        .filter(([, rule]) => rule.area === null || rule.area === "read")
        .map(([name]) => name)
        .sort(),
    )
    const writeOnly = await listedTools(["write"])
    expect(writeOnly.every((t) => TOOLS[t.name]?.area === "write" || t.name === "get_access")).toBe(true)
    for (const t of await listedTools([...AGENT_AREAS])) {
      const rule = TOOLS[t.name]
      expect(t.annotations, t.name).toEqual({
        readOnlyHint: rule?.kind === "read",
        destructiveHint: false,
        openWorldHint: false,
      })
      expect(t.description, t.name).toContain(DATA_SENTENCE)
    }
  })
})

describe("the endpoints listing", () => {
  it("lists the routes of the areas a connection holds and those open to every connection, with the revision", () => {
    const read = listing(["read"])
    expect(read.revision).toBe(REVISION)
    expect(read.revision).toMatch(/^[A-Za-z0-9._-]{1,128}$/)
    expect(read.count).toBe(read.endpoints.length)
    expect(read.endpoints.every((e) => e.area === "read" || e.area === "any")).toBe(true)
    expect(read.note).toBe("Take every path from this list, with its {...} parts filled in. Never guess a path.")
    const all = listing([...AGENT_AREAS])
    expect(all.count).toBe(OPEN.length)
    const sync = listing([...AGENT_AREAS], "sync")
    expect(sync.endpoints.map((e) => e.path).sort()).toEqual(
      ["/api/v1/agent/access", "/api/v1/agent/endpoints", "/api/v1/sync/security", "/api/v1/sync/t3"].sort(),
    )
    expect(listing(["read"], "write").endpoints.every((e) => e.area === "any")).toBe(true)
    for (const e of all.endpoints) expect(e.path).not.toContain(":")
  })
})

describe("a route's own refusal never reads as a reserved one", () => {
  it("answers a route's 401 as 403 and its 429 as 409, and leaves every other status", () => {
    expect(agentStatus(401)).toBe(403)
    expect(agentStatus(429)).toBe(409)
    for (const s of [200, 201, 400, 403, 404, 409, 413, 422, 500, 502]) expect(agentStatus(s)).toBe(s)
  })
})
