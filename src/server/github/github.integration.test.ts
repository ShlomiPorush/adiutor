import { generateKeyPairSync, randomInt } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { type Scenario, type StandIn, startGitHubStandIn } from "../../../e2e/github-stand-in.mjs"
import { audit, projects, securitySources, settings, syncRuns } from "../db/schema.ts"
import { createGitHubHandle, type GitHubHandle } from "../http/github.ts"
import { getSettings, settingsView, updateSettings } from "../services/admin.ts"
import { addGitHubInstallation, gitHubView, removeGitHubInstallation, saveGitHubApp } from "../services/github.ts"
import { createProject, updateProject } from "../services/projects.ts"
import { morning } from "../services/reads.ts"
import { createSettingsCipher } from "../settings/crypto.ts"
import { createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import { testSecret } from "../testing/secrets.ts"
import { readGitHub } from "./pull.ts"
import { effectiveGitHub } from "./settings.ts"

// The server's pull from GitHub against the stand-in (e2e/github-stand-in.mjs) on a real database: the key handling,
// the allow-list, what each answer becomes, the one write transaction, and the gate between saves and pulls. Every run
// makes its own key pair; nothing here reaches GitHub.

const APP_ID = String(randomInt(100_000, 999_999))
/** GitHub hands out PKCS#1 keys. */
const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
})
const otherKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
})
/** A line of the key's body: it must appear in no answer, audit row or log line. */
const KEY_BODY = keys.privateKey.split("\n")[5] as string

const ALL_READ = {
  vulnerability_alerts: "read",
  security_events: "read",
  secret_scanning_alerts: "read",
  issues: "read",
  metadata: "read",
}
const ORG = { id: 9001, login: "example-org", type: "Organization" }
const MAIN = 4242

function scenario(): Scenario {
  return {
    installations: {
      [MAIN]: {
        account: ORG,
        permissions: { ...ALL_READ },
        repositories: ["example-org/widget", "example-org/gadget"],
      },
      // Never on the allow-list: the server must never ask for it.
      5555: { account: { id: 9002, login: "stranger", type: "User" }, permissions: { ...ALL_READ }, repositories: [] },
    },
    repos: {
      "example-org/widget": {
        id: 7001,
        issues: 3,
        dependabot: {
          alerts: [
            { security_advisory: { severity: "critical" } },
            { security_vulnerability: { severity: "high" } },
            { security_advisory: { severity: "low" } },
          ],
          pageSize: 2,
        },
        code_scanning: { status: 404, message: "no analysis found" },
        secret_scanning: { alerts: [{ number: 1 }, { number: 2 }, { number: 3 }], pageSize: 1 },
      },
      "example-org/gadget": {
        id: 7002,
        issues: 0,
        dependabot: { status: 403, message: "Dependabot alerts are disabled for this repository." },
        code_scanning: {
          alerts: [{ rule: { security_severity_level: "high" } }, { rule: { severity: "warning" } }],
        },
        secret_scanning: { alerts: [] },
      },
    },
  }
}

let t: TestDatabase
let standIn: StandIn
const env = { overrides: {}, cipher: createSettingsCipher([{ version: 1, value: testSecret() }]) }
let handle: GitHubHandle
let hooks: { beforeWrite?: () => Promise<void>; afterLock?: () => Promise<void> } = {}

const deps = () => ({ env, gate: handle.gate, origin: handle.origin })
const generation = async () => (await getSettings(t.ctx.db)).githubGeneration

async function setUp(installations: number[] = [MAIN]) {
  await saveGitHubApp(t.ctx, owner, deps(), { generation: 0, appId: APP_ID, privateKey: keys.privateKey })
  for (const id of installations)
    await addGitHubInstallation(t.ctx, owner, deps(), { generation: await generation(), installationId: id })
}

async function project(name: string, githubRepo: string | null) {
  return createProject(t.ctx, owner, { name, githubRepo })
}

const sources = (projectId: string) =>
  t.ctx.db.select().from(securitySources).where(eq(securitySources.projectId, projectId))
const family = async (projectId: string, f: "dependabot" | "code_scanning" | "secret_scanning") =>
  (
    await t.ctx.db
      .select()
      .from(securitySources)
      .where(and(eq(securitySources.projectId, projectId), eq(securitySources.family, f)))
  )[0]
