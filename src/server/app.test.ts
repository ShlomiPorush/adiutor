import { describe, expect, it } from "vitest"
import { createApp, withoutEmptyBody } from "./app.ts"

describe("/healthz", () => {
  it("is 200 when the database answers", async () => {
    const res = await createApp({ checkDatabase: async () => true }).request("/healthz")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok", database: "ok" })
  })

  it("is 503 when the database does not answer", async () => {
    const res = await createApp({ checkDatabase: async () => false }).request("/healthz")
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: "unavailable", database: "down" })
  })
})

describe("withoutEmptyBody (the transport fix for Better Auth's bodiless POST)", () => {
  const url = "http://127.0.0.1:8090/api/auth/get-session"
  const stream = () => new ReadableStream({ start: (controller) => controller.close() })

  it("gives a POST with Content-Length 0 and no Transfer-Encoding a null body, same method, URL and headers", () => {
    const raw = new Request(url, {
      method: "POST",
      headers: { "content-length": "0", cookie: "a=b" },
      body: stream(),
      duplex: "half",
    } as RequestInit)
    const out = withoutEmptyBody(raw)
    expect(out).not.toBe(raw)
    expect(out.body).toBeNull()
    expect([out.method, out.url, out.headers.get("cookie")]).toEqual(["POST", url, "a=b"])
  })

  it("passes everything else through unchanged", () => {
    const get = new Request(url)
    expect(withoutEmptyBody(get)).toBe(get)
    const withBody = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    expect(withoutEmptyBody(withBody)).toBe(withBody)
    const chunked = new Request(url, {
      method: "POST",
      headers: { "content-length": "0", "transfer-encoding": "chunked" },
      body: stream(),
      duplex: "half",
    } as RequestInit)
    expect(withoutEmptyBody(chunked)).toBe(chunked)
    const unknownLength = new Request(url, { method: "POST", body: stream(), duplex: "half" } as RequestInit)
    expect(withoutEmptyBody(unknownLength)).toBe(unknownLength)
  })
})
