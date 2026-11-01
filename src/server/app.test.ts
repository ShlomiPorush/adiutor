import { describe, expect, it } from "vitest"
import { createApp } from "./app.ts"

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
