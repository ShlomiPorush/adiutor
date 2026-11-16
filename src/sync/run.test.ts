import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { MainDeps } from "./cli.ts"
import { main } from "./cli.ts"
import type { Result, RunReport } from "./contract.ts"
import type { Runner } from "./exec.ts"
import { type FakeAdiutor, startFakeAdiutor } from "./fake-adiutor.ts"
import { type FakeT3, startFakeT3 } from "./fake-t3.ts"
import { syncClient } from "./oauth.ts"
import { partOf } from "./run.ts"
import { t3Session } from "./t3-session.ts"

// One run end to end: a stand-in Adiutor (src/sync/fake-adiutor.ts) and a stand-in T3 (src/sync/fake-t3.ts), the sync
// connected to both in a home folder of its own before each test. Every token is new on every run.

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const overviewDir = join(fixtures, "overview")
const allProjects = JSON.parse(readFileSync(join(fixtures, "t3-projects.json"), "utf8"))
const NODE = "/fake/node"
const CLI = "/fake/t3"

let fake: FakeAdiutor
let t3: FakeT3
let home: string
const temps: string[] = []

beforeAll(async () => {
  fake = await startFakeAdiutor()
  t3 = await startFakeT3({ cliPath: CLI, projects: allProjects, threadsDir: join(fixtures, "threads") })
})
afterAll(async () => {
  await fake.close()
  await t3.close()
})
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
  await t3Session({
    ...clientDeps,
    runner: t3.runner,
    sleep: async () => {},
    cliPath: CLI,
    origin: t3.origin,
    processCreation: t3.processCreation,
  }).connect()
  t3.calls.length = 0
})
afterEach(() => {
  fake.pushes.length = 0
  Object.assign(fake, { beforePush: [], afterPush: [], pushOutcome: [], dropNextRefresh: false, listingStatus: 0 })
  Object.assign(t3, {
    projects: allProjects,
    projectsAnswer: [],
    descriptorAnswer: [],
    cliEnvironmentId: "",
    issue: [],
  })
  t3.sessions.length = 0
  t3.calls.length = 0
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "adiutor-sync-"))
  temps.push(dir)
  return dir
}

const data = () => join(home, ".config", "adiutor")

/** The collector fails or succeeds (or waits for a gate); the T3 CLI is the stand-in T3's. */
function runner(options: { collectorFails?: boolean; gate?: Promise<void> } = {}) {
  const calls: Array<{ command: string; args: string[] }> = []
  const run: Runner = async (command, args, opts) => {
    calls.push({ command, args })
    if (command === NODE) {
      await options.gate
      return options.collectorFails
        ? { code: 1, stdout: "", stderr: "Error: Another run is in progress (data/run.lock).\n", error: "exit code 1" }
        : { code: 0, stdout: '{"runId":"20261101T060000Z"}\n', stderr: "" }
    }
    return t3.runner(command, args, opts)
  }
  return { run, calls }
}

function deps(overrides: Partial<MainDeps> = {}, env: Record<string, string> = {}) {
  const lines: string[] = []
  const value: MainDeps = {
    env: {
      ADIUTOR_URL: fake.issuer,
      T3CODE_CLI_PATH: CLI,
      ADIUTOR_T3_URL: t3.origin,
      ADIUTOR_OVERVIEW_DIR: overviewDir,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      ...env,
    },
    platform: "linux",
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    runner: runner().run,
    fetch: (input, init) => fetch(input, init),
    out: (line) => lines.push(line),
    now: () => new Date(),
    nodePath: NODE,
    processCreation: t3.processCreation,
    ...overrides,
  }
  return { deps: value, lines, output: () => lines.join("\n") }
}

