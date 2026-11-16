import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Runner, RunResult } from "./exec.ts"
import { CODEX_KEY_VARIABLE, codexEnvFile, type McpSetupDeps, setupMcp } from "./mcp-setup.ts"

/*
 * `setup-mcp` against fake `claude` and `codex` commands and a fake Windows registry, never the real ones. The fakes
 * answer with the output the real commands gave in disposable configuration folders (CLAUDE_CONFIG_DIR, CODEX_HOME):
 * Claude Code 2.1.325 and codex-cli 0.169.0, on 2026-11-16. Codex's auth_status values bearer_token, unknown,
 * unsupported and not_logged_in were seen; o_auth (signed in) is from Codex's source at rust-v0.169.0
 * (McpAuthStatus::OAuth, serde snake_case), not seen, since a real sign-in needs the owner's browser.
 */

const ISSUER = "https://adiutor.example.com"
const URL_MCP = `${ISSUER}/mcp`
const CLAUDE = "/usr/local/bin/claude"
const CODEX = "/usr/local/bin/codex"
const REG = "C:\\Windows\\System32\\reg.exe"
const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" })
const failed = (stderr: string, stdout = ""): RunResult => ({ code: 1, stdout, stderr, error: "exit code 1" })

type ClaudeEntry = { url: string; headers?: Record<string, string> }
/** Claude Code as `claude mcp` answered in a disposable CLAUDE_CONFIG_DIR. */
function fakeClaude(state: { user?: ClaudeEntry; local?: ClaudeEntry; project?: ClaudeEntry; other?: ClaudeEntry }) {
  const opts = { addFails: false }
  const scopeText = {
    user: "User config (available in all your projects)",
    local: "Local config (private to you in this project)",
    project: "Project config (shared via .mcp.json)",
  } as const
  const run: Runner = async (_command, args) => {
    const [, sub] = args
    if (sub === "get") {
      const scope = state.local ? "local" : state.user ? "user" : state.project ? "project" : null
      if (!scope) return failed('No MCP server named "adiutor". Run `claude mcp add` to add one.')
      const entry = state[scope] as ClaudeEntry
      return ok(
        `adiutor:\n  Scope: ${scopeText[scope]}\n  Status: × Failed to connect\n  Type: http\n  URL: ${entry.url}\n\nTo remove this server, run: claude mcp remove adiutor -s ${scope}\n`,
      )
    }
    if (sub === "remove") {
      if (!state.user) return failed('No MCP server named "adiutor" in user scope')
      delete state.user
      return ok("Removed MCP server adiutor from user config\nFile modified: /cfg/.claude.json\n")
    }
    if (sub === "add") {
      if (opts.addFails) return failed("Error: managed settings allow only plugin MCP servers")
      if (state.user) return failed("MCP server adiutor already exists in user config")
      state.user = { url: args[7] ?? "" }
      return ok(`Added HTTP MCP server adiutor with URL: ${args[7]} to user config\nFile modified: /cfg/.claude.json\n`)
    }
    return failed("unknown")
  }
  return { run, opts, state }
}

type CodexEntry = {
  transport:
    | { type: "streamable_http"; url: string; bearer_token_env_var: string | null }
    | { type: "stdio"; command: string }
  signedIn: boolean
}
/** Codex as `codex mcp` answered in a disposable CODEX_HOME; `server` is how Adiutor's address answers it. */
function fakeCodex(entries: Record<string, CodexEntry>, server: "oauth" | "unreachable" = "oauth") {
  const opts = { listFails: false, approve: true }
  let approvals = 0
  const status = (e: CodexEntry) =>
    e.transport.type === "stdio"
      ? "unsupported"
      : e.transport.bearer_token_env_var
        ? "bearer_token"
        : e.signedIn
          ? "o_auth"
          : server === "oauth"
            ? "not_logged_in"
            : "unknown"
  const listJson = () =>
    JSON.stringify(
      Object.entries(entries).map(([name, e]) => ({
        name,
        enabled: true,
        disabled_reason: null,
        transport:
          e.transport.type === "stdio"
            ? { type: "stdio", command: e.transport.command, args: [], env: null, env_vars: [], cwd: null }
            : {
                type: "streamable_http",
                url: e.transport.url,
                bearer_token_env_var: e.transport.bearer_token_env_var,
                http_headers: null,
                env_http_headers: null,
                http_headers_helper: null,
              },
        startup_timeout_sec: null,
        tool_timeout_sec: null,
        auth_status: status(e),
      })),
      null,
      2,
    )
  const signIn = (e: CodexEntry) => {
    approvals++
    e.signedIn = opts.approve
    return opts.approve
  }
  const run: Runner = async (_command, args) => {
    const [, sub, name] = args
    if (sub === "list") return opts.listFails ? failed("Error: failed to load config.toml") : ok(`${listJson()}\n`)
    if (sub === "remove") {
      if (!name || !entries[name]) return ok(`No MCP server named '${name}' found.\n`)
      delete entries[name]
      return ok(`Removed global MCP server '${name}'.\n`)
    }
    if (sub === "add" && name) {
      const e: CodexEntry = {
        transport: { type: "streamable_http", url: args[4] ?? "", bearer_token_env_var: null },
        signedIn: false,
      }
      entries[name] = e
      if (server !== "oauth")
        return ok(`Added global MCP server '${name}'.\nMCP server may or may not require login.\n`)
      // Codex 0.169.0 starts the sign-in by itself when the server offers OAuth (mcp_cmd.rs, "Detected OAuth support").
      return signIn(e)
        ? ok(`Added global MCP server '${name}'.\nDetected OAuth support. Starting OAuth flow…\n`)
        : failed("Error: OAuth login was cancelled", `Added global MCP server '${name}'.\n`)
    }
    if (sub === "login" && name && entries[name])
      return signIn(entries[name]) ? ok("Successfully logged in.\n") : failed("cancelled")
    return failed("unknown")
  }
  return { run, opts, entries, approvals: () => approvals }
}

