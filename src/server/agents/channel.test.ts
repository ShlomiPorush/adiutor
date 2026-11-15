import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import type { AgentAccess } from "../oauth/access.ts"
import type { Ctx } from "../services/context.ts"
import { channelLimits, createAgentChannel } from "./channel.ts"
import { HEADERS, REVISION } from "./policy.ts"

/*
 * The agent channel's bound on audit writes, with a database stand-in whose writes this test holds and releases: in a
 * real pool a held write also holds back queries pipelined behind it, so only a stand-in shows the bound alone.
 */

/** A database whose audit inserts wait until `release`, counted as they begin. */
function heldWrites() {
  const waiting: (() => void)[] = []
  let begun = 0
  const db = {
    insert: () => ({
      values: () => {
        begun++
        return new Promise<void>((resolve) => waiting.push(resolve))
      },
    }),
  }
  return {
    ctx: { db, secrets: { find: () => null }, clock: () => new Date() } as unknown as Ctx,
    begun: () => begun,
    release() {
      for (const resolve of waiting.splice(0)) resolve()
    },
  }
}

const connection = {
  id: "c-1",
  name: "Test agent",
  connectedVia: "code",
  approvedAt: new Date(),
  lastUsedAt: null,
}
/** Agent access that accepts one token for a connection granted `read`. */
const access = {
  issuer: "http://127.0.0.1:8090",
  checkToken: async () => ({ ok: true, connection, areas: ["read"], clientId: "x", expiresAt: 0 }),
  recordUse: async () => connection,
} as unknown as AgentAccess

function app(writes: ReturnType<typeof heldWrites>, auditMs: number) {
  const limits = { ...channelLimits(), auditMs }
  const channel = createAgentChannel({ ctx: writes.ctx, access, version: "test", clientIp: () => "x", limits })
  const hono = new Hono()
  hono.all("*", (c) => channel.fetchRest(c))
  const call = (path: string, headers: Record<string, string> = {}) =>
    hono.request(path, {
      headers: { authorization: "Bearer t", [HEADERS.policy]: REVISION, [HEADERS.kind]: "read", ...headers },
    })
  return { channel, limits, call }
}

describe("audit writes of agent calls", () => {
  it("bound a burst of refusals by the slots: no more writes at once than the slots and one per reason", async () => {
    const writes = heldWrites()
    const { limits, call } = app(writes, 20)
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => call("/api/v1/items", { [HEADERS.policy]: "stale" })),
    )
    expect(answers.map((a) => a.status)).toEqual(Array(20).fill(409))
    expect(writes.begun()).toBe(limits.perConnection + 1)
    writes.release()
  })

  it("keep a call's slot until its row settles, and drain waits for every row before the database may close", async () => {
    const writes = heldWrites()
    const { channel, limits, call } = app(writes, 20)
    // Each answers once its row gave up waiting; the rows are still being written, and hold their slots.
    for (let i = 0; i < limits.perConnection; i++) expect((await call("/api/v1/agent/endpoints")).status).toBe(200)
    expect((await call("/api/v1/agent/endpoints")).status).toBe(429)
    let drained = false
    const drain = channel.drain().then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(drained).toBe(false)
    writes.release()
    await drain
    expect(drained).toBe(true)
    // The slots are back.
    const again = call("/api/v1/agent/endpoints")
    await new Promise((resolve) => setTimeout(resolve, 50))
    writes.release()
    expect((await again).status).toBe(200)
  })
})
