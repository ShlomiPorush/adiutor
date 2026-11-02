import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  AGENT_KEY_DAYS_MAX,
  AGENT_KEY_DAYS_MIN,
  AGENT_KEY_NAME_MAX,
  CONNECT_CLIENT_ID as SERVER_CLIENT_ID,
} from "../shared/auth.ts"
import { connectUrl, DEFAULT_DAYS, main } from "./cli.ts"
import {
  aclEntries,
  CONNECT_CLIENT_ID,
  type ConnectDeps,
  type ConnectOptions,
  claudeCommand,
  connect,
  DAYS_MAX,
  DAYS_MIN,
  defaultEnvFile,
  NAME_MAX,
  withSyncKey,
} from "./connect.ts"
import { parseEnvFile } from "./env.ts"
import type { Runner, RunResult } from "./exec.ts"

// `connect` against a stand-in Mikud: the device flow's answers, the key, and the end of the temporary session.
// Secrets are assembled at run time: the guards scan literal text.

const URL_BASE = "https://mikud.example.com"
const SESSION = ["session", "token", "for", "tests", "0123456789"].join("-")
const KEY = ["mkd", "KeyForTestsOnly0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP"].join("_")
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mikud-connect-"))
  temps.push(dir)
  return dir
}

type Sent = { path: string; body: Record<string, unknown>; auth?: string; userAgent?: string }
type Reply = { status: number; body: unknown }

/** A stand-in Mikud: token answers in order, then the key and the revoke answers a test chooses. */
function standIn(options: { polls?: Reply[]; create?: Reply; revoke?: Reply | "network" } = {}) {
  const sent: Sent[] = []
  const polls = [...(options.polls ?? [{ status: 200, body: { access_token: SESSION, token_type: "Bearer" } }])]
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname.replace(/^\/api\/auth/, "")
    const headers = init.headers as Record<string, string>
    sent.push({
      path,
      body: JSON.parse(String(init.body)),
      auth: headers.authorization,
      userAgent: headers["user-agent"],
    })
    const json = (reply: Reply) =>
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      })
    if (path === "/device/code")
      return json({
        status: 200,
        body: {
          device_code: "device-code-for-tests",
          user_code: "ABCDEFGH",
          verification_uri: `${URL_BASE}/connect/device`,
          verification_uri_complete: `${URL_BASE}/connect/device?user_code=ABCDEFGH`,
          expires_in: 600,
          interval: 5,
        },
      })
    if (path === "/device/token") return json(polls.shift() ?? { status: 400, body: { error: "expired_token" } })
    if (path === "/api-key/create")
      return json(
        options.create ?? { status: 200, body: { key: KEY, id: "k1", expiresAt: "2027-01-31T08:00:00.000Z" } },
      )
    if (path === "/revoke-session") {
      if (options.revoke === "network")
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })
      return json(options.revoke ?? { status: 200, body: { status: true } })
    }
    return json({ status: 404, body: { code: "NOT_FOUND" } })
  }
  return { fetch, sent }
}

const pending = { status: 400, body: { error: "authorization_pending" } }
const slowDown = { status: 400, body: { error: "slow_down" } }

function deps(
  fetch: ConnectDeps["fetch"],
  overrides: Partial<ConnectDeps> = {},
): ConnectDeps & { lines: string[]; waits: number[]; ran: { command: string; args: string[] }[] } {
  const lines: string[] = []
  const waits: number[] = []
  const ran: { command: string; args: string[] }[] = []
  let clock = 0
  const runner: Runner = async (command, args) => {
    ran.push({ command, args })
    return { code: 0, stdout: "", stderr: "" }
  }
  return {
    fetch,
    out: (line) => lines.push(line),
    runner,
    platform: "linux",
    env: {},
    sleep: async (ms) => {
      waits.push(ms)
      clock += ms
    },
    now: () => clock,
    ...overrides,
    lines,
    waits,
    ran,
  }
}

