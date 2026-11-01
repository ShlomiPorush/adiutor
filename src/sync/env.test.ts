import { describe, expect, it } from "vitest"
import { loadSyncConfig, parseEnvFile, redactor, SyncConfigError } from "./env.ts"

const token = "t".repeat(40)

describe("parseEnvFile", () => {
  it("reads KEY=VALUE lines, comments, export, quotes, CRLF and a BOM", () => {
    const text = [
      "\uFEFF# Mikud sync settings",
      "",
      "MIKUD_URL=https://mikud.example.com/",
      'export MIKUD_AGENT_TOKEN="abc=def"',
      "T3CODE_CLI_PATH='C:\\Program Files (x86)\\t3\\t3.cmd'",
      "  MIKUD_OVERVIEW_DIR = C:\\Work\\overview  ",
      "EMPTY=",
    ].join("\r\n")
    expect(parseEnvFile(text)).toEqual({
      MIKUD_URL: "https://mikud.example.com/",
      MIKUD_AGENT_TOKEN: "abc=def",
      T3CODE_CLI_PATH: "C:\\Program Files (x86)\\t3\\t3.cmd",
      MIKUD_OVERVIEW_DIR: "C:\\Work\\overview",
      EMPTY: "",
    })
  })

  it("names a bad line by number and never repeats it", () => {
    const secret = "ghp_examplesecretvalue1234567890"
    expect(() => parseEnvFile(`MIKUD_URL=https://mikud.example.com\n${secret}\n`)).toThrow(
      new SyncConfigError("env file line 2 is not KEY=VALUE"),
    )
    expect(() => parseEnvFile("=value")).toThrow("line 1")
    expect(() => parseEnvFile("1KEY=value")).toThrow("line 1")
  })
})

describe("loadSyncConfig", () => {
  const env = {
    MIKUD_URL: "http://127.0.0.1:8090",
    MIKUD_AGENT_TOKEN: token,
    T3CODE_CLI_PATH: "/usr/local/bin/t3",
    MIKUD_OVERVIEW_DIR: "/home/dev/overview",
  }

  it("reads the environment and lets the env file win", () => {
    const config = loadSyncConfig(env, { MIKUD_URL: "https://mikud.example.com/" }, { requireServer: true })
    expect(config).toEqual({
      url: "https://mikud.example.com",
      token,
      cliPath: "/usr/local/bin/t3",
      overviewDir: "/home/dev/overview",
    })
  })

  it("needs the URL and the token only when something is sent", () => {
    expect(loadSyncConfig({}, {}, { requireServer: false })).toEqual({
      url: undefined,
      token: undefined,
      cliPath: undefined,
      overviewDir: undefined,
    })
    expect(() => loadSyncConfig({}, {}, { requireServer: true })).toThrow(
      "MIKUD_URL is required; MIKUD_AGENT_TOKEN is required",
    )
  })

  it("refuses a short token without printing it", () => {
    const short = "s".repeat(31)
    try {
      loadSyncConfig({ ...env, MIKUD_AGENT_TOKEN: short }, {}, { requireServer: true })
      throw new Error("accepted")
    } catch (error) {
      expect((error as Error).message).toContain("at least 32 characters")
      expect((error as Error).message).not.toContain(short)
    }
  })

  it("refuses a URL that is not plain http or https", () => {
    for (const url of [
      "ftp://mikud.example.com",
      "not a url",
      "https://user:pw@mikud.example.com",
      "https://x.example.com/?a=1",
    ])
      expect(() => loadSyncConfig({ ...env, MIKUD_URL: url }, {}, { requireServer: true })).toThrow("MIKUD_URL")
  })
})

describe("redactor", () => {
  it("replaces every occurrence of a secret", () => {
    expect(redactor([token, undefined])(`a ${token} b ${token}`)).toBe("a [redacted] b [redacted]")
  })
})