/** The Windows user's environment as `reg query` and `reg delete` of HKCU\Environment see it. */
function fakeRegistry(values: Record<string, string>) {
  const run: Runner = async (_command, args) => {
    const name = args[3] ?? ""
    if (args[0] === "query")
      return name in values
        ? ok(`HKEY_CURRENT_USER\\Environment\n    ${name}    REG_SZ    ****\n`)
        : failed("ERROR: The system was unable to find the specified registry key or value.")
    if (args[0] === "delete" && args.includes("/f")) {
      delete values[name]
      return ok("The operation completed successfully.\n")
    }
    return failed("ERROR: Invalid syntax.")
  }
  return { run, values }
}

function deps(parts: { claude?: Runner; codex?: Runner; reg?: Runner }, platform: NodeJS.Platform = "linux") {
  const home = mkdtempSync(join(tmpdir(), "adiutor-mcp-"))
  temps.push(home)
  const lines: string[] = []
  const calls: string[][] = []
  const value: McpSetupDeps = {
    out: (line) => lines.push(line),
    runner: async (command, args, options) => {
      calls.push([command, ...args])
      const runner =
        command === CLAUDE ? parts.claude : command === CODEX ? parts.codex : command === REG ? parts.reg : undefined
      return runner ? runner(command, args, options) : failed("not found")
    },
    findCommand: async (name) =>
      name === "claude" && parts.claude ? CLAUDE : name === "codex" && parts.codex ? CODEX : undefined,
    systemCommand: async (name) => (name === "reg" && parts.reg ? REG : undefined),
    platform,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
  }
  return { deps: value, lines, calls, home, output: () => lines.join("\n") }
}

/** What the old `connect --for codex` left: the entry with the key's variable. */
const oldCodexEntry = (): CodexEntry => ({
  transport: { type: "streamable_http", url: URL_MCP, bearer_token_env_var: CODEX_KEY_VARIABLE },
  signedIn: false,
})
const otherEntry = (): CodexEntry => ({ transport: { type: "stdio", command: "node" }, signedIn: false })

