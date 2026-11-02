import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { buildInvocation, childEnv, findCommand, lastLine, runProcess, UnsafeArgumentError } from "./exec.ts"

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

describe("findCommand", () => {
  const root = mkdtempSync(join(tmpdir(), "mikud-find-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const folder = (name: string, files: Record<string, number>) => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    for (const [file, mode] of Object.entries(files)) {
      writeFileSync(join(dir, file), "")
      chmodSync(join(dir, file), mode)
    }
    return dir
  }

  it("on Windows, finds a batch file by PATHEXT's order on Path, never another extension or the current folder", async () => {
    const npm = folder("npm", { "codex.ps1": 0o644, "codex.cmd": 0o644, codex: 0o644 })
    const local = folder("local", { "claude.exe": 0o644 })
    const empty = folder("empty", {})
    const env = { Path: `${empty};"${local}";${npm}`, PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.PS1" }
    expect(await findCommand("codex", "win32", env)).toBe(join(npm, "codex.cmd"))
    expect(await findCommand("claude", "win32", env)).toBe(join(local, "claude.exe"))
    // .ps1 and a name without an extension are not started here, whatever PATHEXT says.
    expect(await findCommand("codex", "win32", { Path: npm, PATHEXT: ".PS1" })).toBeUndefined()
    expect(await findCommand("codex", "win32", { Path: npm })).toBe(join(npm, "codex.cmd"))
    expect(await findCommand("codex", "win32", {})).toBeUndefined()
  })

  it.skipIf(process.platform === "win32")("elsewhere, finds an executable file on PATH only", async () => {
    const plain = folder("plain", { claude: 0o644 })
    const bin = folder("bin", { claude: 0o755 })
    folder("bin/codex", {})
    expect(await findCommand("claude", "linux", { PATH: `${plain}:${bin}` })).toBe(join(bin, "claude"))
    expect(await findCommand("claude", "linux", { PATH: plain })).toBeUndefined()
    expect(await findCommand("codex", "linux", { PATH: bin })).toBeUndefined()
    expect(await findCommand("claude", "linux", { Path: bin })).toBeUndefined()
    // Relative entries would search the current folder.
    const before = process.cwd()
    process.chdir(bin)
    try {
      expect(await findCommand("claude", "linux", { PATH: ".::bin" })).toBeUndefined()
    } finally {
      process.chdir(before)
    }
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
