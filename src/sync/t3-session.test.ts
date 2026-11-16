import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type FakeT3, startFakeT3 } from "./fake-t3.ts"
import { type CheckpointStep, PENDING_FILE, SESSION_FILE, type T3SessionDeps, t3Session } from "./t3-session.ts"

// The sync's T3 session (plan, "T3 session lifecycle") against a stand-in T3 (src/sync/fake-t3.ts): issued under a
// pending record, checked against T3's environment, renewed, ended on a refusal, and revoked; a command cut off at any
// step leaves records the next command recovers from, never an unknown live session and never a revoked saved one.

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const CLI = "/fake/t3"
let fake: FakeT3
const temps: string[] = []

beforeAll(async () => {
  fake = await startFakeT3({
    cliPath: CLI,
    projects: JSON.parse(readFileSync(join(fixtures, "t3-projects.json"), "utf8")),
    threadsDir: join(fixtures, "threads"),
  })
})
afterAll(() => fake.close())
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
  Object.assign(fake, {
    issue: [],
    revokeFailures: 0,
    listFailures: 0,
    projectsAnswer: [],
    descriptorAnswer: [],
    cliEnvironmentId: "",
    httpEnvironmentId: "",
  })
  fake.sessions.length = 0
  fake.calls.length = 0
  fake.running.clear()
})

/** A computer user of its own; `clock.offset` moves the sync's clock (ms); `crashAt` stops a command at a step. */
function user() {
  const home = mkdtempSync(join(tmpdir(), "adiutor-sync-t3-"))
  temps.push(home)
  const clock = { offset: 0 }
  const control: { crashAt?: CheckpointStep } = {}
  const deps: T3SessionDeps = {
    runner: fake.runner,
    fetch: (input, init) => fetch(input, init),
    platform: "linux",
    // T3's data folder override is set, as inside a T3 agent: the CLI must never see it.
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), T3CODE_HOME: join(home, "other-t3") },
    now: () => Date.now() + clock.offset,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    systemCommand: async () => undefined,
    cliPath: CLI,
    origin: fake.origin,
    processCreation: fake.processCreation,
    checkpoint: (step) => {
      if (control.crashAt === step) {
        control.crashAt = undefined
        throw new Error(`crash at ${step}`)
      }
    },
  }
  const folder = join(home, ".config", "adiutor", "connection")
  const read = (name: string) => {
    try {
      return readFileSync(join(folder, name), "utf8")
    } catch {
      return null
    }
  }
  return { home, clock, control, deps, folder, read, session: () => t3Session(deps) }
}

const live = () => fake.live().map((s) => s.sessionId)
const issues = () => fake.calls.filter((c) => c.args[2] === "issue")