describe("setup-mcp for Claude Code", () => {
  it("replaces the user-scope entry the old command wrote with one without a header, and asks no approval itself", async () => {
    const claude = fakeClaude({ user: { url: URL_MCP, headers: { Authorization: "Bearer [key]" } } })
    const d = deps({ claude: claude.run })
    expect(await setupMcp(ISSUER, "claude", d.deps)).toBe(0)
    expect(d.calls).toEqual([
      [CLAUDE, "mcp", "get", "adiutor"],
      [CLAUDE, "mcp", "remove", "adiutor", "--scope", "user"],
      [CLAUDE, "mcp", "add", "--transport", "http", "--scope", "user", "adiutor", URL_MCP],
    ])
    expect(claude.state.user).toEqual({ url: URL_MCP })
    expect(d.output()).toContain("Replaced Claude Code's adiutor entry (user scope)")
    expect(d.output()).toContain("Settings, Agent access")
  })

  it("reports a local entry and leaves it as it is, and touches no other scope", async () => {
    const claude = fakeClaude({
      user: { url: URL_MCP, headers: { Authorization: "Bearer [key]" } },
      local: { url: "http://localhost:8090/mcp" },
    })
    const d = deps({ claude: claude.run })
    expect(await setupMcp(ISSUER, "claude", d.deps)).toBe(0)
    expect(claude.state.local).toEqual({ url: "http://localhost:8090/mcp" })
    expect(claude.state.user).toEqual({ url: URL_MCP })
    expect(d.output()).toContain("adiutor entry of local scope in this folder; it is left as it is")
    expect(d.calls.every((c) => !c.includes("local") && !c.includes("project"))).toBe(true)
  })

  it("reports a project entry, then adds the user entry", async () => {
    const claude = fakeClaude({ project: { url: URL_MCP } })
    const d = deps({ claude: claude.run })
    expect(await setupMcp(ISSUER, "claude", d.deps)).toBe(0)
    expect(d.output()).toContain("of project scope")
    expect(d.output()).toContain("Added adiutor to Claude Code (user scope)")
  })

  it("finishes a run that stopped after the remove and before the add", async () => {
    const claude = fakeClaude({})
    const d = deps({ claude: claude.run })
    expect(await setupMcp(ISSUER, "claude", d.deps)).toBe(0)
    expect(claude.state.user).toEqual({ url: URL_MCP })
  })

  it("prints the exact add command when the add fails after the remove", async () => {
    const claude = fakeClaude({ user: { url: URL_MCP, headers: { Authorization: "Bearer [key]" } } })
    claude.opts.addFails = true
    const d = deps({ claude: claude.run })
    expect(await setupMcp(ISSUER, "claude", d.deps)).toBe(1)
    expect(d.output()).toContain("Adiutor is not set up in Claude Code until this runs:")
    expect(d.lines).toContain(`  claude mcp add --transport http --scope user adiutor "${URL_MCP}"`)
  })

  it("prints the command when claude is not installed", async () => {
    const d = deps({})
    expect(await setupMcp(ISSUER, "claude", d.deps)).toBe(1)
    expect(d.lines).toContain(`  claude mcp add --transport http --scope user adiutor "${URL_MCP}"`)
  })
})

