import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { MainDeps } from "./cli.ts"
import { main } from "./cli.ts"
import type { Result, RunReport, StatusBody } from "./contract.ts"
import type { Runner } from "./exec.ts"
import { type FakeAdiutor, startFakeAdiutor } from "./fake-adiutor.ts"
import { type FakeT3, startFakeT3 } from "./fake-t3.ts"
import { syncClient } from "./oauth.ts"
import { partOf } from "./run.ts"
import { t3Session } from "./t3-session.ts"

// One run end to end: a stand-in Adiutor (src/sync/fake-adiutor.ts) and a stand-in T3 (src/sync/fake-t3.ts), the sync
// connected to both in a home folder of its own before each test. Every token is new on every run.

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const allProjects = JSON.parse(readFileSync(join(fixtures, "t3-projects.json"), "utf8"))
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

/** The stand-in T3's CLI, its calls recorded; a thread listing waits for the gate when one is given. */
function runner(options: { gate?: Promise<void> } = {}) {
  const calls: Array<{ command: string; args: string[] }> = []
  const run: Runner = async (command, args, opts) => {
    calls.push({ command, args })
    if (args[0] === "thread") await options.gate
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
  // A result that is not ok always says why.
  const last = parsed.at(-1) as { ok?: boolean; error?: { code?: string; message?: string } }
  if (last.ok === false) expect(last.error).toEqual({ code: expect.any(String), message: expect.any(String) })
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
  it("reads T3's projects with the session and every project's threads, and sends them; security is not its part", async () => {
    const cli = runner()
    const { deps: d, output } = deps({ runner: cli.run })
    expect(await main(["run"], d)).toBe(0)

    const threadCalls = cli.calls.filter((c) => c.args[0] === "thread")
    expect(threadCalls.map((c) => c.args[3]).sort()).toEqual([
      "mcp:p-gadget",
      "p-gizmo",
      "p-missing",
      "p-notes",
      "p-widget",
    ])
    // The Adiutor server reads GitHub itself: the sync sends T3 alone.
    expect(fake.pushes.map((p) => [p.path, p.policy, p.kind])).toEqual([["/api/v1/sync/t3", fake.revision, "act"]])
    const body = fake.pushes[0]?.body as {
      projects: unknown[]
      threads: Array<{ threadId: string }>
      failedProjects: string[]
    }
    // A repository only from T3's GitHub identity: the others get theirs from the owner in Adiutor.
    expect(body.projects).toEqual([
      { t3ProjectId: "p-widget", title: "Widget", repo: "acme/widget" },
      { t3ProjectId: "mcp:p-gadget", title: "Gadget" },
      { t3ProjectId: "p-gizmo", title: "Gizmo" },
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

    const text = output()
    expect(text).not.toContain("overview")
    expect(text).not.toContain("security")
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
    expect(status.lastRun).not.toHaveProperty("security")
    expect(status.lastGoodSyncAt).toBeNull()
    for (const text of filesOutsideConnection()) for (const secret of secrets()) expect(text).not.toContain(secret)
  })

  it("a good sync is a run with T3 accepted; a later bad run keeps its time", async () => {
    t3.projects = two
    const { deps: d, lines } = deps()
    const good = await json(["run"], d, lines)
    const report = reportOf(good.result)
    expect(report.t3.result).toBe("accepted")
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
    const { deps: d, lines } = deps()
    const { exit, result } = await json(["run"], d, lines)
    expect(exit).toBe(1)
    expect(reportOf(result).t3).toMatchObject({ result: "failed", reason: "policy_changed" })
    fake.pushOutcome.push("failed")
    const next = reportOf((await json(["run"], d, lines)).result)
    expect(next.t3).toMatchObject({ result: "failed", reason: "server_failed", httpStatus: 200 })
  })

  it("a lost answer is outcome_unknown and never sent again; the next run sends again", async () => {
    fake.afterPush.push("drop", 500)
    const { deps: d, lines } = deps()
    expect(reportOf((await json(["run"], d, lines)).result).t3.result).toBe("outcome_unknown")
    expect(fake.pushes.map((p) => p.path)).toEqual(["/api/v1/sync/t3"])
    // A server error is no clear answer either; the next run sends the whole state again.
    const next = reportOf((await json(["run"], d, lines)).result)
    expect(next.t3).toMatchObject({ result: "outcome_unknown", httpStatus: 500 })
    expect(fake.pushes).toHaveLength(2)
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
    expect((fake.pushes.at(-1)?.body as { projects?: unknown[] } | undefined)?.projects).toHaveLength(2)
  })

  it("without a last good list, T3 is not read when it does not answer", async () => {
    t3.descriptorAnswer.push("drop")
    const { deps: d, lines } = deps()
    const report = reportOf((await json(["run"], d, lines)).result)
    expect(report.t3).toMatchObject({ result: "not_run", reason: "t3_unavailable", projectsFrom: null })
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
    expect(fake.pushes).toHaveLength(1)
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
    expect(fake.pushes).toHaveLength(0)
    const status = await json(["status"], d, lines)
    expect(status.result).toMatchObject({ t3: { state: "ended", reason: "other_environment" } })
  })

  it("an identity failure ends only the session the run read with, not one t3-connect saved meanwhile", async () => {
    t3.projects = two
    let reconnected = false
    const run: Runner = async (command, args, opts) => {
      if (args[0] === "thread" && !reconnected) {
        reconnected = true
        // The owner connects T3 again while this run reads threads; then the CLI names another environment.
        await t3Session({
          runner: t3.runner,
          fetch: (input, init) => fetch(input, init),
          platform: "linux",
          env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
          now: () => Date.now(),
          sleep: async () => {},
          systemCommand: async () => undefined,
          cliPath: CLI,
          origin: t3.origin,
          processCreation: t3.processCreation,
        }).connect()
        t3.cliEnvironmentId = "another-environment"
      }
      return runner().run(command, args, opts)
    }
    const { deps: d, lines } = deps({ runner: run })
    const report = reportOf((await json(["run"], d, lines)).result)
    expect(report.t3).toMatchObject({ result: "not_run", reason: "t3_other_environment" })
    t3.cliEnvironmentId = ""
    const status = await json(["status"], d, lines)
    expect(status.result).toMatchObject({ t3: { state: "connected" } })
  })

  it("a project whose threads' environment cannot be checked is not read, and none of its threads is sent", async () => {
    t3.projects = two
    // p-widget's threads come without a link.
    const run: Runner = async (command, args, opts) => {
      const result = await runner().run(command, args, opts)
      const noLinks = result.stdout.replace(/^\s*"link": "[^"]*",\r?\n/gm, "")
      return args[3] === "p-widget" ? { ...result, stdout: noLinks } : result
    }
    const { deps: d, lines } = deps({ runner: run })
    const report = reportOf((await json(["run"], d, lines)).result)
    const body = fake.pushes[0]?.body as { threads: Array<{ threadId: string }>; failedProjects: string[] }
    expect(body.threads.map((t) => t.threadId)).toEqual(["thread-g1"])
    expect(body.failedProjects).toEqual(["p-widget"])
    expect(report.t3).toMatchObject({ result: "partial", reason: "projects_missing", failedProjects: 1 })
  })

  it("a 401 whose body broke off stops the T3 part, without the last good list or the CLI", async () => {
    t3.projects = two
    const first = deps()
    await json(["run"], first.deps, first.lines)
    t3.calls.length = 0
    t3.projectsAnswer.push({ status: 401, cut: true })
    const { deps: d, lines } = deps()
    const report = reportOf((await json(["run"], d, lines)).result)
    expect(report.t3).toMatchObject({ result: "not_run", reason: "t3_rejected", projectsFrom: null })
    expect(t3.calls.filter((c) => c.args[0] === "thread")).toHaveLength(0)
  })

  it("hold-run keeps the run lock until its stdin ends: a run meanwhile answers busy", async () => {
    let end = () => {}
    const stdinEnds = new Promise<string>((resolve) => {
      end = () => resolve("")
    })
    const holder = deps({ stdin: () => stdinEnds })
    const holding = json(["hold-run"], holder.deps, holder.lines)
    for (let i = 0; i < 200 && !holder.lines.some((l) => l.includes('"held"')); i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(holder.lines.map((l) => JSON.parse(l))).toContainEqual({ type: "event", event: "held" })
    const second = deps()
    const busy = await json(["run"], second.deps, second.lines)
    expect(busy.result).toMatchObject({ command: "run", ok: false, error: { code: "busy" } })
    const twice = await json(["hold-run"], second.deps, second.lines)
    expect(twice.result).toMatchObject({ command: "hold-run", ok: false, busy: { startedAt: expect.any(String) } })
    end()
    const held = await holding
    expect(held.exit).toBe(0)
    expect(held.result).toMatchObject({ command: "hold-run", ok: true })
    // Released: a run goes again.
    expect((await json(["run", "--dry-run"], second.deps, second.lines)).result).not.toHaveProperty("busy")
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
    expect(busy.result).toMatchObject({
      command: "run",
      ok: false,
      busy: { startedAt: expect.any(String) },
      error: { code: "busy" },
    })
    const status = await json(["status"], second.deps, second.lines)
    expect(status.result).toMatchObject({ running: { startedAt: expect.any(String) } })
    open()
    expect(await running).toBe(0)
    expect(existsSync(join(data(), "run.lock"))).toBe(false)
    expect(fake.pushes).toHaveLength(1)
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
    expect(fake.pushes).toHaveLength(0)
  })

  it("sends nothing in a dry run, needs no Adiutor settings, keeps no status, and prints ids only", async () => {
    const { deps: d, lines, output } = deps({}, { ADIUTOR_URL: "" })
    const { exit, result } = await json(["run", "--dry-run"], d, lines)
    expect(exit).toBe(0)
    expect(reportOf(result)).toMatchObject({ dryRun: true, t3: { reason: "dry_run" } })
    expect(fake.pushes).toHaveLength(0)
    expect(existsSync(join(data(), "status.json"))).toBe(false)
    expect(output()).toContain("thread-w1")
    expect(output()).not.toContain("Add an export button")
  })

  it("reads the settings file in the data folder when nothing else sets a value, and ignores an old overview folder", async () => {
    mkdirSync(data(), { recursive: true })
    writeFileSync(
      join(data(), "settings.json"),
      JSON.stringify({ adiutorUrl: fake.issuer, t3CliPath: CLI, t3Url: t3.origin, overviewDir: tempDir() }),
    )
    const { deps: d, lines } = deps({}, { ADIUTOR_URL: "", T3CODE_CLI_PATH: "", ADIUTOR_T3_URL: "" })
    const { exit, result } = await json(["run"], d, lines)
    expect(exit).toBe(0)
    expect(result).toMatchObject({ ok: true })
    expect(fake.pushes.map((p) => p.path)).toEqual(["/api/v1/sync/t3"])
  })

  it("counts the last good sync by T3 alone, also from a status an older engine wrote", async () => {
    mkdirSync(data(), { recursive: true })
    const older = {
      v: 1,
      lastGoodSyncAt: "2026-11-10T06:00:00.000Z",
      lastRun: {
        startedAt: "2026-11-12T05:59:00.000Z",
        finishedAt: "2026-11-12T06:00:00.000Z",
        dryRun: false,
        requestId: null,
        t3: { result: "accepted", projectsFrom: "t3", projectsAt: null, projects: 2, threads: 3, failedProjects: 0 },
        security: { result: "failed", reason: "no_overview" },
        lastGoodSyncAt: "2026-11-10T06:00:00.000Z",
      },
    }
    writeFileSync(join(data(), "status.json"), JSON.stringify(older))
    const { deps: d, lines } = deps()
    const status = await json(["status"], d, lines)
    expect(status.result).toMatchObject({
      lastGoodSyncAt: "2026-11-12T06:00:00.000Z",
      lastRun: { lastGoodSyncAt: "2026-11-12T06:00:00.000Z" },
    })
    expect(status.result.lastRun).not.toHaveProperty("security")
  })

  it("refuses to run without Adiutor's address, or with one that is not a plain origin", async () => {
    for (const url of ["", "https://adiutor.example.com/app", "http://adiutor.example.com"]) {
      const { deps: d, lines } = deps({}, { ADIUTOR_URL: url })
      const { exit, result } = await json(["run"], d, lines)
      expect(exit).toBe(2)
      expect(result).toMatchObject({ ok: false, error: { code: "usage" } })
    }
  })

  it("no longer takes a projects file, an overview folder or --no-collect", async () => {
    for (const args of [["--projects", "x.json"], ["--overview", "x"], ["--no-collect"]]) {
      const { deps: d, lines } = deps()
      const { exit, result } = await json(["run", ...args], d, lines)
      expect(exit).toBe(2)
      expect(result).toMatchObject({ command: null, ok: false, error: { code: "usage" } })
    }
  })
})

describe("a run for a request from Adiutor", () => {
  /** connect --replace in this home folder, the owner approving at once. */
  async function reconnect() {
    const client = syncClient(fake.issuer, {
      fetch: (input: string, init: RequestInit) => fetch(input, init),
      runner: (async () => ({ code: 1, stdout: "", stderr: "" })) as Runner,
      systemCommand: async () => undefined,
      platform: "linux",
      env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
      now: () => Date.now(),
      sleep: async () => {
        fake.approve()
        await new Promise((resolve) => setTimeout(resolve, 1))
      },
    })
    await client.waitForApproval(await client.deviceCode("Test sync"), "Test sync")
  }

  afterEach(() => {
    Object.assign(fake, { claim: null, checkins: [] })
  })

  it("sends nothing more when the sync connected again during the run, and ends with connection_changed", async () => {
    const requestId = randomUUID()
    fake.claim = requestId
    const report = { version: "0.3.0", paused: false, pausedUntil: null, nextRunAt: null, running: null, finished: [] }
    const checkin = deps({ stdin: async () => JSON.stringify(report) })
    expect((await json(["checkin"], checkin.deps, checkin.lines)).result.ok).toBe(true)
    fake.claim = null
    // The connection is replaced while the threads are read.
    let replaced = false
    const run: Runner = async (command, args, opts) => {
      if (args[0] === "thread" && !replaced) {
        replaced = true
        await reconnect()
      }
      return t3.runner(command, args, opts)
    }
    const d = deps({ runner: run })
    const { result } = await json(["run", "--request", requestId], d.deps, d.lines)
    expect([result.ok, (result.error as { code: string }).code]).toEqual([false, "connection_changed"])
    const report_ = reportOf(result)
    expect([report_.requestId, report_.t3.reason]).toEqual([requestId, "connection_changed"])
    expect(fake.pushes).toHaveLength(0)
  })
})

describe("partOf", () => {
  it("maps each answer of a push to a part's result", () => {
    const answer = (status: number, body: unknown) => ({ kind: "answer" as const, status, body })
    expect(partOf(answer(200, { data: { outcome: "succeeded" } }), undefined).result).toBe("accepted")
    expect(partOf(answer(200, { data: { outcome: "succeeded" } }), "projects_missing")).toMatchObject({
      result: "partial",
    })
    expect(partOf(answer(200, { data: { outcome: "partial" } }), undefined).result).toBe("partial")
    expect(partOf(answer(200, { data: { outcome: "failed" } }), undefined).result).toBe("failed")
    expect(partOf(answer(200, "not json"), undefined).result).toBe("outcome_unknown")
    expect(partOf(answer(400, { error: "validation_failed" }), undefined)).toMatchObject({
      result: "failed",
      reason: "validation_failed",
    })
    expect(partOf({ kind: "outcome_unknown" }, undefined).result).toBe("outcome_unknown")
    expect(partOf({ kind: "failed", code: "not_connected", message: "m" }, undefined)).toMatchObject({
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
      v: 2,
      adiutor: { state: "connected", url: fake.issuer, label: "Test sync", scope: "sync", revocationPending: false },
      t3: { state: "connected", environmentId: t3.environmentId, revocationPending: false },
      lastRun: null,
      running: null,
      paused: null,
      settings: { problems: [] },
    })
    // Each setting as the engine uses it, with its source, for the tray to show.
    const values = (status.result.settings as StatusBody["settings"]).values
    expect(values.adiutorUrl).toMatchObject({ value: fake.issuer })
    expect(Object.keys(values).sort()).toEqual(["adiutorUrl", "t3CliPath", "t3Url"])
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
