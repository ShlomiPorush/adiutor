import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { parseEnvFile, redactor, SyncConfigError } from "./env.ts"

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

describe("redactor", () => {
  it("replaces every occurrence of a secret", () => {
    expect(redactor([token, undefined])(`a ${token} b ${token}`)).toBe("a [redacted] b [redacted]")
  })
})