/** Runs a command with --json: every line must be JSON, events first, exactly one result last. */
async function json(argv: string[], d: MainDeps, lines: string[]) {
  const start = lines.length
  const exit = await main([...argv, "--json"], d)
  const parsed = lines.slice(start).map((line) => JSON.parse(line) as { type: string })
  const results = parsed.filter((p) => p.type === "result")
  expect(results).toHaveLength(1)
  expect(parsed.at(-1)?.type).toBe("result")
  for (const p of parsed.slice(0, -1)) expect(p.type).toBe("event")
  return { exit, events: parsed.slice(0, -1), result: parsed.at(-1) as Result & Record<string, unknown> }
}

const reportOf = (result: Result) => (result as { report?: RunReport }).report as RunReport

/** Every secret of both stand-ins: none may show up in output or in a file outside the connection folder. */
const secrets = () => [...fake.secrets(), ...t3.tokens()]

function filesOutsideConnection(): string[] {
  const texts: string[] = []
  for (const name of readdirSync(data())) {
    if (name === "connection") continue
    texts.push(readFileSync(join(data(), name), "utf8"))
  }
  return texts
}

const two = { projects: allProjects.projects.slice(0, 2) }

describe("run", () => {
  it("runs the collector, reads T3's projects with the session and every project's threads, and sends both", async () => {
    const cli = runner({ collectorFails: true })
    const { deps: d, output } = deps({ runner: cli.run })
    expect(await main(["run"], d)).toBe(0)

    expect(cli.calls[0]).toEqual({ command: NODE, args: ["src/cli.mjs", "collect"] })
    const threadCalls = cli.calls.filter((c) => c.args[0] === "thread")
    expect(threadCalls.map((c) => c.args[3]).sort()).toEqual([
      "mcp:p-gadget",
      "p-gizmo",
      "p-missing",
      "p-notes",
      "p-widget",
    ])
    expect(fake.pushes.map((p) => [p.path, p.policy, p.kind])).toEqual([
      ["/api/v1/sync/t3", fake.revision, "act"],
      ["/api/v1/sync/security", fake.revision, "act"],
    ])
    const body = fake.pushes[0]?.body as {
      projects: unknown[]
      threads: Array<{ threadId: string }>
      failedProjects: string[]
    }
    expect(body.projects).toEqual([
      { t3ProjectId: "p-widget", title: "Widget", repo: "acme/widget" },
      { t3ProjectId: "mcp:p-gadget", title: "Gadget", repo: "acme/gadget" },
      { t3ProjectId: "p-gizmo", title: "Gizmo", repo: "acme/gizmo" },
      { t3ProjectId: "p-notes", title: "Notes" },
      { t3ProjectId: "p-missing", title: "Missing", repo: "acme/missing" },
    ])
    expect(body.threads.map((t) => t.threadId)).toEqual([
      "thread-w1",
      "thread-w2",
      "thread-w3",
      "thread-g1",
      "thread-z1",
    ])
    // The server must not take the missing threads of an unread or partly read project as a complete picture.
    expect(body.failedProjects).toEqual(["p-gizmo", "p-notes"])
    const security = fake.pushes[1]?.body as { repos: Array<{ repo: string }> }
    expect(security.repos.map((r) => r.repo)).toEqual(["acme/widget", "acme/gadget", "acme/gizmo"])

    const text = output()
    expect(text).toContain(
      "overview: the collector failed (exit code 1: Error: Another run is in progress (data/run.lock).)",
    )
    expect(text).toContain("t3: 5 projects (3 skipped: deleted or unusable ids)")
    expect(text).toContain(
      "t3: threads of project p-notes not read: exit code 1: No T3 Code project matches 'p-notes'.",
    )
    expect(text).toContain("t3: 5 threads (1 child threads), 1 records skipped, 1 of 5 projects not read")
    expect(text).toContain('t3 sync: sent (HTTP 200) {"data":{"outcome":"succeeded","counts":{}}}')
    for (const secret of secrets()) expect(text).not.toContain(secret)

    // The status file keeps the report; projects that were not read make the T3 part partial.
    const status = JSON.parse(readFileSync(join(data(), "status.json"), "utf8"))
    expect(status.lastRun.t3).toMatchObject({
      result: "partial",
      reason: "projects_missing",
      projectsFrom: "t3",
      projects: 5,
      threads: 5,
      failedProjects: 2,
    })
    expect(status.lastRun.security).toMatchObject({ result: "accepted", repos: 3, snapshotRunId: "20261101T060000Z" })
    expect(status.lastGoodSyncAt).toBeNull()
    for (const text of filesOutsideConnection()) for (const secret of secrets()) expect(text).not.toContain(secret)
  })

  it("a good sync is both parts accepted in the same run; a later bad run keeps its time", async () => {
    t3.projects = two
    const { deps: d, lines } = deps()
    const good = await json(["run"], d, lines)
    const report = reportOf(good.result)
    expect([report.t3.result, report.security.result]).toEqual(["accepted", "accepted"])
    expect(report.lastGoodSyncAt).toBe(report.finishedAt)
    fake.pushOutcome.push("partial")
    const next = reportOf((await json(["run"], d, lines)).result)
    expect(next.t3).toMatchObject({ result: "partial", reason: "server_partial" })
    expect(next.lastGoodSyncAt).toBe(report.finishedAt)
    const status = await json(["status"], d, lines)
    expect(status.result).toMatchObject({ lastGoodSyncAt: report.finishedAt, lastRun: { t3: { result: "partial" } } })
  })

  it("maps a refused push and a run the server failed to failed", async () => {
    t3.projects = two
    fake.beforePush.push("policy_changed", "policy_changed")
    fake.pushOutcome.push("failed")
    const { deps: d, lines } = deps()
    const { exit, result } = await json(["run"], d, lines)
    expect(exit).toBe(1)
    const report = reportOf(result)
    expect(report.t3).toMatchObject({ result: "failed", reason: "policy_changed" })
    expect(report.security).toMatchObject({ result: "failed", reason: "server_failed", httpStatus: 200 })
  })

  it("a lost answer is outcome_unknown and never sent again; the next run sends again", async () => {
    fake.afterPush.push("drop", 500)
    const { deps: d, lines } = deps()
    const report = reportOf((await json(["run"], d, lines)).result)
    expect(report.t3.result).toBe("outcome_unknown")
    expect(report.security).toMatchObject({ result: "outcome_unknown", httpStatus: 500 })
    expect(fake.pushes.map((p) => p.path)).toEqual(["/api/v1/sync/t3", "/api/v1/sync/security"])
    await json(["run"], d, lines)
    expect(fake.pushes).toHaveLength(4)
  })

  it("uses the last good project list only when T3 cannot be reached, and says from when", async () => {
    t3.projects = two
    const first = deps()
    const saved = reportOf((await json(["run"], first.deps, first.lines)).result)
    t3.projectsAnswer.push("drop")
    const { deps: d, lines, output } = deps()
    const report = reportOf((await json(["run"], d, lines)).result)
    expect(report.t3).toMatchObject({ result: "accepted", projectsFrom: "last_good", projectsAt: saved.t3.projectsAt })
    expect(output()).toContain(`T3 projects from ${saved.t3.projectsAt}`)
    expect((fake.pushes.at(-2)?.body as { projects?: unknown[] } | undefined)?.projects).toHaveLength(2)
  })

  it("without a last good list, T3 is not read when it does not answer, and security has no repositories", async () => {
    t3.descriptorAnswer.push("drop")
    const { deps: d, lines } = deps()
    const report = reportOf((await json(["run"], d, lines)).result)
    expect(report.t3).toMatchObject({ result: "not_run", reason: "t3_unavailable", projectsFrom: null })
    expect(report.security).toMatchObject({ result: "not_run", reason: "no_projects" })
    expect(fake.pushes).toHaveLength(0)
  })

  it("a refused session (401) stops the T3 part, without the last good list or the CLI, until t3-connect", async () => {
    t3.projects = two
    const first = deps()
    await json(["run"], first.deps, first.lines)
    for (const s of t3.sessions) s.revoked = true
    t3.calls.length = 0
    const { deps: d, lines } = deps()
    const report = reportOf((await json(["run"], d, lines)).result)
    expect(report.t3).toMatchObject({ result: "not_run", reason: "t3_rejected", projectsFrom: null })
    expect(t3.calls.filter((c) => c.args[0] === "thread")).toHaveLength(0)
    expect(report.security.result).toBe("accepted")
    const status = await json(["status"], d, lines)
    expect(status.result).toMatchObject({ t3: { state: "ended", reason: "rejected" } })
    // Never issued again on its own.
    await json(["run"], d, lines)
    expect(t3.calls.filter((c) => c.args[2] === "issue")).toHaveLength(0)
    const connected = await json(["t3-connect"], d, lines)
    expect(connected.result).toMatchObject({ ok: true, environmentId: t3.environmentId })
    expect(reportOf((await json(["run"], d, lines)).result).t3.result).toBe("accepted")
  })

  it("threads whose links name another environment are an identity failure: nothing of T3 is sent", async () => {
    t3.projects = two
    const first = deps()
    await json(["run"], first.deps, first.lines)
    fake.pushes.length = 0
    t3.cliEnvironmentId = "another-environment"
    const { deps: d, lines } = deps()
    const report = reportOf((await json(["run"], d, lines)).result)
    expect(report.t3).toMatchObject({ result: "not_run", reason: "t3_other_environment" })
    expect(fake.pushes.map((p) => p.path)).toEqual(["/api/v1/sync/security"])
    const status = await json(["status"], d, lines)
    expect(status.result).toMatchObject({ t3: { state: "ended", reason: "other_environment" } })
  })

  it("one run at a time: a second run answers busy with the first one's start time", async () => {
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const first = deps({ runner: runner({ gate }).run })
    const running = main(["run", "--json"], first.deps)
    while (!existsSync(join(data(), "run.lock"))) await new Promise((resolve) => setTimeout(resolve, 2))
    const second = deps()
    const busy = await json(["run"], second.deps, second.lines)
    expect(busy.exit).toBe(1)
    expect(busy.result).toMatchObject({ command: "run", ok: false, busy: { startedAt: expect.any(String) } })
    const status = await json(["status"], second.deps, second.lines)
    expect(status.result).toMatchObject({ running: { startedAt: expect.any(String) } })
    open()
    expect(await running).toBe(0)
    expect(existsSync(join(data(), "run.lock"))).toBe(false)
    expect(fake.pushes).toHaveLength(2)
  })

  it("takes the run lock over from a run that died", async () => {
    mkdirSync(data(), { recursive: true })
    writeFileSync(
      join(data(), "run.lock"),
      JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), token: randomBytes(16).toString("hex"), startedAt: 1 }),
    )
    const { deps: d, lines } = deps()
    expect((await json(["run"], d, lines)).exit).toBe(0)
  })

  it("says the sync is disconnected, and how to reconnect, when Adiutor ended the connection", async () => {
    fake.endAllGrants()
    const { deps: d, output } = deps()
    expect(await main(["run"], d)).toBe(1)
    const text = output()
    expect(text).toContain("t3 sync: not sent: connection_ended")
    expect(text).toContain(
      `The sync is disconnected from Adiutor; reconnect it: node adiutor-sync.js connect --name "<name>" --url "${fake.issuer}" --replace`,
    )
    expect(text).toContain("security sync: not sent (the sync is disconnected)")
    expect(fake.pushes).toHaveLength(0)
  })

  it("sends nothing in a dry run, needs no Adiutor settings, keeps no status, and prints ids only", async () => {
    const { deps: d, lines, output } = deps({}, { ADIUTOR_URL: "" })
    const { exit, result } = await json(["run", "--no-collect", "--dry-run"], d, lines)
    expect(exit).toBe(0)
    expect(reportOf(result)).toMatchObject({ dryRun: true, t3: { reason: "dry_run" }, security: { reason: "dry_run" } })
    expect(fake.pushes).toHaveLength(0)
    expect(existsSync(join(data(), "status.json"))).toBe(false)
    expect(output()).toContain("thread-w1")
    expect(output()).not.toContain("Add an export button")
  })

  it("reads the settings file in the data folder when nothing else sets a value", async () => {
    mkdirSync(data(), { recursive: true })
    writeFileSync(
      join(data(), "settings.json"),
      JSON.stringify({ adiutorUrl: fake.issuer, t3CliPath: CLI, t3Url: t3.origin, overviewDir }),
    )
    const { deps: d, lines } = deps(
      {},
      { ADIUTOR_URL: "", T3CODE_CLI_PATH: "", ADIUTOR_T3_URL: "", ADIUTOR_OVERVIEW_DIR: "" },
    )
    expect((await json(["run"], d, lines)).exit).toBe(0)
    expect(fake.pushes).toHaveLength(2)
  })

  it("refuses to run without Adiutor's address, or with one that is not a plain origin", async () => {
    for (const url of ["", "https://adiutor.example.com/app", "http://adiutor.example.com"]) {
      const { deps: d, lines } = deps({}, { ADIUTOR_URL: url })
      const { exit, result } = await json(["run"], d, lines)
      expect(exit).toBe(2)
      expect(result).toMatchObject({ ok: false, error: { code: "usage" } })
    }
  })

  it("no longer takes a projects file", async () => {
    const { deps: d, lines } = deps()
    const { exit, result } = await json(["run", "--projects", "x.json"], d, lines)
    expect(exit).toBe(2)
    expect(result).toMatchObject({ command: null, ok: false, error: { code: "usage" } })
  })
})

