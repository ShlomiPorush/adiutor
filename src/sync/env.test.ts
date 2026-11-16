import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { loadSyncConfig, parseEnvFile, redactor, SyncConfigError } from "./env.ts"

// New on every run: nothing in the repository works as a key.
const token = randomBytes(24).toString("hex")

describe("parseEnvFile", () => {
  it("reads KEY=VALUE lines, comments, export, quotes, CRLF and a BOM", () => {
    const text = [
      "\uFEFF# Adiutor sync settings",
      "",
      "ADIUTOR_URL=https://adiutor.example.com/",
      'export ADIUTOR_AGENT_TOKEN="abc=def"',
      "T3CODE_CLI_PATH='C:\\Program Files (x86)\\t3\\t3.cmd'",
      "  ADIUTOR_OVERVIEW_DIR = C:\\Work\\overview  ",
      "EMPTY=",
    ].join("\r\n")
    expect(parseEnvFile(text)).toEqual({
      ADIUTOR_URL: "https://adiutor.example.com/",
      ADIUTOR_AGENT_TOKEN: "abc=def",
      T3CODE_CLI_PATH: "C:\\Program Files (x86)\\t3\\t3.cmd",
      ADIUTOR_OVERVIEW_DIR: "C:\\Work\\overview",
      EMPTY: "",
    })
  })

  it("names a bad line by number and never repeats it", () => {
    const secret = "ghp_examplesecretvalue1234567890"
    expect(() => parseEnvFile(`ADIUTOR_URL=https://adiutor.example.com\n${secret}\n`)).toThrow(
      new SyncConfigError("env file line 2 is not KEY=VALUE"),
    )
    expect(() => parseEnvFile("=value")).toThrow("line 1")
    expect(() => parseEnvFile("1KEY=value")).toThrow("line 1")
  })
})

describe("loadSyncConfig", () => {
  const env = {
    ADIUTOR_URL: "http://127.0.0.1:8090",
    ADIUTOR_AGENT_TOKEN: token,
    T3CODE_CLI_PATH: "/usr/local/bin/t3",
    ADIUTOR_OVERVIEW_DIR: "/home/dev/overview",
  }

  it("reads the environment and lets the env file win", () => {
    const config = loadSyncConfig(env, { ADIUTOR_URL: "https://adiutor.example.com/" }, { requireServer: true })
    expect(config).toEqual({
      url: "https://adiutor.example.com",
      cliPath: "/usr/local/bin/t3",
      overviewDir: "/home/dev/overview",
      oldToken: true,
    })
    expect(JSON.stringify(config)).not.toContain(token)
  })

  it("needs the URL only when something is sent, and no token at all", () => {
    expect(loadSyncConfig({}, {}, { requireServer: false })).toEqual({
      url: undefined,
      cliPath: undefined,
      overviewDir: undefined,
      oldToken: false,
    })
    expect(() => loadSyncConfig({}, {}, { requireServer: true })).toThrow("ADIUTOR_URL is required")
    expect(loadSyncConfig({ ADIUTOR_URL: "https://adiutor.example.com" }, {}, { requireServer: true }).oldToken).toBe(
      false,
    )
  })

  it("refuses a URL that is not Adiutor's address alone, https or http on this computer", () => {
    for (const url of [
      "ftp://adiutor.example.com",
      "not a url",
      "https://user:pw@adiutor.example.com",
      "https://x.example.com/?a=1",
      "https://x.example.com/app",
      "http://adiutor.example.com",
    ])
      expect(() => loadSyncConfig({ ...env, ADIUTOR_URL: url }, {}, { requireServer: true })).toThrow("ADIUTOR_URL")
  })
})

describe("redactor", () => {
  it("replaces every occurrence of a secret", () => {
    expect(redactor([token, undefined])(`a ${token} b ${token}`)).toBe("a [redacted] b [redacted]")
  })
})