const projectRow = async (id: string) => (await t.ctx.db.select().from(projects).where(eq(projects.id, id)))[0]
const runs = () => t.ctx.db.select().from(syncRuns).where(eq(syncRuns.kind, "github"))

beforeAll(async () => {
  t = await createTestDatabase("github")
  t.ctx.githubOn = (row) => effectiveGitHub(row, env.overrides, env.cipher).on
  standIn = await startGitHubStandIn({ publicKey: keys.publicKey, appId: APP_ID, scenario: scenario() })
})

afterAll(async () => {
  await standIn?.close()
  await t?.close()
})

beforeEach(async () => {
  await t.reset()
  standIn.scenario = scenario()
  standIn.requests.length = 0
  hooks = {}
  handle = createGitHubHandle({
    ctx: t.ctx,
    env,
    generation: 0,
    origin: standIn.origin,
    beforeWrite: () => hooks.beforeWrite?.() ?? Promise.resolve(),
    afterLock: () => hooks.afterLock?.() ?? Promise.resolve(),
  })
})

afterEach(async () => {
  await handle.runner.stop()
})

describe("the App's key", () => {
  it("is checked with GitHub on save, stored encrypted, and shown only as GitHub's fingerprint", async () => {
    const row = await saveGitHubApp(t.ctx, owner, deps(), { generation: 0, appId: APP_ID, privateKey: keys.privateKey })
    expect(row.githubKeyVerified).toBe(true)
    expect(row.githubGeneration).toBe(1)
    expect(row.githubPrivateKeyEnc).not.toContain("PRIVATE KEY")
    expect(row.githubKeyFingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}=$/)
    const view = await gitHubView(t.ctx, deps(), handle.runner)
    expect(view.settings.key).toMatchObject({ set: true, readable: true, verified: true, locked: false })
    expect(standIn.requests.some((r) => r.path === "/app" && r.auth === "app")).toBe(true)
  })

  it("is refused when GitHub does not accept it, and when it is not a key", async () => {
    await expect(
      saveGitHubApp(t.ctx, owner, deps(), { generation: 0, appId: APP_ID, privateKey: otherKeys.privateKey }),
    ).rejects.toMatchObject({ code: "github_key_rejected" })
    await expect(
      saveGitHubApp(t.ctx, owner, deps(), { generation: 0, appId: APP_ID, privateKey: "not a key" }),
    ).rejects.toMatchObject({ code: "github_key_invalid" })
    expect((await getSettings(t.ctx.db)).githubPrivateKeyEnc).toBeNull()
  })

  it("never appears in an answer, an audit row or a log line", async () => {
    const lines: string[] = []
    const spies = [
      vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line))),
      vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line))),
    ]
    try {
      await setUp()
      await project("Widget", "example-org/widget")
      await handle.runner.pull()
      // Another settings save after the key: its audit row holds the whole settings row.
      await updateSettings(t.ctx, owner, { language: "en" }, env)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    const row = await getSettings(t.ctx.db)
    const answers = JSON.stringify([
      settingsView(row, env),
      await gitHubView(t.ctx, deps(), handle.runner),
      await t.ctx.db.select().from(audit),
    ])
    for (const text of [answers, lines.join("\n")]) {
      expect(text).not.toContain(KEY_BODY)
      expect(text).not.toContain("PRIVATE KEY")
      expect(text).not.toContain(row.githubPrivateKeyEnc as string)
      expect(text).not.toMatch(/ghs_[0-9a-f]{20,}/)
    }
  })

  it("is not replaced by a key that cannot be checked when the stored one was verified", async () => {
    await saveGitHubApp(t.ctx, owner, deps(), { generation: 0, appId: APP_ID, privateKey: keys.privateKey })
    const closed = { ...deps(), origin: "http://127.0.0.1:9" }
    await expect(
      saveGitHubApp(t.ctx, owner, closed, { generation: 1, privateKey: otherKeys.privateKey }),
    ).rejects.toMatchObject({ code: "github_unreachable" })
  })

  it("refuses removal while the environment turns GitHub on", async () => {
    const locked = { ...env, overrides: { githubAppId: APP_ID } }
    await expect(
      saveGitHubApp(t.ctx, owner, { ...deps(), env: locked }, { generation: 0, privateKey: null }),
    ).rejects.toMatchObject({ code: "github_key_required" })
  })

  it("refuses a save based on an older generation", async () => {
    await saveGitHubApp(t.ctx, owner, deps(), { generation: 0, appId: APP_ID, privateKey: keys.privateKey })
    await expect(
      addGitHubInstallation(t.ctx, owner, deps(), { generation: 0, installationId: MAIN }),
    ).rejects.toMatchObject({ code: "conflict" })
  })
})