describe("t3-connect", () => {
  it("issues a read-only session for 30 days under a unique label and keeps it owner-only", async () => {
    const u = user()
    const session = await u.session().connect()
    expect(session.environmentId).toBe(fake.environmentId)
    const [call] = issues()
    expect(call?.args.slice(0, 8)).toEqual([
      "auth",
      "session",
      "issue",
      "--scope",
      "orchestration:read",
      "--ttl",
      "30d",
      "--label",
    ])
    expect(call?.args[8]).toMatch(/^Adiutor sync [0-9a-f]{16}$/)
    // Every T3 CLI call runs without T3's data folder override.
    for (const c of fake.calls) expect(c.env?.T3CODE_HOME).toBeUndefined()
    expect(live()).toEqual([session.sessionId])
    const saved = JSON.parse(u.read(SESSION_FILE) ?? "{}")
    expect(saved).toMatchObject({
      sessionId: session.sessionId,
      environmentId: fake.environmentId,
      origin: fake.origin,
      label: call?.args[8],
    })
    expect(statSync(join(u.folder, SESSION_FILE)).mode & 0o777).toBe(0o600)
    expect(statSync(u.folder).mode & 0o777).toBe(0o700)
    // The pending record is gone once the session is saved.
    expect(u.read(PENDING_FILE)).toBeNull()
    expect(await u.session().status()).toEqual({
      state: "connected",
      environmentId: fake.environmentId,
      expiresAt: session.expiresAt,
      revocationPending: false,
    })
  })

  it("replaces a session it had: the new one is saved before the old one is revoked", async () => {
    const u = user()
    const first = await u.session().connect()
    const second = await u.session().connect()
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(live()).toEqual([second.sessionId])
    expect(u.read(PENDING_FILE)).toBeNull()
  })

  it("refuses a CLI of another environment than T3's address, and revokes what it issued", async () => {
    fake.cliEnvironmentId = "another-environment"
    const u = user()
    await expect(u.session().connect()).rejects.toMatchObject({ code: "t3_other_environment" })
    expect(live()).toEqual([])
    expect(u.read(SESSION_FILE)).toBeNull()
    expect(u.read(PENDING_FILE)).toBeNull()
  })

  it("fails without a session when T3 does not answer, or the CLI cannot issue one", async () => {
    const u = user()
    fake.descriptorAnswer.push("drop")
    await expect(u.session().connect()).rejects.toMatchObject({ code: "t3_unavailable" })
    expect(issues()).toHaveLength(0)
    fake.issue.push("fail")
    await expect(u.session().connect()).rejects.toMatchObject({ code: "t3_cli_failed" })
    expect(u.read(SESSION_FILE)).toBeNull()
    expect(live()).toEqual([])
  })

  it("never holds the token in a message, the pending record or the status", async () => {
    const u = user()
    fake.issue.push("crash")
    await expect(u.session().connect()).rejects.toThrow()
    await u.session().connect()
    const [token, crashed] = [fake.sessions.at(-1)?.token ?? "", fake.sessions[0]?.token ?? ""]
    expect(u.read(PENDING_FILE) ?? "").not.toContain(crashed)
    expect(JSON.stringify(await u.session().status())).not.toContain(token)
    fake.revokeFailures = 9
    fake.listFailures = 9
    const failed = await u.session().disconnect()
    expect(JSON.stringify(failed)).not.toContain(token)
    for (const name of readdirSync(u.folder).filter((n) => n !== SESSION_FILE))
      for (const t of fake.tokens()) expect(readFileSync(join(u.folder, name), "utf8")).not.toContain(t)
  })
})

