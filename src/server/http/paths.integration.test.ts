import { randomBytes } from "node:crypto"
import { request as httpRequest } from "node:http"
import { type AddressInfo, connect } from "node:net"
import { type ServerType, serve } from "@hono/node-server"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
import { testCore } from "../testing/app.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import { RateLimiter } from "./auth.ts"

// Requests that routers, adapters and middleware have handled differently from the application: every one must still
// meet the authentication of /api/v1 and /mcp, or be refused before the app sees it, at a bounded cost.

let t: TestDatabase
let app: ReturnType<typeof createApp>
let server: ServerType
let port: number
/** Requests the listener handed to the app. */
let reached = 0

beforeAll(async () => {
  t = await createTestDatabase("paths")
  const core = testCore(t, {
    config: { publicUrl: new URL("http://127.0.0.1:8090"), version: "test" },
    // Many wrong keys in a row: the failed-key limit is not what these tests check.
    limiter: new RateLimiter(1000, 60_000),
  })
  app = createApp({ checkDatabase: async () => true, core })
  server = serve({
    fetch: (request) => {
      reached++
      return app.fetch(request)
    },
    port: 0,
    hostname: "127.0.0.1",
  })
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  port = (server.address() as AddressInfo).port
})
afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  await t?.close()
})
beforeEach(() => {
  reached = 0
})

/** Hono's RegExpRouter matched no wildcard middleware for these (GHSA-h7mg-cq63-vhpq). */
const LINE_TERMINATORS = ["%0A", "%0D", "%E2%80%A8", "%E2%80%A9"]
const terminatorPaths = LINE_TERMINATORS.flatMap((code) => [
  `/api/v1/items${code}`,
  `/api/v1/${code}/session`,
  `/api/v1/projects/a${code}b`,
  `/mcp/${code}`,
  `/mcp/a${code}b`,
])

describe("a path with an encoded line terminator", () => {
  it.each(terminatorPaths)("%s is refused by the authentication, not answered past it", async (path) => {
    const wrongKey = randomBytes(24).toString("base64url")
    for (const headers of [{}, { authorization: `Bearer ${wrongKey}` }]) {
      for (const method of ["GET", "POST"]) {
        const res = await app.request(path, { method, headers })
        expect([method, headers, res.status]).toEqual([method, headers, 401])
        expect(await res.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } })
      }
    }
  })
})

/** The raw request line, as a client sends it: fetch and app.request would normalise the URL first. */
function rawGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => {
        body += chunk
      })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on("error", reject)
    req.end()
  })
}

describe("a raw backslash in the request path (GHSA-jpvv-r467-5p4w)", () => {
  it.each(["/api\\v1/session", "/api/v1\\..\\..\\api/v1/session", "/mcp\\..\\api/v1/session"])(
    "%s is answered 400 by the adapter and never reaches the app",
    async (path) => {
      const res = await rawGet(path)
      expect(res.status).toBe(400)
      expect(reached).toBe(0)
    },
  )

  it("lets an encoded backslash in the path and a backslash in the query reach the app", async () => {
    for (const path of ["/api/v1/session%5C", "/api/v1/session?q=a\\b"]) {
      const res = await rawGet(path)
      expect([path, res.status]).toEqual([path, 401])
      expect(JSON.parse(res.body).error.code).toBe("unauthorized")
    }
    expect(reached).toBe(2)
  })
})

/** A chunked POST whose body is `chunks` transfer chunks of one byte each, written at once on a raw socket. */
function tinyChunkPost(path: string, chunks: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    let raw = ""
    socket.setEncoding("utf8")
    socket.on("data", (data: string) => {
      raw += data
    })
    socket.on("end", () => {
      const [head = "", body = ""] = raw.split("\r\n\r\n")
      resolve({ status: Number(head.split(" ")[1]), body })
    })
    socket.on("error", reject)
    socket.write(
      `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\n` +
        "Transfer-Encoding: chunked\r\n\r\n",
    )
    socket.write(Buffer.from(`${"1\r\nx\r\n".repeat(chunks)}0\r\n\r\n`))
  })
}

describe("a body sent in many tiny transfer chunks (GHSA-39q9-qp46-w8xg)", () => {
  it("is read within the body limit at a bounded memory cost, then refused by the authentication", async () => {
    // bodyLimit() reads the body before the authentication runs. Before the fix it kept one object per transfer
    // chunk: 500,000 one-byte chunks grew the heap by about 140 MB (hono 4.13.17); since the fix about 25 MB, the
    // short-lived garbage of reading it, whatever the number of chunks.
    const before = process.memoryUsage().heapUsed
    let peak = before
    const sample = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed)
    }, 2)
    let res: { status: number; body: string }
    try {
      res = await tinyChunkPost("/api/v1/sync/t3", 500_000)
    } finally {
      clearInterval(sample)
    }
    peak = Math.max(peak, process.memoryUsage().heapUsed)
    expect(res.status).toBe(401)
    expect(JSON.parse(res.body).error.code).toBe("unauthorized")
    expect(peak - before).toBeLessThan(64 * 1024 * 1024)
    // The listener still serves.
    expect((await rawGet("/healthz")).status).toBe(200)
  })
})