describe("partOf", () => {
  it("maps each answer of a push to a part's result", () => {
    const answer = (status: number, body: unknown) => ({ kind: "answer" as const, status, body })
    expect(partOf(answer(200, { data: { outcome: "succeeded" } }), false).result).toBe("accepted")
    expect(partOf(answer(200, { data: { outcome: "succeeded" } }), true)).toMatchObject({ result: "partial" })
    expect(partOf(answer(200, { data: { outcome: "partial" } }), false).result).toBe("partial")
    expect(partOf(answer(200, { data: { outcome: "failed" } }), false).result).toBe("failed")
    expect(partOf(answer(200, "not json"), false).result).toBe("outcome_unknown")
    expect(partOf(answer(400, { error: "validation_failed" }), false)).toMatchObject({
      result: "failed",
      reason: "validation_failed",
    })
    expect(partOf({ kind: "outcome_unknown" }, false).result).toBe("outcome_unknown")
    expect(partOf({ kind: "failed", code: "not_connected", message: "m" }, false)).toMatchObject({
      result: "failed",
      reason: "not_connected",
    })
  })
})

describe("the machine-readable output", () => {
  it("answers every command with JSON lines and one result, and never a token", async () => {
    const { deps: d, lines } = deps()
    const status = await json(["status"], d, lines)
    expect(status.result).toMatchObject({
      command: "status",
      ok: true,
      v: 1,
      adiutor: { state: "connected", url: fake.issuer, label: "Test sync", scope: "sync", revocationPending: false },
      t3: { state: "connected", environmentId: t3.environmentId, revocationPending: false },
      lastRun: null,
      running: null,
      paused: null,
      settings: { problems: [] },
    })
    expect((await json(["run"], d, lines)).result).toMatchObject({ command: "run", ok: true })
    expect((await json(["t3-disconnect"], d, lines)).result).toMatchObject({
      command: "t3-disconnect",
      ok: true,
      wasConnected: true,
      revocationPending: false,
    })
    expect((await json(["t3-connect"], d, lines)).result).toMatchObject({ command: "t3-connect", ok: true })
    expect((await json(["disconnect"], d, lines)).result).toMatchObject({
      command: "disconnect",
      ok: true,
      wasConnected: true,
      revocationPending: false,
    })
    expect((await json(["status"], d, lines)).result).toMatchObject({ adiutor: { state: "not_connected" } })
    expect((await json(["nonsense"], d, lines)).result).toMatchObject({ command: null, ok: false })
    expect((await json(["run", "--bogus"], d, lines)).result).toMatchObject({ command: null, ok: false })
    expect((await json(["setup-mcp", "--for", "claude"], d, lines)).result).toMatchObject({ ok: false })
    const all = lines.join("\n")
    for (const secret of secrets()) expect(all).not.toContain(secret)
  })

  it("connect --json gives the link and the code as an event, then the result", async () => {
    const { deps: d, lines } = deps({
      sleep: async () => {
        fake.approve()
        await new Promise((resolve) => setTimeout(resolve, 1))
      },
    })
    const envFile = join(tempDir(), "sync.env")
    const { exit, events, result } = await json(
      ["connect", "--name", "Tray sync", "--env", envFile, "--replace", "--no-open"],
      d,
      lines,
    )
    expect(exit).toBe(0)
    const approval = events.find((e) => (e as { event?: string }).event === "approval") as unknown as {
      link: string
      userCode: string
    }
    expect(approval.link.startsWith(`${fake.issuer}/`)).toBe(true)
    expect(approval.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(result).toMatchObject({ command: "connect", ok: true, state: "connected", scope: "sync" })
    for (const secret of secrets()) expect(lines.join("\n")).not.toContain(secret)
  })

  it("an unexpected failure still ends in one result", async () => {
    const { deps: d, lines } = deps({
      fetch: () => {
        throw new TypeError("boom")
      },
      runner: async () => {
        throw new Error("boom")
      },
    })
    const { result } = await json(["t3-connect"], d, lines)
    expect(result).toMatchObject({ command: "t3-connect", ok: false })
  })
})

describe("the old agent key", () => {
  it("is reported once and never printed or sent, from the environment or the env file", async () => {
    const old = `adt_${randomBytes(32).toString("hex")}`
    const envFile = join(tempDir(), "sync.env")
    writeFileSync(envFile, `ADIUTOR_URL=${fake.issuer}\nADIUTOR_AGENT_TOKEN=${old}\n`)
    const { deps: d, output } = deps({}, { ADIUTOR_URL: "" })
    expect(await main(["run", "--env", envFile], d)).toBe(0)
    expect(output()).toContain("ADIUTOR_AGENT_TOKEN, the sync's old agent key, is set but no longer used")
    expect(output()).not.toContain(old)
    expect(fake.pushes.every((p) => !p.auth?.includes(old))).toBe(true)
  })

  it("is never printed when the env file is broken, and never accepted on the command line", async () => {
    const old = `adt_${randomBytes(32).toString("hex")}`
    const envFile = join(tempDir(), "sync.env")
    writeFileSync(envFile, `ADIUTOR_URL=${fake.issuer}\n${old}\n`)
    const bad = deps()
    expect(await main(["run", "--env", envFile], bad.deps)).toBe(2)
    expect(bad.output()).toContain("env file line 2 is not KEY=VALUE")
    expect(bad.output()).not.toContain(old)
    const { deps: d, output } = deps()
    expect(await main(["run", "--token", old], d)).toBe(2)
    expect(output()).toContain("unknown or incomplete option")
    expect(output()).not.toContain(old)
  })

  it("is not needed to reach Adiutor: an address that does not answer is not sent to", async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const { deps: d, output } = deps({}, { ADIUTOR_URL: `http://127.0.0.1:${port}` })
    expect(await main(["run"], d)).toBe(1)
    // No connection is kept for that address.
    expect(output()).toContain("t3 sync: not sent: not_connected")
  })
})

describe("main", () => {
  it("prints the usage for help and refuses an incomplete command", async () => {
    const help = deps()
    expect(await main(["--help"], help.deps)).toBe(0)
    expect(help.output()).toContain("Usage: node adiutor-sync.js run [--env <file>]")
    expect(await main(["push"], deps().deps)).toBe(2)
    expect(await main(["run", "extra"], deps().deps)).toBe(2)
  })
})
