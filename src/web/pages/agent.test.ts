import { describe, expect, it } from "vitest"
import { describeAgent } from "./agent.ts"

describe("describeAgent", () => {
  it.each([
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339 Safari/537.36",
      { browser: "Chrome", system: "Windows" },
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339 Safari/537.36 Edg/140.0.7339",
      { browser: "Edge", system: "Windows" },
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      { browser: "Safari", system: "iOS" },
    ],
    [
      "Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339 Mobile Safari/537.36",
      { browser: "Chrome", system: "Android" },
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", { browser: "Firefox", system: "Linux" }],
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.7339 Safari/537.36",
      { browser: "Chrome", system: "Linux" },
    ],
  ])("%s", (agent, expected) => {
    expect(describeAgent(agent)).toEqual(expected)
  })

  it("says nothing about an unknown or missing agent", () => {
    expect(describeAgent(null)).toBeNull()
    expect(describeAgent("curl/8.0")).toBeNull()
  })
})