describe("a command cut off at each step of the lifecycle", () => {
  it("before the child started: the record without a child is dropped after two minutes", async () => {
    const u = user()
    u.control.crashAt = "pending written"
    await expect(u.session().connect()).rejects.toThrow("crash")
    expect(JSON.parse(u.read(PENDING_FILE) ?? "{}").issues).toHaveLength(1)
    expect(issues()).toHaveLength(0)
    // Within two minutes it may still be starting: kept.
    await u.session().disconnect()
    expect(JSON.parse(u.read(PENDING_FILE) ?? "{}").issues).toHaveLength(1)
    u.clock.offset = 3 * 60_000
    await u.session().disconnect()
    expect(u.read(PENDING_FILE)).toBeNull()
    expect(live()).toEqual([])
  })

  it("while the issuing child runs: recovery waits for it, then revokes the session it left", async () => {
    const u = user()
    fake.issue.push("crash")
    await expect(u.session().connect()).rejects.toThrow("crash")
    const record = JSON.parse(u.read(PENDING_FILE) ?? "{}").issues[0]
    const pid = fake.pids.at(-1) as number
    expect(record.child).toEqual({ pid, created: fake.created.get(pid) })
    expect(live()).toHaveLength(1)
    // The child is still running: nothing is revoked, the record stays.
    await u.session().disconnect()
    expect(live()).toHaveLength(1)
    expect(JSON.parse(u.read(PENDING_FILE) ?? "{}").issues).toHaveLength(1)
    // An id reused by another process (another creation time) counts as gone, like no process at all.
    fake.created.set(pid, "fake:reused")
    await u.session().disconnect()
    expect(live()).toEqual([])
    expect(u.read(PENDING_FILE)).toBeNull()
  })

  it("after the issue answered, before the session was saved: the orphan is revoked", async () => {
    const u = user()
    u.control.crashAt = "issued"
    await expect(u.session().connect()).rejects.toThrow("crash")
    expect(live()).toHaveLength(1)
    expect(u.read(SESSION_FILE)).toBeNull()
    await u.session().disconnect()
    expect(live()).toEqual([])
    expect(u.read(PENDING_FILE)).toBeNull()
  })

  it("after the session was saved, before its record was cleared: the saved session is kept", async () => {
    const u = user()
    u.control.crashAt = "saved"
    await expect(u.session().connect()).rejects.toThrow("crash")
    const saved = JSON.parse(u.read(SESSION_FILE) ?? "{}").sessionId
    const read = await u.session().readProjects()
    expect(read.kind).toBe("ok")
    expect(live()).toEqual([saved])
    expect(u.read(PENDING_FILE)).toBeNull()
  })

  it("in a replacement, after the new one was saved: the old one is revoked", async () => {
    const u = user()
    const old = await u.session().connect()
    u.control.crashAt = "pending cleared"
    await expect(u.session().connect()).rejects.toThrow("crash")
    const saved = JSON.parse(u.read(SESSION_FILE) ?? "{}").sessionId
    expect(saved).not.toBe(old.sessionId)
    expect(live().sort()).toEqual([old.sessionId, saved].sort())
    expect((await u.session().readProjects()).kind).toBe("ok")
    expect(live()).toEqual([saved])
    expect(u.read(PENDING_FILE)).toBeNull()
  })

  it("in a replacement, before the new one was saved: the old one is kept and the new one revoked", async () => {
    const u = user()
    const old = await u.session().connect()
    u.control.crashAt = "issued"
    await expect(u.session().connect()).rejects.toThrow("crash")
    expect(JSON.parse(u.read(SESSION_FILE) ?? "{}").sessionId).toBe(old.sessionId)
    expect((await u.session().readProjects()).kind).toBe("ok")
    expect(live()).toEqual([old.sessionId])
    expect(u.read(PENDING_FILE)).toBeNull()
  })

  it("in t3-disconnect, before the revoke: the session is kept; after it: the next use finds it refused", async () => {
    const u = user()
    const session = await u.session().connect()
    u.control.crashAt = "revoke entry"
    await expect(u.session().disconnect()).rejects.toThrow("crash")
    expect((await u.session().readProjects()).kind).toBe("ok")
    expect(live()).toEqual([session.sessionId])
    u.control.crashAt = "revoked"
    await expect(u.session().disconnect()).rejects.toThrow("crash")
    expect(live()).toEqual([])
    // Never issued again on its own: the T3 part stops until t3-connect.
    expect(await u.session().readProjects()).toMatchObject({ kind: "stop", code: "t3_rejected" })
    expect(issues()).toHaveLength(1)
  })
})

describe("t3-disconnect", () => {
  it("revokes, then deletes", async () => {
    const u = user()
    await u.session().connect()
    expect(await u.session().disconnect()).toEqual({ wasConnected: true, revocationPending: false })
    expect(live()).toEqual([])
    expect(u.read(SESSION_FILE)).toBeNull()
    expect(await u.session().disconnect()).toEqual({ wasConnected: false, revocationPending: false })
  })

  it("keeps a failed revoke pending and retries it on the next T3 command", async () => {
    const u = user()
    const session = await u.session().connect()
    fake.revokeFailures = 1
    fake.listFailures = 1
    expect(await u.session().disconnect()).toEqual({ wasConnected: true, revocationPending: true })
    expect(u.read(SESSION_FILE)).toBeNull()
    expect(live()).toEqual([session.sessionId])
    expect((await u.session().status()).revocationPending).toBe(true)
    expect(await u.session().readProjects()).toMatchObject({ kind: "stop", code: "t3_not_connected" })
    expect(live()).toEqual([])
    expect((await u.session().status()).revocationPending).toBe(false)
  })
})

