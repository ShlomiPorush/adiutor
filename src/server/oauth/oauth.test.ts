import { describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
import { offeredAreas } from "./access.ts"
import { checkIssuer, issuerFingerprint } from "./issuer.ts"
import { cleanLabel } from "./label.ts"
import { Mutex, WindowLimit } from "./limits.ts"
import { agentName, CLI_CLIENT_ID, redirectKind } from "./provider.ts"
import { PROVIDER_PATHS } from "./routes.ts"

describe("the issuer (S3)", () => {
  it("is the public URL's origin as a browser spells it, https anywhere, http only on the three loopback names", () => {
    expect(checkIssuer("https://adiutor.example.com")).toEqual({ issuer: "https://adiutor.example.com", problem: null })
    expect(checkIssuer("https://adiutor.example.com/").issuer).toBe("https://adiutor.example.com")
    expect(checkIssuer("https://Adiutor.Example.com").issuer).toBe("https://adiutor.example.com")
    expect(checkIssuer("http://localhost:8090").issuer).toBe("http://localhost:8090")
    expect(checkIssuer("http://127.0.0.1:8090").issuer).toBe("http://127.0.0.1:8090")
    expect(checkIssuer("http://[::1]:8090").issuer).toBe("http://[::1]:8090")
  })

  it("refuses plain http elsewhere, also on the rest of the 127 block and on pr.localhost", () => {
    for (const url of [
      "http://adiutor.example.com",
      `http://${[127, 0, 0, 2].join(".")}:8090`,
      "http://pr.localhost:8091",
      `http://${[10, 1, 2, 3].join(".")}`,
    ])
      expect(checkIssuer(url).problem, url).toBe("plain_http")
  })

  it("refuses a URL a browser would spell differently, and anything but an origin", () => {
    for (const url of [
      "https://\u00e4diutor.example.com",
      "https://adiutor.example.com:443",
      "http://127.1:8090",
      "http://0x7f.0.0.1:8090",
      "https://[::ffff:7f00:1]",
      "https://[::ffff:127.0.0.1]",
    ])
      expect(checkIssuer(url).problem, url).toBe("spelling")
    for (const url of ["https://a.example.com/adiutor", "https://a.example.com/?x=1", "https://u:p@a.example.com"])
      expect(checkIssuer(url).problem, url).toBe("not_origin")
    expect(checkIssuer("ftp://a.example.com").problem).toBe("invalid")
    expect(checkIssuer("not a url").problem).toBe("invalid")
  })

  it("has a fingerprint that changes with the issuer", () => {
    expect(issuerFingerprint("https://a.example.com")).not.toBe(issuerFingerprint("https://b.example.com"))
    expect(issuerFingerprint("https://a.example.com")).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("names agents give themselves (S7)", () => {
  it("keeps plain text of 1 to 60 characters after NFC, and drops anything else", () => {
    expect(cleanLabel("  Laptop (work) sync: v2/main@home  ")).toBe("Laptop (work) sync: v2/main@home")
    const hebrew = "\u05e1\u05e7\u05e8\u05d9\u05e4\u05d8"
    expect(cleanLabel(hebrew)).toBe(hebrew)
    expect(cleanLabel("e\u0301")).toBe("\u00e9")
    for (const bad of ["", " ", "a".repeat(61), "bad\u202ename", "<b>", 'quote"', "line\nbreak", 42, null])
      expect(cleanLabel(bad), String(bad)).toBeNull()
    expect(cleanLabel("a".repeat(60))).toHaveLength(60)
  })

  it("names the built-in client by its label or Script, and a registered one by its name or Agent", () => {
    expect(agentName(CLI_CLIENT_ID, "Script", "Sync")).toBe("Sync")
    expect(agentName(CLI_CLIENT_ID, "Script", "bad\u0000")).toBe("Script")
    expect(agentName("abc", "Claude Code", undefined)).toBe("Claude Code")
    expect(agentName("abc", "<script>", undefined)).toBe("Agent")
  })
})

describe("redirect URIs (S5)", () => {
  it("accepts https, loopback http on any port and reverse-domain private schemes", () => {
    expect(redirectKind("https://app.example.com/cb")).toBe("https")
    expect(redirectKind("http://127.0.0.1:1234/cb")).toBe("loopback")
    expect(redirectKind("http://localhost/cb")).toBe("loopback")
    expect(redirectKind("http://[::1]:9/cb")).toBe("loopback")
    expect(redirectKind("com.example.agent:/callback")).toBe("private")
  })

  it("refuses everything else", () => {
    for (const uri of [
      "http://app.example.com/cb",
      `http://${[127, 0, 0, 2].join(".")}/cb`,
      "https://app.example.com/cb#f",
      "https://u:p@app.example.com/cb",
      "myapp:/cb",
      "javascript:alert(1)",
      `https://app.example.com/${"a".repeat(500)}`,
      42,
    ])
      expect(redirectKind(uri), String(uri)).toBeNull()
  })
})

describe("the areas offered on the consent page (D3)", () => {
  it("offers what was asked that the resource has, read and write when nothing known was asked, never sync on MCP", () => {
    expect(offeredAreas("rest", "sync")).toEqual(["sync"])
    expect(offeredAreas("rest", "read write sync openid")).toEqual(["read", "write", "sync"])
    expect(offeredAreas("mcp", "read write sync")).toEqual(["read", "write"])
    expect(offeredAreas("mcp", "sync")).toEqual(["read", "write"])
    expect(offeredAreas("rest", undefined)).toEqual(["read", "write"])
  })
})

describe("limits (S20)", () => {
  it("counts synchronously, refuses over the limit, gives a request back and reports once per window", () => {
    let now = 0
    const limit = new WindowLimit(2, 1000, () => now)
    expect([limit.take("a"), limit.take("a"), limit.take("a")]).toEqual([true, true, false])
    expect(limit.firstOver("a")).toBe(true)
    expect(limit.firstOver("a")).toBe(false)
    limit.give("a")
    limit.give("a")
    expect(limit.take("a")).toBe(true)
    expect(limit.take("b")).toBe(true)
    now = 1000
    expect([limit.take("a"), limit.take("a"), limit.take("a")]).toEqual([true, true, false])
  })

  it("lets one holder at a time through the mutex, in order", async () => {
    const mutex = new Mutex()
    const order: number[] = []
    const first = await mutex.acquire()
    const second = mutex.acquire().then((release) => {
      order.push(2)
      release()
    })
    order.push(1)
    first()
    first()
    await second
    expect(order).toEqual([1, 2])
  })
})

describe("the provider's addresses", () => {
  it("pass exactly, with no trailing slash, other case or other path", () => {
    for (const path of [
      "/oauth/authorize",
      "/oauth/authorize/abc-DEF_1",
      "/oauth/token",
      "/oauth/device",
      "/oauth/revoke",
      "/oauth/register",
      "/oauth/jwks",
      "/connect/code",
      "/connect/code/abc",
      "/.well-known/oauth-authorization-server",
    ])
      expect(PROVIDER_PATHS.test(path), path).toBe(true)
    for (const path of [
      "/oauth/token/",
      "/OAUTH/token",
      "/oauth/userinfo",
      "/oauth/register/abc",
      "/oauth/logout",
      "/connect/device",
      "/.well-known/openid-configuration",
      "/oauth/authorize/a/b",
    ])
      expect(PROVIDER_PATHS.test(path), path).toBe(false)
  })
})

describe("production before the agent access release", () => {
  it("mounts nothing of agent access unless createApp is given it", async () => {
    const app = createApp({ checkDatabase: async () => true })
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/oauth/token",
      "/connect/code",
    ])
      expect((await app.request(path)).status, path).toBe(404)
  })
})