const options = (overrides: Partial<ConnectOptions> = {}): ConnectOptions => ({
  url: URL_BASE,
  name: "claude-laptop",
  days: 30,
  target: "claude",
  envFile: join(tempDir(), "mikud", "sync.env"),
  open: false,
  ...overrides,
})

describe("connect: the device flow", () => {
  it("polls through authorization_pending and slow_down, creates one named key with its days, then ends the session", async () => {
    const mikud = standIn({ polls: [pending, slowDown, pending, { status: 200, body: { access_token: SESSION } }] })
    const d = deps(mikud.fetch)
    expect(await connect(options(), d)).toBe(0)

    expect(mikud.sent.map((s) => s.path)).toEqual([
      "/device/code",
      "/device/token",
      "/device/token",
      "/device/token",
      "/device/token",
      "/api-key/create",
      "/revoke-session",
    ])
    expect(mikud.sent[0]?.body).toEqual({ client_id: CONNECT_CLIENT_ID })
    expect(mikud.sent.every((s) => s.userAgent === CONNECT_CLIENT_ID)).toBe(true)
    // RFC 8628: slow_down adds 5 seconds to every later wait.
    expect(d.waits).toEqual([5000, 5000, 10_000, 10_000])
    const create = mikud.sent[5]
    expect(create?.auth).toBe(`Bearer ${SESSION}`)
    expect(create?.body).toEqual({ name: "claude-laptop", expiresIn: 30 * 86_400 })
    const revoke = mikud.sent[6]
    expect(revoke?.auth).toBe(`Bearer ${SESSION}`)
    expect(revoke?.body).toEqual({ token: SESSION })
    // The device code and polling never carry a session.
    expect(mikud.sent.slice(0, 5).every((s) => s.auth === undefined)).toBe(true)
    expect(d.lines.join("\n")).toContain("ABCD-EFGH")
    expect(d.lines.join("\n")).not.toContain(SESSION)
  })

  it("treats a rate-limited poll (429) as slow_down and keeps waiting for the approval", async () => {
    const limited = { status: 429, body: { message: "Too many requests" } }
    const mikud = standIn({ polls: [pending, limited, limited, { status: 200, body: { access_token: SESSION } }] })
    const d = deps(mikud.fetch)
    expect(await connect(options(), d)).toBe(0)
    expect(d.waits).toEqual([5000, 5000, 10_000, 15_000])
    expect(mikud.sent.map((s) => s.path)).toContain("/api-key/create")
  })

  it("stops at access_denied without a key or a session", async () => {
    const mikud = standIn({ polls: [pending, { status: 400, body: { error: "access_denied" } }] })
    const d = deps(mikud.fetch)
    expect(await connect(options(), d)).toBe(1)
    expect(mikud.sent.map((s) => s.path)).not.toContain("/api-key/create")
    expect(mikud.sent.map((s) => s.path)).not.toContain("/revoke-session")
    expect(d.lines.join("\n")).toContain("denied")
  })

  it("stops when the code expires, by Mikud's answer or by its own clock", async () => {
    const byAnswer = standIn({ polls: [pending, { status: 400, body: { error: "expired_token" } }] })
    expect(await connect(options(), deps(byAnswer.fetch))).toBe(1)
    const neverAnswered = standIn({ polls: Array.from({ length: 200 }, () => pending) })
    const d = deps(neverAnswered.fetch)
    expect(await connect(options(), d)).toBe(1)
    // 600 seconds at 5 seconds: the last poll is before the code's end.
    expect(neverAnswered.sent.filter((s) => s.path === "/device/token").length).toBe(119)
    expect(d.lines.join("\n")).toContain("expired")
  })

  it("ends the session even when Mikud does not create the key", async () => {
    const mikud = standIn({ create: { status: 400, body: { code: "EXPIRES_IN_IS_TOO_LARGE" } } })
    const d = deps(mikud.fetch)
    expect(await connect(options(), d)).toBe(1)
    expect(mikud.sent.at(-1)?.path).toBe("/revoke-session")
    expect(d.lines.join("\n")).toContain("EXPIRES_IN_IS_TOO_LARGE")
  })

  it("says so when the end of the session is not confirmed", async () => {
    for (const revoke of [{ status: 403, body: { code: "OWN_SESSION_ONLY" } }, "network" as const]) {
      const mikud = standIn({ revoke })
      const d = deps(mikud.fetch)
      expect(await connect(options(), d)).toBe(0)
      expect(d.lines.join("\n")).toContain("could not confirm that the approval's temporary session ended")
      expect(d.lines.join("\n")).toContain("mikud connect (agent approval)")
      expect(d.lines.join("\n")).not.toContain(SESSION)
    }
  })

  it("refuses an approval link on another address and never opens it", async () => {
    const mikud = standIn()
    const d = deps(mikud.fetch)
    expect(await connect(options({ url: "https://other.example.com", open: true }), d)).toBe(1)
    expect(d.ran).toEqual([])
  })

  it("opens the approval page without a shell", async () => {
    for (const [platform, command] of [
      ["win32", "rundll32.exe"],
      ["darwin", "open"],
      ["linux", "xdg-open"],
    ] as const) {
      const mikud = standIn()
      const d = deps(mikud.fetch, { platform })
      await connect(options({ open: true }), d)
      expect(d.ran[0]?.command).toBe(command)
      expect(d.ran[0]?.args.at(-1)).toBe(`${URL_BASE}/connect/device?user_code=ABCDEFGH`)
    }
  })
})

