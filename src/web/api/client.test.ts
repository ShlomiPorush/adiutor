import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, fetchTransport, onUnauthorized, query, setTransport, type TransportRequest } from "./client.ts"
import { api } from "./endpoints.ts"

function answer(status: number, body: unknown) {
  return vi.fn(async (_request: TransportRequest) => ({ status, body }))
}

afterEach(() => {
  onUnauthorized(null)
  vi.unstubAllGlobals()
})

describe("fetch transport", () => {
  it("sends the CSRF header and the cookie on a change, and no CSRF header on a read", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await fetchTransport({ method: "POST", path: "/capture", body: { text: "x" } })
    await fetchTransport({ method: "GET", path: "/morning" })
    const [postUrl, post] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const [, get] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(postUrl).toBe("/api/v1/capture")
    expect(post.credentials).toBe("same-origin")
    expect((post.headers as Record<string, string>)["X-Mikud-Request"]).toBe("1")
    expect((post.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
    expect(post.body).toBe(JSON.stringify({ text: "x" }))
    expect((get.headers as Record<string, string>)["X-Mikud-Request"]).toBeUndefined()
  })

  it("reads an empty 204 answer as no body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    )
    expect(await fetchTransport({ method: "DELETE", path: "/items/x" })).toEqual({ status: 204, body: null })
  })
})

describe("request and endpoints", () => {
  it("unwraps {data} and paged {data, nextCursor}", async () => {
    setTransport(
      answer(200, {
        data: { actor: { kind: "owner", label: "owner" }, via: "session", browserId: "b1", clocks: null },
      }),
    )
    expect((await api.session()).browserId).toBe("b1")
    const paged = answer(200, { data: [{ id: 1 }], nextCursor: "abc" })
    setTransport(paged)
    expect(await api.archive("first")).toEqual({ entries: [{ id: 1 }], nextCursor: "abc" })
    expect(paged.mock.calls[0]?.[0]).toMatchObject({ method: "GET", path: "/archive?cursor=first&limit=50" })
  })

  it("keeps the activity log's total and counts, and sends its filters with the cursor", async () => {
    const counts = {
      actorKind: { owner: 1, agent: 0, bot: 0, sync: 0, system: 0 },
      agents: [],
      actions: [],
      projects: [],
    }
    const first = answer(200, { data: [{ id: 1 }], nextCursor: "abc", total: 3, counts })
    setTransport(first)
    expect(await api.audit({ actorKind: "owner", q: "trellis", lang: "en" }, null)).toEqual({
      entries: [{ id: 1 }],
      nextCursor: "abc",
      total: 3,
      counts,
    })
    expect(first.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      path: "/audit?actorKind=owner&q=trellis&lang=en&limit=50",
    })
    const next = answer(200, { data: [{ id: 2 }], nextCursor: null })
    setTransport(next)
    expect(await api.audit({ actorKind: "owner" }, "abc")).toEqual({
      entries: [{ id: 2 }],
      nextCursor: null,
      total: null,
      counts: null,
    })
    expect(next.mock.calls[0]?.[0]).toMatchObject({ path: "/audit?actorKind=owner&cursor=abc&limit=50" })
  })

  it("sends the item version with a change and the decision of a proposal", async () => {
    const transport = answer(200, { data: {} })
    setTransport(transport)
    await api.updateItem("i1", 4, { status: "done" })
    await api.decideProposal("p1", "accept")
    expect(transport.mock.calls[0]?.[0]).toEqual({
      method: "PATCH",
      path: "/items/i1",
      body: { version: 4, status: "done" },
    })
    expect(transport.mock.calls[1]?.[0]).toEqual({
      method: "POST",
      path: "/stage-proposals/p1/decision",
      body: { decision: "accept" },
    })
  })

  it("turns {error: {code, message, ...details}} into an ApiError with the server's code, sentence and details", async () => {
    setTransport(answer(409, { error: { code: "version_conflict", message: "The item changed.", currentVersion: 5 } }))
    const error = await api.updateItem("i1", 4, { title: "x" }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 409,
      code: "version_conflict",
      serverMessage: "The item changed.",
      details: { currentVersion: 5 },
    })
  })

  it("names an answer without a known code by its HTTP status", async () => {
    setTransport(answer(502, "<html>bad gateway</html>"))
    await expect(api.morning()).rejects.toMatchObject({ status: 502, code: "unknown", serverMessage: null })
    setTransport(answer(404, null))
    await expect(api.morning()).rejects.toMatchObject({ code: "not_found" })
  })

  it("reports a 401 and totp_required to the app", async () => {
    const handler = vi.fn()
    onUnauthorized(handler)
    setTransport(answer(401, { error: { code: "unauthorized", message: "Sign in." } }))
    await expect(api.morning()).rejects.toMatchObject({ code: "unauthorized" })
    setTransport(answer(403, { error: { code: "totp_required", message: "Code." } }))
    await expect(api.morning()).rejects.toMatchObject({ code: "totp_required" })
    setTransport(answer(403, { error: { code: "forbidden", message: "No." } }))
    await expect(api.morning()).rejects.toMatchObject({ code: "forbidden" })
    expect(handler.mock.calls.map(([e]) => e.code)).toEqual(["unauthorized", "totp_required"])
  })

  it("sends setup to /api/setup, not under /api/v1", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { hasUser: false, session: "none" } })))
    vi.stubGlobal("fetch", fetchMock)
    await fetchTransport({ method: "GET", path: "/api/setup/status" })
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/api/setup/status")
  })

  it("calls a request that got no answer a network failure", async () => {
    setTransport(async () => {
      throw new TypeError("Failed to fetch")
    })
    await expect(api.inbox()).rejects.toMatchObject({ status: 0, code: "network" })
  })

  it("shows a failed Telegram status read as a failed read, never as a bot that is not configured", async () => {
    setTransport(answer(404, { error: { code: "not_found", message: "Nothing is here." } }))
    await expect(api.telegramStatus()).rejects.toMatchObject({ code: "not_found" })
    setTransport(answer(500, { error: { code: "internal_error", message: "Boom." } }))
    await expect(api.telegramStatus()).rejects.toMatchObject({ code: "internal_error" })
  })

  it("builds a query string from defined values only", () => {
    expect(query({ cursor: null, limit: 50, q: "", projectId: undefined })).toBe("?limit=50")
    expect(query({})).toBe("")
  })
})
