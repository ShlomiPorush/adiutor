import { randomBytes } from "node:crypto"
import { request as httpRequest } from "node:http"
import type { AddressInfo } from "node:net"
import { type ServerType, serve } from "@hono/node-server"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
import { testCore } from "../testing/app.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import { RateLimiter } from "./auth.ts"

// Request paths that routers and adapters have parsed differently from the application: every one must still meet
// the authentication of /api/v1 and /mcp, or be refused before the app sees it.

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
