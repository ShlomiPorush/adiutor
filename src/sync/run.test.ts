import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { main } from "./cli.ts"
import type { Runner } from "./exec.ts"
import { type Deps, runSync } from "./run.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const overviewDir = join(fixtures, "overview")
const projectsFile = join(fixtures, "t3-projects.json")
const token = "agent-token-for-tests-0123456789abcdef"
const NODE = "/fake/node"

type Received = { method?: string; url?: string; auth?: string; body: unknown }
type Reply = { status: number; body: unknown }

let server: Server
let baseUrl: string
let received: Received[] = []
let replies: Record<string, (request: Received) => Reply> = {}
const temps: string[] = []

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    let text = ""
    req.on("data", (chunk) => {
      text += chunk
    })
    req.on("end", () => {
      const request: Received = {
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(text),
      }
      received.push(request)
      const reply = replies[req.url ?? ""]?.(request) ?? { status: 200, body: { ok: true } }
      res.writeHead(reply.status, { "content-type": "application/json" })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
afterEach(() => {
  received = []
  replies = {}
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mikud-sync-"))
  temps.push(dir)
  return dir
}

/** A fake runner: the collector fails or succeeds; the T3 CLI answers from the recorded fixtures. */
function fakeRunner(options: { collectorFails?: boolean } = {}) {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = []
  const runner: Runner = async (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd })
    if (command === NODE) {
      return options.collectorFails
        ? { code: 1, stdout: "", stderr: "Error: Another run is in progress (data/run.lock).\n", error: "exit code 1" }
        : { code: 0, stdout: '{"runId":"20261101T060000Z"}\n', stderr: "" }
    }
    const projectId = args[3] ?? ""
    if (projectId === "p-notes")
      return { code: 1, stdout: "", stderr: `No T3 Code project matches '${projectId}'.\n`, error: "exit code 1" }
    if (projectId === "p-missing") return { code: 0, stdout: "[]", stderr: "" }
    return {
      code: 0,
      stdout: readFileSync(join(fixtures, "threads", `${projectId.replace(":", "_")}.json`), "utf8"),
      stderr: "",
    }
  }
  return { runner, calls }
}

function deps(overrides: Partial<Deps> = {}, env: Record<string, string> = {}) {
  const lines: string[] = []
  const value: Deps = {
    env: { MIKUD_URL: baseUrl, MIKUD_AGENT_TOKEN: token, T3CODE_CLI_PATH: "C:\\t3\\t3.cmd", ...env },
    runner: fakeRunner().runner,
    fetch: (input, init) => fetch(input, init),
    out: (line) => lines.push(line),
    now: () => new Date("2026-11-01T05:31:00.000Z"),
    nodePath: NODE,
    ...overrides,
  }
  return { deps: value, lines, output: () => lines.join("\n") }
}

const run = { projectsFile, overviewDir, collect: true, dryRun: false }

describe("runSync", () => {
  it("runs the collector, reads every project and sends T3 first, then security", async () => {
    const fake = fakeRunner({ collectorFails: true })
    const { deps: d, output } = deps({ runner: fake.runner })
    expect(await runSync(run, d)).toBe(0)

    expect(fake.calls[0]).toEqual({ command: NODE, args: ["src/cli.mjs", "collect"], cwd: overviewDir })
    expect(
      fake.calls
        .slice(1)
        .map((c) => c.args[3])
        .sort(),
    ).toEqual(["mcp:p-gadget", "p-gizmo", "p-missing", "p-notes", "p-widget"])

    expect(received.map((r) => r.url)).toEqual(["/api/v1/sync/t3", "/api/v1/sync/security"])
    expect(received.every((r) => r.method === "POST" && r.auth === `Bearer ${token}`)).toBe(true)

    const t3 = received[0]?.body as { collectedAt: string; projects: unknown[]; threads: Array<{ threadId: string }> }
    expect(t3.collectedAt).toBe("2026-11-01T05:31:00.000Z")
    expect(t3.projects).toEqual([
      { t3ProjectId: "p-widget", title: "Widget", repo: "acme/widget" },
      { t3ProjectId: "mcp:p-gadget", title: "Gadget", repo: "acme/gadget" },
      { t3ProjectId: "p-gizmo", title: "Gizmo", repo: "acme/gizmo" },
      { t3ProjectId: "p-notes", title: "Notes" },
      { t3ProjectId: "p-missing", title: "Missing", repo: "acme/missing" },
    ])
    expect(t3.threads.map((t) => t.threadId)).toEqual(["thread-w1", "thread-w2", "thread-w3", "thread-g1", "thread-z1"])

    const security = received[1]?.body as { collectedAt: string; repos: Array<{ repo: string }> }
    expect(security.collectedAt).toBe("2026-11-01T05:31:00.000Z")
    expect(security.repos.map((r) => r.repo)).toEqual(["acme/widget", "acme/gadget", "acme/gizmo"])

    const text = output()
    expect(text).toContain(
      "overview: the collector failed (exit code 1: Error: Another run is in progress (data/run.lock).)",
    )
    expect(text).toContain("overview: snapshot 20261101T060000Z finished 2026-11-01T06:05:00.000Z")
    expect(text).toContain("t3: 5 projects in the projects file (3 records skipped)")
    expect(text).toContain(
      "t3: threads of project p-notes not read: exit code 1: No T3 Code project matches 'p-notes'.",
    )
    expect(text).toContain("t3: 5 threads (1 child threads), 1 records skipped, 1 of 5 projects not read")
    expect(text).toContain("security: 3 repositories, 1 project repositories not in the snapshot")
    expect(text).toContain('t3 sync: sent (HTTP 200) {"ok":true}')
    expect(text).toContain('security sync: sent (HTTP 200) {"ok":true}')
  })

  it("skips the collector with --no-collect", async () => {
    const fake = fakeRunner()
    const { deps: d, output } = deps({ runner: fake.runner })
    expect(await runSync({ ...run, collect: false }, d)).toBe(0)
    expect(fake.calls.some((c) => c.command === NODE)).toBe(false)
    expect(output()).toContain("collector skipped (--no-collect)")
  })

  it("sends nothing in a dry run and needs no server settings", async () => {
    const { deps: d, output } = deps({}, { MIKUD_URL: "", MIKUD_AGENT_TOKEN: "" })
    expect(await runSync({ ...run, collect: false, dryRun: true }, d)).toBe(0)
    expect(received).toHaveLength(0)
    const text = output()
    expect(text).toMatch(/dry run: t3 payload \d+ bytes/)
    expect(text).toMatch(/dry run: security payload \d+ bytes/)
    expect(text).toContain('"threadId":"thread-w1"')
  })

  it("exits zero when one push succeeds and prints the server's error", async () => {
    replies["/api/v1/sync/t3"] = () => ({ status: 500, body: { error: { code: "internal", message: "boom" } } })
    const { deps: d, output } = deps()
    expect(await runSync(run, d)).toBe(0)
    expect(output()).toContain('t3 sync: refused (HTTP 500) {"error":{"code":"internal","message":"boom"}}')
    expect(output()).toContain("security sync: sent (HTTP 200)")
  })

  it("exits non-zero when nothing could be pushed", async () => {
    replies["/api/v1/sync/t3"] = () => ({
      status: 401,
      body: { error: { code: "unauthorized", message: "bad token" } },
    })
    replies["/api/v1/sync/security"] = replies["/api/v1/sync/t3"]
    const { deps: d } = deps()
    expect(await runSync(run, d)).toBe(1)
  })

  it("still sends security when the T3 CLI is not configured", async () => {
    const { deps: d, output } = deps({}, { T3CODE_CLI_PATH: "" })
    expect(await runSync(run, d)).toBe(0)
    expect(received.map((r) => r.url)).toEqual(["/api/v1/sync/security"])
    expect(output()).toContain("t3 sync: not sent (no threads could be read)")
  })

  it("exits non-zero without a readable projects file", async () => {
    const { deps: d, output } = deps()
    expect(await runSync({ ...run, projectsFile: join(tempDir(), "missing.json") }, d)).toBe(1)
    expect(output()).toContain("t3: cannot read the projects file: ENOENT")
    expect(received).toHaveLength(0)
  })

  it("refuses to run without the URL or the token", async () => {
    const { deps: d, output } = deps({}, { MIKUD_AGENT_TOKEN: "" })
    expect(await runSync(run, d)).toBe(2)
    expect(output()).toContain("MIKUD_AGENT_TOKEN is required")
  })
})

describe("the agent token", () => {
  it("never appears in any output, even when the server repeats it", async () => {
    const dir = tempDir()
    const envFile = join(dir, "sync.env")
    writeFileSync(envFile, `MIKUD_URL=${baseUrl}\nMIKUD_AGENT_TOKEN=${token}\n`)
    replies["/api/v1/sync/t3"] = (r) => ({
      status: 401,
      body: { error: { code: "unauthorized", message: `got ${r.auth}` } },
    })
    replies["/api/v1/sync/security"] = (r) => ({ status: 200, body: { echo: r.auth } })
    const { deps: d, output } = deps({}, { MIKUD_URL: "", MIKUD_AGENT_TOKEN: "" })

    expect(await runSync({ ...run, envFile }, d)).toBe(0)
    expect(received.every((r) => r.auth === `Bearer ${token}`)).toBe(true)
    expect(output()).toContain("[redacted]")
    expect(output()).not.toContain(token)
  })

  it("never appears when the server cannot be reached", async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const { deps: d, output } = deps({}, { MIKUD_URL: `http://127.0.0.1:${port}` })
    expect(await runSync(run, d)).toBe(1)
    expect(output()).toContain("t3 sync: not sent: cannot reach the server")
    expect(output()).not.toContain(token)
  })

  it("never appears in a configuration error or a bad env file", async () => {
    const dir = tempDir()
    const envFile = join(dir, "sync.env")
    writeFileSync(envFile, `MIKUD_URL=${baseUrl}\n${token}\n`)
    const bad = deps({}, { MIKUD_AGENT_TOKEN: "" })
    expect(await runSync({ ...run, envFile }, bad.deps)).toBe(2)
    expect(bad.output()).toContain("env file line 2 is not KEY=VALUE")
    expect(bad.output()).not.toContain(token)

    const short = "short-token-0123456789"
    const config = deps({}, { MIKUD_AGENT_TOKEN: short })
    expect(await runSync(run, config.deps)).toBe(2)
    expect(config.output()).not.toContain(short)
  })

  it("is never accepted on the command line", async () => {
    const { deps: d, output } = deps()
    expect(await main(["run", "--projects", projectsFile, "--token", token], d)).toBe(2)
    expect(output()).toContain("unknown or incomplete option")
    expect(output()).not.toContain(token)
    expect(received).toHaveLength(0)
  })
})

describe("main", () => {
  it("prints the usage for help and refuses an incomplete command", async () => {
    const help = deps()
    expect(await main(["--help"], help.deps)).toBe(0)
    expect(help.output()).toContain("Usage: node mikud-sync.js run --projects <file>")
    expect(await main(["run"], deps().deps)).toBe(2)
    expect(await main(["push", "--projects", projectsFile], deps().deps)).toBe(2)
  })

  it("runs a dry run from the command line", async () => {
    const { deps: d, output } = deps()
    expect(
      await main(["run", "--projects", projectsFile, "--overview", overviewDir, "--no-collect", "--dry-run"], d),
    ).toBe(0)
    expect(output()).toContain("dry run: nothing is sent")
    expect(received).toHaveLength(0)
  })
})