describe("setup-mcp for Codex", () => {
  it("replaces the old entry with one that signs in (one approval) and removes the key's variable on Windows", async () => {
    const codex = fakeCodex({ adiutor: oldCodexEntry(), other: otherEntry() })
    const reg = fakeRegistry({ [CODEX_KEY_VARIABLE]: "old", PATH: "x" })
    const d = deps({ codex: codex.run, reg: reg.run }, "win32")
    expect(await setupMcp(ISSUER, "codex", d.deps)).toBe(0)
    expect(codex.approvals()).toBe(1)
    expect(codex.entries.adiutor).toMatchObject({
      transport: { type: "streamable_http", url: URL_MCP, bearer_token_env_var: null },
      signedIn: true,
    })
    expect(codex.entries.other).toEqual(otherEntry())
    expect(reg.values).toEqual({ PATH: "x" })
    expect(d.calls).toContainEqual([REG, "delete", "HKCU\\Environment", "/v", CODEX_KEY_VARIABLE, "/f"])
  })

  it("elsewhere removes the env file the old command wrote, only while it holds that variable alone", async () => {
    const codex = fakeCodex({ adiutor: oldCodexEntry() })
    const d = deps({ codex: codex.run })
    const file = codexEnvFile(d.deps.env)
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, `export ${CODEX_KEY_VARIABLE}='adt_${Date.now()}'\n`, { mode: 0o600 })
    expect(await setupMcp(ISSUER, "codex", d.deps)).toBe(0)
    expect(existsSync(file)).toBe(false)
    expect(d.output()).toContain(`Remove the line . "${file}" from your shell profile`)

    const again = fakeCodex({ adiutor: oldCodexEntry() })
    const e = deps({ codex: again.run })
    const kept = codexEnvFile(e.deps.env)
    mkdirSync(join(kept, ".."), { recursive: true })
    const text = `export ${CODEX_KEY_VARIABLE}='adt_${Date.now()}'\nexport OTHER=1\n`
    writeFileSync(kept, text, { mode: 0o600 })
    expect(await setupMcp(ISSUER, "codex", e.deps)).toBe(0)
    expect(readFileSync(kept, "utf8")).toBe(text)
  })

  it("keeps ADIUTOR_AGENT_KEY while another entry still reads it", async () => {
    const codex = fakeCodex({ adiutor: oldCodexEntry(), work: oldCodexEntry() })
    const reg = fakeRegistry({ [CODEX_KEY_VARIABLE]: "old" })
    const d = deps({ codex: codex.run, reg: reg.run }, "win32")
    expect(await setupMcp(ISSUER, "codex", d.deps)).toBe(0)
    expect(reg.values).toEqual({ [CODEX_KEY_VARIABLE]: "old" })
    expect(d.output()).toContain("Codex's work entry still reads it")
    expect(codex.entries.work).toEqual(oldCodexEntry())
  })

  it("changes nothing for an entry that is signed in already: no approval", async () => {
    const signed: CodexEntry = {
      transport: { type: "streamable_http", url: URL_MCP, bearer_token_env_var: null },
      signedIn: true,
    }
    const codex = fakeCodex({ adiutor: { ...signed } })
    const d = deps({ codex: codex.run })
    expect(await setupMcp(ISSUER, "codex", d.deps)).toBe(0)
    expect(codex.approvals()).toBe(0)
    expect(d.calls.map((c) => c[2])).toEqual(["list", "list"])
    expect(d.output()).toContain("signed in with OAuth; nothing was changed")
  })

  it("signs in once an entry whose sign-in was cancelled", async () => {
    const codex = fakeCodex({
      adiutor: { transport: { type: "streamable_http", url: URL_MCP, bearer_token_env_var: null }, signedIn: false },
    })
    const d = deps({ codex: codex.run })
    expect(await setupMcp(ISSUER, "codex", d.deps)).toBe(0)
    expect(codex.approvals()).toBe(1)
    expect(d.calls.filter((c) => c[2] === "login")).toHaveLength(1)
    expect(d.calls.some((c) => c[2] === "remove" || c[2] === "add")).toBe(false)
  })

  it("changes nothing for an entry with another address, an unknown sign-in, or a list it cannot read", async () => {
    const other = fakeCodex({
      adiutor: {
        transport: {
          type: "streamable_http",
          url: "http://localhost:8090/mcp",
          bearer_token_env_var: CODEX_KEY_VARIABLE,
        },
        signedIn: false,
      },
    })
    const reg = fakeRegistry({ [CODEX_KEY_VARIABLE]: "old" })
    const a = deps({ codex: other.run, reg: reg.run }, "win32")
    expect(await setupMcp(ISSUER, "codex", a.deps)).toBe(1)
    expect(a.output()).toContain("points to http://localhost:8090/mcp")
    expect(
      a.calls
        .filter((c) => c[0] === CODEX)
        .map((c) => c[2])
        .filter((s) => s !== "list"),
    ).toEqual([])
    expect(reg.values).toEqual({ [CODEX_KEY_VARIABLE]: "old" })
    expect(other.approvals()).toBe(0)

    const unknown = fakeCodex(
      {
        adiutor: { transport: { type: "streamable_http", url: URL_MCP, bearer_token_env_var: null }, signedIn: false },
      },
      "unreachable",
    )
    const b = deps({ codex: unknown.run })
    expect(await setupMcp(ISSUER, "codex", b.deps)).toBe(1)
    expect(b.output()).toContain('reports the sign-in of its adiutor entry as "unknown"; nothing was changed')
    expect(unknown.approvals()).toBe(0)
    expect(b.calls.map((c) => c[2])).toEqual(["list", "list"])

    const broken = fakeCodex({ adiutor: oldCodexEntry() })
    broken.opts.listFails = true
    const reg2 = fakeRegistry({ [CODEX_KEY_VARIABLE]: "old" })
    const c = deps({ codex: broken.run, reg: reg2.run }, "win32")
    expect(await setupMcp(ISSUER, "codex", c.deps)).toBe(1)
    expect(c.calls.map((x) => x[2])).toEqual(["list"])
    expect(broken.entries.adiutor).toEqual(oldCodexEntry())
    expect(reg2.values).toEqual({ [CODEX_KEY_VARIABLE]: "old" })
  })

  it("reads a list that is not JSON as unreadable, never as not signed in", async () => {
    const codex = fakeCodex({ adiutor: oldCodexEntry() })
    const d = deps({
      codex: async (cmd, args, o) => (args[1] === "list" ? ok("Name  Url\nadiutor ...\n") : codex.run(cmd, args, o)),
    })
    expect(await setupMcp(ISSUER, "codex", d.deps)).toBe(1)
    expect(d.output()).toContain("Could not read Codex's MCP servers")
    expect(codex.approvals()).toBe(0)
  })

  it("adds the entry when there is none, and keeps it to sign in again when the sign-in was cancelled", async () => {
    const codex = fakeCodex({})
    codex.opts.approve = false
    const d = deps({ codex: codex.run })
    expect(await setupMcp(ISSUER, "codex", d.deps)).toBe(1)
    expect(codex.approvals()).toBe(1)
    expect(codex.entries.adiutor?.signedIn).toBe(false)
    // The next run signs in once.
    codex.opts.approve = true
    const again = deps({ codex: codex.run })
    expect(await setupMcp(ISSUER, "codex", again.deps)).toBe(0)
    expect(codex.approvals()).toBe(2)
    expect(again.calls.filter((c) => c[2] === "login")).toHaveLength(1)
  })
})
