import { describe, expect, it } from "vitest"
import { insecureCookieAllowed, RateLimiter, tokenKind } from "./auth.ts"

const config = {
  ownerToken: "o".repeat(40),
  agentToken: "a".repeat(40),
  publicUrl: new URL("https://mikud.example.com"),
}

describe("tokenKind", () => {
  it("tells the owner token from the agent token and refuses anything else", () => {
    expect(tokenKind("o".repeat(40), config)).toBe("owner")
    expect(tokenKind("a".repeat(40), config)).toBe("agent")
    expect(tokenKind("o".repeat(39), config)).toBeNull()
    expect(tokenKind("", config)).toBeNull()
  })
})

describe("RateLimiter", () => {
  it("blocks after the maximum failures in the window and forgets them after it", () => {
    let now = 0
    const limiter = new RateLimiter(3, 60_000, () => now)
    for (let i = 0; i < 3; i++) {
      expect(limiter.blocked("a")).toBe(false)
      limiter.fail("a")
    }
    expect(limiter.blocked("a")).toBe(true)
    expect(limiter.blocked("b")).toBe(false)
    now = 60_000
    expect(limiter.blocked("a")).toBe(false)
  })
})

describe("insecureCookieAllowed", () => {
  it.each([
    ["http://127.0.0.1:8090", true],
    ["http://localhost:8090", true],
    ["https://127.0.0.1", false],
    ["http://mikud.example.com", false],
    ["https://mikud.example.com", false],
  ])("%s → %s", (url, allowed) => {
    expect(insecureCookieAllowed(new URL(url))).toBe(allowed)
  })
})