describe("readProjects", () => {
  it("reads the project list with the session after the environment check", async () => {
    const u = user()
    await u.session().connect()
    const read = await u.session().readProjects()
    if (read.kind !== "ok") throw new Error(read.kind)
    expect(read.projects.projects.map((p) => p.id)).toEqual([
      "p-widget",
      "mcp:p-gadget",
      "p-gizmo",
      "p-notes",
      "p-missing",
    ])
    expect(read.projects.skipped).toBe(3)
    expect(read.environmentId).toBe(fake.environmentId)
  })

  it("renews the session when less than a quarter of its lifetime is left, and revokes the old one", async () => {
    const u = user()
    const old = await u.session().connect()
    u.clock.offset = 22 * 86_400_000
    expect((await u.session().readProjects()).kind).toBe("ok")
    expect(issues()).toHaveLength(1)
    u.clock.offset = 23 * 86_400_000
    const read = await u.session().readProjects()
    expect(read).toMatchObject({ kind: "ok", renewal: expect.stringContaining("renewed") })
    const saved = JSON.parse(u.read(SESSION_FILE) ?? "{}").sessionId
    expect(saved).not.toBe(old.sessionId)
    expect(live()).toEqual([saved])
  })

  it("keeps the session when the renewal fails", async () => {
    const u = user()
    const old = await u.session().connect()
    u.clock.offset = 23 * 86_400_000
    fake.issue.push("fail")
    expect(await u.session().readProjects()).toMatchObject({
      kind: "ok",
      renewal: expect.stringContaining("could not"),
    })
    expect(JSON.parse(u.read(SESSION_FILE) ?? "{}").sessionId).toBe(old.sessionId)
    expect(live()).toEqual([old.sessionId])
  })

  it("a 401 ends the session: the T3 part stops and nothing is issued or read until t3-connect", async () => {
    const u = user()
    await u.session().connect()
    for (const s of fake.sessions) s.revoked = true
    expect(await u.session().readProjects()).toMatchObject({ kind: "stop", code: "t3_rejected", ended: true })
    expect(await u.session().status()).toMatchObject({ state: "ended", reason: "rejected" })
    const before = { calls: fake.calls.length, projects: fake.counts.projects, descriptor: fake.counts.descriptor }
    expect(await u.session().readProjects()).toMatchObject({ kind: "stop", code: "t3_rejected" })
    expect({ calls: fake.calls.length, projects: fake.counts.projects, descriptor: fake.counts.descriptor }).toEqual(
      before,
    )
    await u.session().connect()
    expect((await u.session().readProjects()).kind).toBe("ok")
  })

  it("an address of another environment ends the session without sending it there", async () => {
    const u = user()
    await u.session().connect()
    fake.httpEnvironmentId = "another-environment"
    const projectsBefore = fake.counts.projects
    expect(await u.session().readProjects()).toMatchObject({ kind: "stop", code: "t3_other_environment" })
    expect(fake.counts.projects).toBe(projectsBefore)
    expect(await u.session().status()).toMatchObject({ state: "ended", reason: "other_environment" })
  })

  it("an availability failure is not an ending: the caller may use the last good list", async () => {
    const u = user()
    await u.session().connect()
    fake.descriptorAnswer.push("drop")
    expect(await u.session().readProjects()).toMatchObject({ kind: "unavailable" })
    fake.projectsAnswer.push(503)
    expect(await u.session().readProjects()).toMatchObject({ kind: "unavailable" })
    fake.projectsAnswer.push("drop")
    expect(await u.session().readProjects()).toMatchObject({ kind: "unavailable" })
    // A refusal that is neither: no fallback, and the session stays.
    fake.projectsAnswer.push(404)
    expect(await u.session().readProjects()).toMatchObject({ kind: "stop", code: "t3_projects_unreadable" })
    expect((await u.session().status()).state).toBe("connected")
  })
})
