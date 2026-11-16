import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { main } from "./cli.ts"
import type { Runner } from "./exec.ts"
import { type FakeAdiutor, startFakeAdiutor } from "./fake-adiutor.ts"
import { syncClient } from "./oauth.ts"
import { type Deps, runSync } from "./run.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const overviewDir = join(fixtures, "overview")
const projectsFile = join(fixtures, "t3-projects.json")
const NODE = "/fake/node"

// A stand-in Adiutor with the agent REST channel (src/sync/fake-adiutor.ts); the sync is connected to it in a home
// folder of its own before each test. Every token is new on every run.
let fake: FakeAdiutor
let home: string
const temps: string[] = []

beforeAll(async () => {
  fake = await startFakeAdiutor()
})
afterAll(() => fake.close())
beforeEach(async () => {
  home = tempDir()
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") }
  const clientDeps = {
    fetch: (input: string, init: RequestInit) => fetch(input, init),
    runner: (async () => ({ code: 1, stdout: "", stderr: "" })) as Runner,
    systemCommand: async () => undefined,
    platform: "linux" as const,
    env,
    now: () => Date.now(),
    sleep: async () => {
      fake.approve()
      await new Promise((resolve) => setTimeout(resolve, 1))
    },
  }
  const client = syncClient(fake.issuer, clientDeps)
  await client.prepare()
  await client.waitForApproval(await client.deviceCode("Test sync"), "Test sync")
})
afterEach(() => {
  fake.pushes.length = 0
  Object.assign(fake, { beforePush: [], afterPush: [], dropNextRefresh: false, listingStatus: 0 })
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "adiutor-sync-"))
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
    env: {
      ADIUTOR_URL: fake.issuer,
      T3CODE_CLI_PATH: "C:\\t3\\t3.cmd",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      ...env,
    },
    platform: "linux",
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
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
    const cli = fakeRunner({ collectorFails: true })
    const { deps: d, output } = deps({ runner: cli.runner })
    expect(await runSync(run, d)).toBe(0)

    expect(cli.calls[0]).toEqual({ command: NODE, args: ["src/cli.mjs", "collect"], cwd: overviewDir })
    expect(
      cli.calls
        .slice(1)
        .map((c) => c.args[3])
        .sort(),
    ).toEqual(["mcp:p-gadget", "p-gizmo", "p-missing", "p-notes", "p-widget"])

    expect(fake.pushes.map((p) => [p.path, p.policy, p.kind])).toEqual([
      ["/api/v1/sync/t3", fake.revision, "act"],
      ["/api/v1/sync/security", fake.revision, "act"],
    ])

    const t3 = fake.pushes[0]?.body as {
      collectedAt: string
      projects: unknown[]
      threads: Array<{ threadId: string }>
      failedProjects: string[]
    }
    expect(t3.collectedAt).toBe("2026-11-01T05:31:00.000Z")
    expect(t3.projects).toEqual([
      { t3ProjectId: "p-widget", title: "Widget", repo: "acme/widget" },
      { t3ProjectId: "mcp:p-gadget", title: "Gadget", repo: "acme/gadget" },
      { t3ProjectId: "p-gizmo", title: "Gizmo", repo: "acme/gizmo" },
      { t3ProjectId: "p-notes", title: "Notes" },
      { t3ProjectId: "p-missing", title: "Missing", repo: "acme/missing" },
    ])
    expect(t3.threads.map((t) => t.threadId)).toEqual(["thread-w1", "thread-w2", "thread-w3", "thread-g1", "thread-z1"])
    // The server must not take the missing threads of an unread project, or of one with invalid thread
    // records (p-gizmo), as a complete picture.
    expect(t3.failedProjects).toEqual(["p-gizmo", "p-notes"])

    const security = fake.pushes[1]?.body as { collectedAt: string; repos: Array<{ repo: string }> }
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
    expect(text).toContain("t3: project p-gizmo has 1 invalid thread records; sent as not fully read")
    expect(text).toContain("t3: 5 threads (1 child threads), 1 records skipped, 1 of 5 projects not read")
    expect(text).toContain("security: 3 repositories, 1 project repositories not in the snapshot")
    expect(text).toContain('t3 sync: sent (HTTP 200) {"data":{"outcome":"succeeded","counts":{}}}')
    expect(text).toContain("security sync: sent (HTTP 200)")
    for (const secret of fake.secrets()) expect(text).not.toContain(secret)
  })

  it("skips the collector with --no-collect", async () => {
    const t3 = fakeRunner()
    const { deps: d, output } = deps({ runner: t3.runner })
    expect(await runSync({ ...run, collect: false }, d)).toBe(0)
    expect(t3.calls.some((c) => c.command === NODE)).toBe(false)
    expect(output()).toContain("collector skipped (--no-collect)")
  })

  it("sends nothing in a dry run and needs no server settings", async () => {
    const { deps: d, output } = deps({}, { ADIUTOR_URL: "" })
    expect(await runSync({ ...run, collect: false, dryRun: true }, d)).toBe(0)
    expect(fake.pushes).toHaveLength(0)
    const text = output()
    expect(text).toMatch(/dry run: t3 payload \d+ bytes/)
    expect(text).toMatch(/dry run: security payload \d+ bytes/)
    expect(text).toContain('"threadId":"thread-w1"')
  })

  it("a lost answer or a server failure after a push is outcome_unknown, never sent again; the next run sends again", async () => {
    fake.afterPush.push("drop", 500)
    const first = deps()
    expect(await runSync(run, first.deps)).toBe(1)
    expect(first.output()).toContain("t3 sync: outcome unknown: it may have reached Adiutor")
    expect(first.output()).toContain("security sync: outcome unknown (HTTP 500)")
    expect(fake.pushes.map((p) => p.path)).toEqual(["/api/v1/sync/t3", "/api/v1/sync/security"])
    const next = deps()
    expect(await runSync(run, next.deps)).toBe(0)
    expect(fake.pushes).toHaveLength(4)
  })

  it("exits zero when one push succeeds and prints Adiutor's refusal", async () => {
    fake.beforePush.push("policy_changed", "policy_changed")
    const { deps: d, output } = deps()
    expect(await runSync(run, d)).toBe(0)
    expect(output()).toContain("t3 sync: not sent: policy_changed")
    expect(output()).toContain("security sync: sent (HTTP 200)")
  })

  it("says the sync is disconnected, and how to reconnect, when Adiutor ended the connection", async () => {
    fake.endAllGrants()
    const { deps: d, output } = deps()
    expect(await runSync({ ...run, envFile: undefined }, d)).toBe(1)
    const text = output()
    expect(text).toContain("t3 sync: not sent: connection_ended")
    expect(text).toContain(
      `The sync is disconnected from Adiutor; reconnect it: node adiutor-sync.js connect --name "<name>" --url "${fake.issuer}" --replace`,
    )
    expect(text).toContain("security sync: not sent (the sync is disconnected)")
    expect(fake.pushes).toHaveLength(0)
  })

  it("sends nothing after a lost refresh answer, and says so (oauth.test.ts: the next try ends or continues it)", async () => {
    // The access token runs out during a long collection; the refresh's answer is lost.
    fake.expireAccessTokens()
    fake.dropNextRefresh = true
    const lost = deps()
    expect(await runSync(run, lost.deps)).toBe(1)
    expect(lost.output()).toContain("t3 sync: not sent: unreachable")
    expect(fake.pushes).toHaveLength(0)
  })

  it("still sends security when the T3 CLI is not configured", async () => {
    const { deps: d, output } = deps({}, { T3CODE_CLI_PATH: "" })
    expect(await runSync(run, d)).toBe(0)
    expect(fake.pushes.map((p) => p.path)).toEqual(["/api/v1/sync/security"])
    expect(output()).toContain("t3 sync: not sent (no threads could be read)")
  })

  it("exits non-zero without a readable projects file", async () => {
    const { deps: d, output } = deps()
    expect(await runSync({ ...run, projectsFile: join(tempDir(), "missing.json") }, d)).toBe(1)
    expect(output()).toContain("t3: cannot read the projects file: ENOENT")
    expect(fake.pushes).toHaveLength(0)
  })

  it("refuses to run without Adiutor's address, or with one that is not a plain origin", async () => {
    for (const url of ["", "https://adiutor.example.com/app", "http://adiutor.example.com"]) {
      const { deps: d, output } = deps({}, { ADIUTOR_URL: url })
      expect(await runSync(run, d)).toBe(2)
      expect(output()).toContain("ADIUTOR_URL")
    }
  })
})

