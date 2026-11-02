import { describe, expect, it } from "vitest"
import { RateLimiter } from "./auth.ts"

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