describe("connect: what each client gets", () => {
  it("prints the claude mcp add command once, with the key in its header", async () => {
    const d = deps(standIn().fetch)
    expect(await connect(options({ target: "claude" }), d)).toBe(0)
    const command = `claude mcp add --transport http --scope user mikud ${URL_BASE}/mcp --header "Authorization: Bearer ${KEY}"`
    expect(claudeCommand(URL_BASE, KEY)).toBe(command)
    expect(d.lines.filter((line) => line.includes(KEY))).toEqual([command])
    expect(d.lines.join("\n")).toContain("shell history")
  })

  it("prints Codex's config.toml lines with bearer_token_env_var, and setx on Windows", async () => {
    const windows = deps(standIn().fetch, { platform: "win32" })
    expect(await connect(options({ target: "codex" }), windows)).toBe(0)
    const text = windows.lines.join("\n")
    expect(text).toContain(`[mcp_servers.mikud]\nurl = "${URL_BASE}/mcp"\nbearer_token_env_var = "MIKUD_AGENT_KEY"`)
    expect(windows.lines.filter((line) => line.includes(KEY))).toEqual([`setx MIKUD_AGENT_KEY "${KEY}"`])
    expect(text).toContain("shell history")

    const linux = deps(standIn().fetch, { platform: "linux" })
    await connect(options({ target: "codex" }), linux)
    expect(linux.lines.filter((line) => line.includes(KEY))).toEqual([`export MIKUD_AGENT_KEY="${KEY}"`])
  })
})