describe("the old agent key", () => {
  it("is reported once and never printed or sent, from the environment or the env file", async () => {
    const old = `adt_${randomBytes(32).toString("hex")}`
    const envFile = join(tempDir(), "sync.env")
    writeFileSync(envFile, `ADIUTOR_URL=${fake.issuer}\nADIUTOR_AGENT_TOKEN=${old}\n`)
    const { deps: d, output } = deps({}, { ADIUTOR_URL: "" })
    expect(await runSync({ ...run, envFile }, d)).toBe(0)
    expect(output()).toContain("ADIUTOR_AGENT_TOKEN, the sync's old agent key, is set but no longer used")
    expect(output()).not.toContain(old)
    expect(fake.pushes.every((p) => !p.auth?.includes(old))).toBe(true)
  })

  it("is never printed when the env file is broken, and never accepted on the command line", async () => {
    const old = `adt_${randomBytes(32).toString("hex")}`
    const envFile = join(tempDir(), "sync.env")
    writeFileSync(envFile, `ADIUTOR_URL=${fake.issuer}\n${old}\n`)
    const bad = deps()
    expect(await runSync({ ...run, envFile }, bad.deps)).toBe(2)
    expect(bad.output()).toContain("env file line 2 is not KEY=VALUE")
    expect(bad.output()).not.toContain(old)
    const { deps: d, output } = deps()
    expect(await main(["run", "--projects", projectsFile, "--token", old], d)).toBe(2)
    expect(output()).toContain("unknown or incomplete option")
    expect(output()).not.toContain(old)
  })

  it("is not needed to reach Adiutor: an address that does not answer is not sent to", async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const { deps: d, output } = deps({}, { ADIUTOR_URL: `http://127.0.0.1:${port}` })
    expect(await runSync(run, d)).toBe(1)
    // No connection is kept for that address.
    expect(output()).toContain("t3 sync: not sent: not_connected")
  })
})

describe("main", () => {
  it("prints the usage for help and refuses an incomplete command", async () => {
    const help = deps()
    expect(await main(["--help"], help.deps)).toBe(0)
    expect(help.output()).toContain("Usage: node adiutor-sync.js run --projects <file>")
    expect(await main(["run"], deps().deps)).toBe(2)
    expect(await main(["push", "--projects", projectsFile], deps().deps)).toBe(2)
  })

  it("runs a dry run from the command line", async () => {
    const { deps: d, output } = deps()
    expect(
      await main(["run", "--projects", projectsFile, "--overview", overviewDir, "--no-collect", "--dry-run"], d),
    ).toBe(0)
    expect(output()).toContain("dry run: nothing is sent")
    expect(fake.pushes).toHaveLength(0)
  })
})