describe("the allow-list", () => {
  it("stores the account an installation is bound to, and never asks for one that is not on the list", async () => {
    await setUp()
    expect((await getSettings(t.ctx.db)).githubInstallations).toEqual([
      { id: MAIN, accountId: ORG.id, accountType: ORG.type, login: ORG.login },
    ])
    await project("Widget", "example-org/widget")
    await handle.runner.pull()
    expect(standIn.requests.some((r) => r.path.includes("5555") || r.auth === "installation:5555")).toBe(false)
    expect(standIn.requests.some((r) => r.path === "/app/installations")).toBe(false)
  })

  it("never reads an installation granted more than the read permissions", async () => {
    standIn.scenario.installations[MAIN] = {
      ...(standIn.scenario.installations[MAIN] as Scenario["installations"][number]),
      permissions: { ...ALL_READ, contents: "write" },
    }
    await setUp()
    await project("Widget", "example-org/widget")
    await handle.runner.pull()
    expect(standIn.requests.some((r) => r.path.endsWith("/access_tokens"))).toBe(false)
    const view = await gitHubView(t.ctx, deps(), handle.runner)
    expect(view.installations[0]?.state).toBe("too_broad")
  })

  it("asks a token for the read permissions the installation holds, and nothing else", async () => {
    const { issues: _issues, ...withoutIssues } = ALL_READ
    standIn.scenario.installations[MAIN] = {
      ...(standIn.scenario.installations[MAIN] as Scenario["installations"][number]),
      permissions: withoutIssues,
    }
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    await handle.runner.pull()
    const token = standIn.requests.find((r) => r.path.endsWith("/access_tokens"))
    expect(token?.permissions).toEqual([
      "metadata",
      "secret_scanning_alerts",
      "security_events",
      "vulnerability_alerts",
    ])
    // Without the Issues permission the count is cleared, and no GraphQL query is sent.
    expect(standIn.requests.some((r) => r.path === "/graphql")).toBe(false)
    expect(await projectRow(widget.id)).toMatchObject({ openIssuesCount: null, openIssuesOrigin: "github" })
  })

  it("stops reading an installation at once when it is removed", async () => {
    await setUp()
    const before = await generation()
    await removeGitHubInstallation(t.ctx, owner, deps(), { generation: before, installationId: MAIN })
    expect((await getSettings(t.ctx.db)).githubInstallations).toEqual([])
    await expect(handle.runner.readNow()).rejects.toMatchObject({ code: "github_not_set_up" })
  })
})