describe("connect: the sync's env file", () => {
  it("writes the key into a file only the owner can read, keeps its other values, never the session token", async () => {
    const file = join(tempDir(), "mikud", "sync.env")
    const d = deps(standIn().fetch)
    expect(await connect(options({ target: "sync", envFile: file }), d)).toBe(0)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(file, "..")).mode & 0o077).toBe(0)
    expect(readFileSync(file, "utf8")).toBe(`MIKUD_URL=${URL_BASE}\nMIKUD_AGENT_TOKEN=${KEY}\n`)
    expect(d.lines.join("\n")).not.toContain(KEY)

    writeFileSync(file, `# the sync\nT3CODE_CLI_PATH=C:\\t3\\t3.cmd\nMIKUD_AGENT_TOKEN=old\n`, { mode: 0o644 })
    expect(await connect(options({ target: "sync", envFile: file }), deps(standIn().fetch))).toBe(0)
    expect(readFileSync(file, "utf8")).toBe(
      `# the sync\nT3CODE_CLI_PATH=C:\\t3\\t3.cmd\nMIKUD_AGENT_TOKEN=${KEY}\nMIKUD_URL=${URL_BASE}\n`,
    )
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, "utf8")).not.toContain(SESSION)
  })

  it("leaves exactly one definition of each value when the file holds duplicates, so the new key wins", async () => {
    const file = join(tempDir(), "sync.env")
    writeFileSync(
      file,
      [
        "MIKUD_URL=https://old.example.com",
        "MIKUD_AGENT_TOKEN=old-one",
        "T3CODE_CLI_PATH=C:\\t3\\t3.cmd",
        "export MIKUD_AGENT_TOKEN=old-two",
        "# a comment",
        "MIKUD_URL=https://older.example.com",
        "MIKUD_OVERVIEW_DIR=C:\\overview",
        "",
      ].join("\n"),
    )
    expect(await connect(options({ target: "sync", envFile: file }), deps(standIn().fetch))).toBe(0)
    const text = readFileSync(file, "utf8")
    expect(parseEnvFile(text)).toEqual({
      MIKUD_URL: URL_BASE,
      MIKUD_AGENT_TOKEN: KEY,
      T3CODE_CLI_PATH: "C:\\t3\\t3.cmd",
      MIKUD_OVERVIEW_DIR: "C:\\overview",
    })
    expect(text.split("\n").filter((line) => /MIKUD_AGENT_TOKEN=/.test(line))).toEqual([`MIKUD_AGENT_TOKEN=${KEY}`])
    expect(text.split("\n").filter((line) => /MIKUD_URL=/.test(line))).toEqual([`MIKUD_URL=${URL_BASE}`])
    expect(text).toContain("# a comment\n")
  })

  it("ends the session when the key cannot be saved, and says which key to disconnect", async () => {
    const file = join(tempDir(), "sync.env")
    writeFileSync(file, "this line is not KEY=VALUE\n")
    const mikud = standIn()
    const d = deps(mikud.fetch)
    expect(await connect(options({ target: "sync", envFile: file }), d)).toBe(1)
    expect(mikud.sent.at(-1)?.path).toBe("/revoke-session")
    expect(d.lines.join("\n")).toContain('the key "claude-laptop" was created but could not be saved')
    expect(readFileSync(file, "utf8")).not.toContain(KEY)
  })

  it("on Windows, restricts the file with icacls and checks it before asking Mikud for anything", async () => {
    const file = join(tempDir(), "sync.env")
    const acl = (entries: string[]): RunResult => ({
      code: 0,
      stdout: `${file} ${entries.join("\n    ")}\n\nSuccessfully processed 1 files; Failed processing 0 files\n`,
      stderr: "",
    })
    const env = { USERNAME: "owner", USERDOMAIN: "DESKTOP" }
    const ok = standIn()
    const calls: string[][] = []
    const good = deps(ok.fetch, {
      platform: "win32",
      env,
      runner: async (command, args) => {
        calls.push([command, ...args])
        return args.length === 1 ? acl(["DESKTOP\\owner:(F)"]) : { code: 0, stdout: "", stderr: "" }
      },
    })
    expect(await connect(options({ target: "sync", envFile: file }), good)).toBe(0)
    expect(calls[0]).toEqual(["icacls", file, "/inheritance:r", "/grant:r", "DESKTOP\\owner:F"])
    expect(calls[1]).toEqual(["icacls", file])
    expect(readFileSync(file, "utf8")).toContain(KEY)

    for (const entries of [
      ["DESKTOP\\owner:(F)", "BUILTIN\\Administrators:(I)(F)"],
      ["DESKTOP\\owner:(I)(F)"],
      ["DESKTOP\\someone:(F)"],
      ["DESKTOP\\owner:(R)"],
    ]) {
      const refused = standIn()
      const d = deps(refused.fetch, {
        platform: "win32",
        env,
        runner: async (_command, args) => (args.length === 1 ? acl(entries) : { code: 0, stdout: "", stderr: "" }),
      })
      expect(await connect(options({ target: "sync", envFile: join(tempDir(), "sync.env") }), d)).toBe(1)
      expect(refused.sent).toEqual([])
      expect(d.lines.join("\n")).toContain("not restricted to the current user")
    }
  })

  it("reads icacls entries and sets only the two keys", () => {
    const path = "C:\\Users\\owner\\AppData\\Local\\mikud\\sync.env"
    expect(aclEntries(`${path} DESKTOP\\owner:(F)\n                 NT AUTHORITY\\SYSTEM:(F)\n\nDone\n`, path)).toEqual(
      ["DESKTOP\\owner:(F)", "NT AUTHORITY\\SYSTEM:(F)"],
    )
    expect(withSyncKey("export MIKUD_URL=x\r\nOTHER=1\r\n", "https://m", "k")).toBe(
      "MIKUD_URL=https://m\nOTHER=1\nMIKUD_AGENT_TOKEN=k\n",
    )
  })

  it("keeps the env file outside every repository by default", () => {
    expect(defaultEnvFile("win32", { LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" })).toBe(
      "C:\\Users\\owner\\AppData\\Local\\mikud\\sync.env",
    )
    expect(defaultEnvFile("linux", { XDG_CONFIG_HOME: "/home/owner/.config" })).toBe(
      "/home/owner/.config/mikud/sync.env",
    )
  })
})

