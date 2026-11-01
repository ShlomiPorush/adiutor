import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { buildInvocation, childEnv, lastLine, runProcess, UnsafeArgumentError } from "./exec.ts"

const args = ["thread", "list", "--project", "mcp:p-1", "--json"]

describe("buildInvocation", () => {
  it("runs a Windows batch file through cmd.exe with every part quoted", () => {
    const cli = "C:\\Users\\Dev Name\\.t3\\bin\\t3.cmd"
    expect(buildInvocation(cli, args, "win32", "C:\\Windows\\system32\\cmd.exe")).toEqual({
      file: "C:\\Windows\\system32\\cmd.exe",
      args: [
        "/d",
        "/v:off",
        "/s",
        "/c",
        '""C:\\Users\\Dev Name\\.t3\\bin\\t3.cmd" "thread" "list" "--project" "mcp:p-1" "--json""',
      ],
      windowsVerbatimArguments: true,
    })
    expect(buildInvocation("C:\\t3\\T3.BAT", ["x"], "win32", undefined).file).toBe("cmd.exe")
  })

  it("keeps shell characters inside the quotes and refuses what cmd.exe would still expand", () => {
    const safe = buildInvocation("C:\\t3 (x86)\\t3.cmd", ["a&b|c<d>e^f!g"], "win32", "cmd.exe")
    expect(safe.args.at(-1)).toBe('""C:\\t3 (x86)\\t3.cmd" "a&b|c<d>e^f!g""')
    for (const bad of ['a"b', "%PATH%", "a\nb", "a\rb"])
      expect(() => buildInvocation("C:\\t3\\t3.cmd", [bad], "win32", "cmd.exe")).toThrow(UnsafeArgumentError)
    expect(() => buildInvocation('C:\\t3"\\t3.cmd', [], "win32", "cmd.exe")).toThrow(UnsafeArgumentError)
  })

  it("runs an executable directly with the argument array", () => {
    expect(buildInvocation("C:\\t3\\t3.exe", args, "win32", "cmd.exe")).toEqual({
      file: "C:\\t3\\t3.exe",
      args,
      windowsVerbatimArguments: false,
    })
    expect(buildInvocation("/usr/local/bin/t3.cmd", ['a"b'], "linux", undefined)).toEqual({
      file: "/usr/local/bin/t3.cmd",
      args: ['a"b'],
      windowsVerbatimArguments: false,
    })
  })
})

describe("childEnv", () => {
  it("never passes the agent token to a child process", () => {
    const env = childEnv({ PATH: "/bin", MIKUD_AGENT_TOKEN: "x".repeat(40) })
    expect(env).toEqual({ PATH: "/bin" })
  })
})

describe("lastLine", () => {
  it("returns the last non-empty line, shortened", () => {
    expect(lastLine("first\r\nsecond\n\n")).toBe("second")
    expect(lastLine(`${"x".repeat(300)}\n`, 10)).toBe("xxxxxxxxxx...")
  })
})

// A fake T3 CLI that prints its arguments and the token variable as JSON, run for real.
describe("runProcess", () => {
  const dir = mkdtempSync(join(tmpdir(), "mikud sync ("))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const echo = join(dir, "echo.js")
  writeFileSync(
    echo,
    "console.log(JSON.stringify({ args: process.argv.slice(2), token: process.env.MIKUD_AGENT_TOKEN ?? null }))\n" +
      "if (process.argv.includes('fail')) { console.error('No T3 Code project matches'); process.exit(3) }\n",
  )
  const tricky = ["thread", "list", "--project", "a&b|c<d>e^f!g (x) ;$(id)", "--json"]

  it.skipIf(process.platform === "win32")("runs a POSIX executable with the argument array", async () => {
    const cli = join(dir, "t3")
    writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${echo}" "$@"\n`)
    chmodSync(cli, 0o755)
    process.env.MIKUD_AGENT_TOKEN = "z".repeat(40)
    try {
      const result = await runProcess(cli, tricky, { timeoutMs: 10_000 })
      expect(result.error).toBeUndefined()
      expect(JSON.parse(result.stdout)).toEqual({ args: tricky, token: null })
    } finally {
      delete process.env.MIKUD_AGENT_TOKEN
    }
    const failed = await runProcess(cli, ["fail"], { timeoutMs: 10_000 })
    expect(failed.error).toBe("exit code 3")
    expect(lastLine(failed.stderr)).toBe("No T3 Code project matches")
  })

  it.runIf(process.platform === "win32")("runs a Windows .cmd file through cmd.exe", async () => {
    const sub = join(dir, "bin (x86)")
    mkdirSync(sub, { recursive: true })
    const cli = join(sub, "t3.cmd")
    writeFileSync(cli, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\nexit /b %ERRORLEVEL%\r\n`)
    const result = await runProcess(cli, tricky, { timeoutMs: 10_000 })
    expect(result.error).toBeUndefined()
    expect(JSON.parse(result.stdout)).toEqual({ args: tricky, token: null })
    const failed = await runProcess(cli, ["fail"], { timeoutMs: 10_000 })
    expect(failed.error).toBe("exit code 3")
  })

  it("reports a command that cannot start", async () => {
    const result = await runProcess(join(dir, "missing"), [], { timeoutMs: 5_000 })
    expect(result.code).toBeNull()
    expect(result.error).toMatch(/could not start/)
  })
})