describe("a pull", () => {
  it("reads every family and the Issues count, writes them in one transaction, and records the run", async () => {
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    const gadget = await project("Gadget", "example-org/gadget")
    const summary = await handle.runner.pull()
    expect(summary).toMatchObject({ result: "written", outcome: "succeeded" })

    expect(await family(widget.id, "dependabot")).toMatchObject({
      coverage: "enabled",
      critical: 1,
      high: 1,
      low: 1,
      origin: "github",
      attempt: "ok",
    })
    // No analysis, and GitHub names this installation for the repository: code scanning is off.
    expect(await family(widget.id, "code_scanning")).toMatchObject({ coverage: "not_enabled", attempt: "ok" })
    expect(await family(widget.id, "secret_scanning")).toMatchObject({ coverage: "enabled", high: 3 })
    expect(await projectRow(widget.id)).toMatchObject({
      openIssuesCount: 3,
      openIssuesOrigin: "github",
      githubRepoId: 7001,
    })
    expect(await family(gadget.id, "dependabot")).toMatchObject({ coverage: "not_enabled" })
    expect(await family(gadget.id, "code_scanning")).toMatchObject({ coverage: "enabled", high: 1, low: 1 })
    expect(await projectRow(gadget.id)).toMatchObject({ openIssuesCount: 0 })

    const [run] = await runs()
    expect(run).toMatchObject({ outcome: "succeeded", errors: [] })
    const rows = await t.ctx.db.select().from(audit).where(eq(audit.source, "github"))
    expect(rows.map((r) => r.action).sort()).toEqual(["security.pull", "security.update", "security.update"])
  })

  it("asks every secret scanning page with hide_secret=true, and follows only the list's own pages", async () => {
    await setUp()
    await project("Widget", "example-org/widget")
    await handle.runner.pull()
    // A list of more than one page is read twice (it must not change while it is read).
    const pages = standIn.requests.filter((r) => r.family === "secret_scanning")
    expect(pages).toHaveLength(6)
    for (const page of pages) expect(page.query).toMatchObject({ hide_secret: "true", state: "open", per_page: "100" })
    expect(standIn.requests.filter((r) => r.family === "dependabot").map((r) => r.query.after ?? null)).toHaveLength(4)
    // Every list is asked as GitHub documents it, by the repository's name.
    for (const r of standIn.requests.filter((r) => r.family !== undefined))
      expect(r.path.startsWith("/repos/example-org/widget/")).toBe(true)
  })

  it("keeps the stored counts when a read fails, and records the attempt", async () => {
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    await handle.runner.pull()
    const before = await family(widget.id, "dependabot")
    standIn.scenario.repos["example-org/widget"] = {
      ...(standIn.scenario.repos["example-org/widget"] as Scenario["repos"][string]),
      dependabot: { status: 502, message: "Server Error" },
      issues: "error",
    }
    t.clock.travel(60_000)
    expect(await handle.runner.pull()).toMatchObject({ result: "written", outcome: "partial" })
    const after = await family(widget.id, "dependabot")
    expect(after).toMatchObject({ coverage: "enabled", critical: 1, high: 1, low: 1, attempt: "error" })
    expect(after?.asOf).toEqual(before?.asOf)
    expect(after?.attemptedAt?.getTime()).toBeGreaterThan(before?.attemptedAt?.getTime() ?? 0)
    expect(await projectRow(widget.id)).toMatchObject({ openIssuesCount: 3 })
  })

  it("never calls a repository missing from an incomplete inventory no_access, and does once it is complete", async () => {
    await setUp()
    const lost = await project("Lost", "example-org/lost")
    const main = standIn.scenario.installations[MAIN] as Scenario["installations"][number]
    main.inventory = { countDelta: 1 }
    await handle.runner.pull()
    expect(await family(lost.id, "dependabot")).toMatchObject({ coverage: "error", attempt: "error" })
    main.inventory = {}
    await handle.runner.pull()
    expect(await family(lost.id, "dependabot")).toMatchObject({ coverage: "no_access", attempt: "ok" })
    expect(await projectRow(lost.id)).toMatchObject({ openIssuesCount: null, openIssuesOrigin: "github" })
  })

  it("calls every repository of an uninstalled installation no_access", async () => {
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    ;(standIn.scenario.installations[MAIN] as Scenario["installations"][number]).uninstalled = true
    await handle.runner.pull()
    expect((await sources(widget.id)).map((s) => s.coverage)).toEqual(["no_access", "no_access", "no_access"])
    expect((await gitHubView(t.ctx, deps(), handle.runner)).installations[0]?.state).toBe("uninstalled")
  })

  it("does not call a family off when GitHub names another installation for the repository", async () => {
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    ;(standIn.scenario.repos["example-org/widget"] as Scenario["repos"][string]).appInstallation = null
    await handle.runner.pull()
    expect(await family(widget.id, "code_scanning")).toMatchObject({ coverage: "error" })
  })

  it("never follows a redirect, and never a next page outside the list", async () => {
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    const gadget = await project("Gadget", "example-org/gadget")
    const repos = standIn.scenario.repos
    ;(repos["example-org/widget"] as Scenario["repos"][string]).dependabot = {
      status: 301,
      headers: { location: `${standIn.origin}/elsewhere` },
    }
    ;(repos["example-org/gadget"] as Scenario["repos"][string]).code_scanning = {
      alerts: [{ rule: {} }, { rule: {} }],
      pageSize: 1,
      nextPath: "/repos/example-org/widget/code-scanning/alerts",
    }
    await handle.runner.pull()
    expect(standIn.requests.some((r) => r.path === "/elsewhere")).toBe(false)
    expect(await family(widget.id, "dependabot")).toMatchObject({ coverage: "error" })
    expect(await family(gadget.id, "code_scanning")).toMatchObject({ coverage: "error" })
  })

  it("stops at a rate limit, writes what it read, and holds the next pull until the limit ends", async () => {
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    const reset = Math.floor(Date.now() / 1000) + 600
    ;(standIn.scenario.repos["example-org/widget"] as Scenario["repos"][string]).dependabot = {
      status: 403,
      message: "API rate limit exceeded",
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    }
    // Nothing about the one project could be read before the limit: the pull failed, and wrote the attempts.
    expect(await handle.runner.pull()).toMatchObject({ result: "written", outcome: "failed" })
    expect(await family(widget.id, "dependabot")).toMatchObject({ coverage: "error" })
    const sent = standIn.requests.length
    await expect(handle.runner.readNow()).rejects.toMatchObject({ code: "github_rate_limited" })
    expect(await handle.runner.pull()).toMatchObject({ result: "not_written", code: "rate_limited" })
    expect(standIn.requests.length).toBe(sent)
  })

  it("stops at a GraphQL rate limit, whatever the status", async () => {
    await setUp()
    await project("Widget", "example-org/widget")
    standIn.scenario.graphql = { rateLimited: true }
    expect(await handle.runner.pull()).toMatchObject({ result: "written", outcome: "partial" })
    expect(handle.runner.state().rateLimitedUntil).not.toBeNull()
  })

  it("skips a project whose repository changed while it was read", async () => {
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    hooks.beforeWrite = async () => {
      await updateProject(t.ctx, owner, widget.id, { githubRepo: "example-org/gadget" })
    }
    expect(await handle.runner.pull()).toMatchObject({ result: "written", outcome: "partial" })
    expect(await sources(widget.id)).toEqual([])
    expect((await runs())[0]?.counts).toMatchObject({ projectsSkipped: 1 })
  })

  it("marks a repository found again only by its id as moved, and keeps its data", async () => {
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    await handle.runner.pull()
    const main = standIn.scenario.installations[MAIN] as Scenario["installations"][number]
    main.repositories = ["example-org/widget-renamed", "example-org/gadget"]
    standIn.scenario.repos["example-org/widget-renamed"] = standIn.scenario.repos["example-org/widget"] as never
    await handle.runner.pull()
    expect(await family(widget.id, "dependabot")).toMatchObject({ coverage: "enabled", critical: 1, attempt: "error" })
    const view = await gitHubView(t.ctx, deps(), handle.runner)
    expect(view.moved).toEqual([
      { id: widget.id, name: "Widget", repo: "example-org/widget", movedTo: "example-org/widget-renamed" },
    ])
  })

  it("sends nothing once aborted, the token request included", async () => {
    await setUp()
    const controller = new AbortController()
    controller.abort()
    const github = effectiveGitHub(await getSettings(t.ctx.db), env.overrides, env.cipher)
    standIn.requests.length = 0
    const read = await readGitHub(
      {
        appId: APP_ID,
        privateKey: github.privateKey as string,
        installations: github.installations,
        projects: [],
      },
      { origin: standIn.origin, signal: controller.signal, clock: t.ctx.clock },
    )
    expect(read.stopped).toEqual({ kind: "aborted" })
    expect(standIn.requests).toEqual([])
  })
})