describe("connect: the command line", () => {
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const lines: string[] = []
    const code = await main(["connect", ...args], {
      env,
      runner: async () => ({ code: 0, stdout: "", stderr: "" }),
      fetch: async () => {
        throw new Error("no request expected")
      },
      out: (line) => lines.push(line),
      now: () => new Date(0),
      nodePath: "/fake/node",
    })
    return { code, text: lines.join("\n") }
  }

  it("refuses a missing name, target or address, days out of range, and http other than this machine", async () => {
    expect((await run(["--for", "claude", "--url", URL_BASE])).code).toBe(2)
    expect((await run(["--name", "x", "--url", URL_BASE])).code).toBe(2)
    expect((await run(["--name", "x", "--for", "other", "--url", URL_BASE])).code).toBe(2)
    expect((await run(["--name", "x", "--for", "claude", "--url", URL_BASE, "--days", "0"])).code).toBe(2)
    expect((await run(["--name", "x", "--for", "claude", "--url", URL_BASE, "--days", "366"])).code).toBe(2)
    expect((await run(["--name", "x", "--for", "claude", "--url", URL_BASE, "--days", "1.5"])).code).toBe(2)
    expect((await run(["--name", "x".repeat(33), "--for", "claude", "--url", URL_BASE])).code).toBe(2)
    expect((await run(["--name", "x", "--for", "claude", "--env", "/nonexistent/sync.env"])).code).toBe(2)
    expect(connectUrl("http://mikud.example.com")).toBeUndefined()
    expect(connectUrl("https://user:pw@mikud.example.com")).toBeUndefined()
    expect(connectUrl("https://mikud.example.com/?q=1")).toBeUndefined()
    expect(connectUrl("https://mikud.example.com/")).toBe("https://mikud.example.com")
    expect(connectUrl("http://127.0.0.1:8090")).toBe("http://127.0.0.1:8090")
  })

  it("matches the server's client id and key limits, and defaults to 90 days", () => {
    expect(CONNECT_CLIENT_ID).toBe(SERVER_CLIENT_ID)
    expect([DAYS_MIN, DAYS_MAX, NAME_MAX]).toEqual([AGENT_KEY_DAYS_MIN, AGENT_KEY_DAYS_MAX, AGENT_KEY_NAME_MAX])
    expect(DEFAULT_DAYS).toBe(90)
  })
})
