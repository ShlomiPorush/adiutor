import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "./app.ts"

const root = mkdtempSync(join(tmpdir(), "mikud-web-"))
mkdirSync(join(root, "assets"))
writeFileSync(join(root, "index.html"), "<!doctype html><title>Mikud</title>")
writeFileSync(join(root, "assets", "index-abc.js"), "console.log(1)")
writeFileSync(join(root, "boot.js"), "void 0")
writeFileSync(join(tmpdir(), "mikud-outside.txt"), "secret")

const app = createApp({ checkDatabase: async () => true, web: { root } })

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("web UI serving", () => {
  it("serves index.html with the security headers for any page address", async () => {
    for (const path of ["/", "/projects/0000", "/settings"]) {
      const response = await app.request(path)
      expect(response.status, path).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(response.headers.get("content-security-policy")).toContain("script-src 'self'")
      expect(response.headers.get("cache-control")).toBe("no-cache")
      expect(await response.text()).toContain("<title>Mikud</title>")
    }
  })

  it("serves build files as they are, hashed ones cached for good", async () => {
    const asset = await app.request("/assets/index-abc.js")
    expect(asset.status).toBe(200)
    expect(asset.headers.get("content-type")).toContain("text/javascript")
    expect(asset.headers.get("cache-control")).toContain("immutable")
    expect((await app.request("/boot.js")).headers.get("cache-control")).toBe("no-cache")
  })

  it("answers 404 for a missing file and never serves outside its folder", async () => {
    expect((await app.request("/assets/missing.js")).status).toBe(404)
    expect((await app.request("/../mikud-outside.txt")).status).toBe(404)
    expect((await app.request("/%2e%2e/mikud-outside.txt")).status).toBe(404)
  })

  it("leaves /api, /mcp and /healthz to the server", async () => {
    const api = await app.request("/api/v1/unknown")
    expect(api.status).toBe(404)
    expect(await api.json()).toMatchObject({ error: { code: "not_found" } })
    expect((await app.request("/mcp")).headers.get("content-type")).not.toContain("text/html")
    expect(await (await app.request("/healthz")).json()).toMatchObject({ status: "ok" })
  })
})