describe("a settings save during a pull", () => {
  it("before the pull's write: the pull writes nothing and sends nothing more", async () => {
    await setUp()
    await project("Widget", "example-org/widget")
    hooks.beforeWrite = async () => {
      await saveGitHubApp(t.ctx, owner, deps(), { generation: await generation(), appId: APP_ID })
      standIn.requests.length = 0
    }
    expect(await handle.runner.pull()).toMatchObject({ result: "stopped" })
    expect(await runs()).toEqual([])
    expect(standIn.requests.filter((r) => r.path !== "/app")).toEqual([])
  })

  it("while the pull's write holds the lock: the save waits and commits after it", async () => {
    await setUp()
    await project("Widget", "example-org/widget")
    let save: Promise<unknown> = Promise.resolve()
    hooks.afterLock = async () => {
      // The save itself checks with GitHub first; the commit then waits for the pull's shared lock.
      save = saveGitHubApp(t.ctx, owner, deps(), { generation: await generation(), appId: APP_ID })
      const until = Date.now() + 10_000
      while (Date.now() < until) {
        const [row] = [
          ...(await t.ctx.db.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_stat_activity
              where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`,
          )),
        ]
        if ((row?.n ?? 0) >= 1) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error("the save never waited for the pull's lock")
    }
    expect(await handle.runner.pull()).toMatchObject({ result: "written" })
    await save
    expect(await runs()).toHaveLength(1)
    expect((await getSettings(t.ctx.db)).githubGeneration).toBe(3)
  })
})

describe("the GitHub status", () => {
  it("is off without the App, not read before the first pull, fine after it, and counts stale projects", async () => {
    await project("Widget", "example-org/widget")
    expect((await morning(t.ctx)).github.state).toBe("off")
    await setUp()
    expect((await morning(t.ctx)).github.state).toBe("not_read")
    await handle.runner.pull()
    expect((await morning(t.ctx)).github).toEqual({ state: "fine", notCovered: 0, oldestGoodReadAt: null })
    t.clock.travel(27 * 60 * 60 * 1000)
    const stale = (await morning(t.ctx)).github
    expect(stale).toMatchObject({ state: "not_covered", notCovered: 1 })
    expect(stale.oldestGoodReadAt).not.toBeNull()
  })

  it("does not count data the PC pushed as covered", async () => {
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    await handle.runner.pull()
    await t.ctx.db.update(securitySources).set({ origin: "push" }).where(eq(securitySources.projectId, widget.id))
    expect((await morning(t.ctx)).github).toMatchObject({ state: "not_covered", notCovered: 1 })
  })

  it("clears a project's data when the owner changes its repository", async () => {
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    await handle.runner.pull()
    const before = await projectRow(widget.id)
    await updateProject(t.ctx, owner, widget.id, { githubRepo: "example-org/gadget" })
    expect(await sources(widget.id)).toEqual([])
    expect(await projectRow(widget.id)).toMatchObject({
      openIssuesCount: null,
      githubRepoId: null,
      githubRepoVersion: (before?.githubRepoVersion ?? 0) + 1,
    })
  })
})

describe("the settings row", () => {
  it("keeps GitHub's fields out of the general settings answer", async () => {
    await setUp()
    const view = settingsView(await getSettings(t.ctx.db), env) as Record<string, unknown>
    expect(Object.keys(view).filter((k) => k.startsWith("github"))).toEqual([])
    const [row] = await t.ctx.db.select().from(settings)
    expect(row?.githubPrivateKeyEnc).toBeTruthy()
  })
})

describe("review round 1", () => {
  it("never reads a reused name in place of the repository the project was bound to", async () => {
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    await handle.runner.pull()
    expect(await projectRow(widget.id)).toMatchObject({ githubRepoId: 7001 })
    // The repository was renamed, and a new one took its old name.
    const main = standIn.scenario.installations[MAIN] as Scenario["installations"][number]
    main.repositories = ["example-org/widget", "example-org/widget-old", "example-org/gadget"]
    standIn.scenario.repos["example-org/widget-old"] = standIn.scenario.repos["example-org/widget"] as never
    standIn.scenario.repos["example-org/widget"] = { id: 7999, issues: 50, dependabot: { alerts: [] } }
    await handle.runner.pull()
    expect(await family(widget.id, "dependabot")).toMatchObject({ coverage: "enabled", critical: 1, attempt: "error" })
    expect(await projectRow(widget.id)).toMatchObject({ githubRepoId: 7001, openIssuesCount: 3 })
    expect((await gitHubView(t.ctx, deps(), handle.runner)).moved[0]?.movedTo).toBe("example-org/widget-old")
    // The old repository is gone too: the project is not read at all until the owner sets its repository again.
    main.repositories = ["example-org/widget", "example-org/gadget"]
    await handle.runner.pull()
    expect(await family(widget.id, "dependabot")).toMatchObject({ critical: 1, attempt: "error" })
    expect(await projectRow(widget.id)).toMatchObject({ githubRepoId: 7001, openIssuesCount: 3 })
  })

  it("reads no repository from an inventory that failed part way", async () => {
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    const main = standIn.scenario.installations[MAIN] as Scenario["installations"][number]
    main.inventory = { pageSize: 1, failPage: 2 }
    await handle.runner.pull()
    expect(standIn.requests.some((r) => r.family !== undefined)).toBe(false)
    expect(await family(widget.id, "dependabot")).toMatchObject({ coverage: "error", attempt: "error" })
  })

  it("keeps the stored counts when a list answers with alerts of another shape", async () => {
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    await handle.runner.pull()
    ;(standIn.scenario.repos["example-org/widget"] as Scenario["repos"][string]).secret_scanning = { body: [{}] }
    await handle.runner.pull()
    expect(await family(widget.id, "secret_scanning")).toMatchObject({ coverage: "enabled", high: 3, attempt: "error" })
  })

  it("writes a pull of many projects in batches, in one transaction", async () => {
    const names = Array.from({ length: 200 }, (_, i) => `example-org/many-${i}`)
    standIn.scenario.installations[MAIN] = {
      ...(standIn.scenario.installations[MAIN] as Scenario["installations"][number]),
      repositories: names,
    }
    names.forEach((name, i) => {
      standIn.scenario.repos[name] = { id: 8000 + i, issues: i, dependabot: { alerts: [] } }
    })
    await setUp()
    await t.ctx.db.insert(projects).values(names.map((name, i) => ({ name, slug: `many-${i}`, githubRepo: name })))
    expect(await handle.runner.pull()).toMatchObject({ result: "written", outcome: "succeeded" })
    const [{ n } = { n: 0 }] = [
      ...(await t.ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from security_sources`)),
    ]
    expect(n).toBe(600)
  })

  it("keeps the stored counts when the name leads to another repository before or after the lists", async () => {
    await setUp()
    const widget = await project("Widget", "example-org/widget")
    await handle.runner.pull()
    const repo = standIn.scenario.repos["example-org/widget"] as Scenario["repos"][string]
    repo.dependabot = { alerts: [] }
    repo.restId = 7999
    await handle.runner.pull()
    expect(await family(widget.id, "dependabot")).toMatchObject({ coverage: "enabled", critical: 1, attempt: "error" })
    // The check before the lists already found another repository: no list was asked for it in that pull.
    const second = standIn.requests.slice(standIn.requests.findLastIndex((r) => r.path === "/app/installations/4242"))
    expect(second.filter((r) => r.family !== undefined)).toEqual([])
  })

  it("keeps the stored counts when a list of more pages changes while it is read", async () => {
    await setUp()
    const gadget = await project("Gadget", "example-org/gadget")
    const repo = standIn.scenario.repos["example-org/gadget"] as Scenario["repos"][string]
    repo.code_scanning = {
      alerts: [
        { rule: { security_severity_level: "low" } },
        { rule: {} },
        { rule: { security_severity_level: "critical" } },
      ],
      pageSize: 2,
    }
    await handle.runner.pull()
    expect(await family(gadget.id, "code_scanning")).toMatchObject({ critical: 1, attempt: "ok" })
    // The low alert closes between the two reads: the critical one moves back a page.
    repo.code_scanning = {
      alerts: [
        { rule: { security_severity_level: "low" } },
        { rule: {} },
        { rule: { security_severity_level: "critical" } },
      ],
      secondRead: [
        { number: 2, rule: {} },
        { number: 3, rule: { security_severity_level: "critical" } },
      ],
      pageSize: 2,
    }
    await handle.runner.pull()
    expect(await family(gadget.id, "code_scanning")).toMatchObject({ critical: 1, attempt: "error" })
  })

  it("counts an alert that a page-number list shows twice once", async () => {
    await setUp()
    const gadget = await project("Gadget", "example-org/gadget")
    ;(standIn.scenario.repos["example-org/gadget"] as Scenario["repos"][string]).code_scanning = {
      alerts: [
        { number: 1, rule: { security_severity_level: "high" } },
        { number: 1, rule: { security_severity_level: "high" } },
        { number: 2, rule: { security_severity_level: "low" } },
      ],
      pageSize: 1,
    }
    await handle.runner.pull()
    expect(await family(gadget.id, "code_scanning")).toMatchObject({ coverage: "enabled", high: 1, low: 1 })
  })

  it("is failed when nothing about any project could be read", async () => {
    await setUp()
    await project("Widget", "example-org/widget")
    const repo = standIn.scenario.repos["example-org/widget"] as Scenario["repos"][string]
    for (const f of ["dependabot", "code_scanning", "secret_scanning"] as const) repo[f] = { status: 502 }
    repo.issues = "error"
    expect(await handle.runner.pull()).toMatchObject({ result: "written", outcome: "failed" })
  })

  it("does not carry the old key's verification to a new key saved without an App id", async () => {
    await saveGitHubApp(t.ctx, owner, deps(), { generation: 0, appId: APP_ID, privateKey: keys.privateKey })
    const row = await saveGitHubApp(t.ctx, owner, deps(), {
      generation: 1,
      appId: null,
      privateKey: otherKeys.privateKey,
    })
    expect(row.githubKeyVerified).toBe(false)
  })
})
