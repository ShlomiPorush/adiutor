import { createPrivateKey, generateKeyPairSync, randomBytes, randomInt } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { type Scenario, type StandIn, startGitHubStandIn } from "../../../e2e/github-stand-in.mjs"
import { createApp } from "../app.ts"
import type { EnvOverrides } from "../config.ts"
import { audit } from "../db/schema.ts"
import { createGitHubHandle, type GitHubHandle } from "../http/github.ts"
import { getSettings } from "../services/admin.ts"
import {
  addGitHubInstallation,
  finishGitHubCreation,
  type GitHubCreateDeps,
  gitHubInstallLink,
  gitHubView,
  previewGitHubInstallation,
  saveGitHubApp,
  startGitHubCreation,
} from "../services/github.ts"
import { createSettingsCipher } from "../settings/crypto.ts"
import { ownerBrowser, testCore } from "../testing/app.ts"
import { TEST_ORIGIN } from "../testing/browser.ts"
import { createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import { testSecret } from "../testing/secrets.ts"
import { keyFingerprint } from "./key.ts"
import { CREATION_TTL_MS } from "./manifest.ts"

// The App made from a manifest (Settings, Create the App on GitHub) and the installations added after GitHub's install
// page sent the browser back, against the stand-in GitHub (e2e/github-stand-in.mjs) on a real database. The App's key
// pair, its client secret and its webhook secret are made on every run; nothing here reaches GitHub.

const APP_ID = String(randomInt(100_000, 999_999))
const SLUG = `adiutor-reader-${randomBytes(2).toString("hex")}`
/** GitHub hands out PKCS#1 keys. */
const rsa = (modulusLength = 2048) =>
  generateKeyPairSync("rsa", {
    modulusLength,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  })
const keys = rsa()
const otherKeys = rsa()
const CLIENT_ID = `Iv23${randomBytes(8).toString("hex")}`
const CLIENT_SECRET = randomBytes(20).toString("hex")
const WEBHOOK_SECRET = randomBytes(20).toString("hex")
/** A line of the key's body: it must appear in no answer, audit row or log line. */
const KEY_BODY = keys.privateKey.split("\n")[5] as string
const WEB = "https://github.com"
const PUBLIC = new URL("https://adiutor.example/")

const ALL_READ = {
  vulnerability_alerts: "read",
  security_events: "read",
  secret_scanning_alerts: "read",
  issues: "read",
  metadata: "read",
}
const USABLE = 4242
const BROAD = 4343
const SUSPENDED = 4444

function scenario(): Scenario {
  return {
    installations: {
      [USABLE]: {
        account: { id: 9001, login: "example-org", type: "Organization" },
        permissions: { ...ALL_READ },
        repositories: [],
      },
      [BROAD]: {
        account: { id: 9002, login: "example-team", type: "Organization" },
        permissions: { ...ALL_READ, contents: "write" },
        repositories: [],
      },
      [SUSPENDED]: {
        account: { id: 9003, login: "example-owner", type: "User" },
        permissions: { ...ALL_READ },
        repositories: [],
        suspended: true,
      },
    },
    repos: {},
  }
}

/** The conversion's answer as GitHub documents it, for the stand-in's App and key; `change` makes a variant. */
function conversion(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Number(APP_ID),
    slug: SLUG,
    node_id: `A_${randomBytes(6).toString("hex")}`,
    owner: { login: "example-owner", id: 9003, type: "User" },
    name: "Adiutor reader 0a1b",
    description: null,
    external_url: "https://github.com/ShlomiPorush/adiutor",
    html_url: `https://github.com/apps/${SLUG}`,
    permissions: { ...ALL_READ },
    events: [],
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    webhook_secret: WEBHOOK_SECRET,
    pem: keys.privateKey,
    ...change,
  }
}

let t: TestDatabase
let standIn: StandIn
let handle: GitHubHandle
const env: { overrides: EnvOverrides; cipher: ReturnType<typeof createSettingsCipher> } = {
  overrides: {},
  cipher: createSettingsCipher([{ version: 1, value: testSecret() }]),
}

const deps = (overrides: EnvOverrides = {}): GitHubCreateDeps => ({
  env: { ...env, overrides },
  gate: handle.gate,
  origin: handle.origin,
  publicUrl: PUBLIC,
  pending: handle.pending,
})
const newCode = () => randomBytes(10).toString("hex")
const stateOf = (action: string) => new URL(action).searchParams.get("state") as string
const settingsRow = () => getSettings(t.ctx.db)
const conversions = () => standIn.requests.filter((r) => r.path.startsWith("/app-manifests/"))

/** Starts a creation and registers a code whose conversion answers `answer`. */
async function started(answer: { status?: number; body: unknown } = { body: conversion() }) {
  const { action } = await startGitHubCreation(t.ctx, owner, deps())
  const code = newCode()
  standIn.registerConversion(code, answer)
  return { code, state: stateOf(action) }
}

/** Nothing about an App was saved, and the generation did not move. */
async function nothingSaved(generation = 0) {
  const row = await settingsRow()
  expect(row).toMatchObject({
    githubAppId: null,
    githubPrivateKeyEnc: null,
    githubKeyFingerprint: null,
    githubGeneration: generation,
  })
}

beforeAll(async () => {
  t = await createTestDatabase("github_create")
  standIn = await startGitHubStandIn({ publicKey: keys.publicKey, appId: APP_ID, scenario: scenario(), slug: SLUG })
})

afterAll(async () => {
  await standIn?.close()
  await t?.close()
})

beforeEach(async () => {
  await t.reset()
  standIn.scenario = scenario()
  standIn.requests.length = 0
  handle = createGitHubHandle({ ctx: t.ctx, env, generation: 0, origin: standIn.origin })
})

describe("starting the App's creation", () => {
  it("answers GitHub's form address with a one-time state, and the manifest of a read-only App", async () => {
    const { action, manifest } = await startGitHubCreation(t.ctx, owner, deps())
    const url = new URL(action)
    expect(url.origin).toBe(WEB)
    expect(url.pathname).toBe("/settings/apps/new")
    expect(stateOf(action)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const parsed = JSON.parse(manifest)
    expect(parsed.name).toMatch(/^Adiutor reader [0-9a-f]{4}$/)
    expect(parsed).toEqual({
      name: parsed.name,
      url: "https://github.com/ShlomiPorush/adiutor",
      hook_attributes: { url: "https://adiutor.example/", active: false },
      redirect_url: "https://adiutor.example/settings/github",
      setup_url: "https://adiutor.example/settings/github",
      public: true,
      default_events: [],
      default_permissions: ALL_READ,
      request_oauth_on_install: false,
      setup_on_update: true,
    })
    // Each start makes a new state.
    const again = await startGitHubCreation(t.ctx, owner, deps())
    expect(stateOf(again.action)).not.toBe(stateOf(action))
  })

  it("is refused while an environment variable sets a GitHub field", async () => {
    const cases: [EnvOverrides, string][] = [
      [{ githubAppId: APP_ID }, "ADIUTOR_GITHUB_APP_ID"],
      [{ githubPrivateKey: keys.privateKey }, "ADIUTOR_GITHUB_PRIVATE_KEY"],
      [{ githubInstallations: [USABLE] }, "ADIUTOR_GITHUB_INSTALLATIONS"],
    ]
    for (const [overrides, variable] of cases) {
      await expect(startGitHubCreation(t.ctx, owner, deps(overrides))).rejects.toMatchObject({
        code: "setting_locked",
        details: { variable },
      })
    }
  })

  it("is refused while an App id or a key is stored", async () => {
    await saveGitHubApp(t.ctx, owner, deps(), { generation: 0, appId: APP_ID })
    await expect(startGitHubCreation(t.ctx, owner, deps())).rejects.toMatchObject({ code: "conflict" })
    await saveGitHubApp(t.ctx, owner, deps(), { generation: 1, appId: null, privateKey: keys.privateKey })
    await expect(startGitHubCreation(t.ctx, owner, deps())).rejects.toMatchObject({ code: "conflict" })
  })
})

describe("finishing the App's creation", () => {
  it("saves the App id and its key, verified, with GitHub's fingerprint, and keeps none of GitHub's secrets", async () => {
    const lines: string[] = []
    const spies = [
      vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line))),
      vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line))),
    ]
    let code: string
    let state: string
    let answer: unknown
    try {
      ;({ code, state } = await started())
      answer = await finishGitHubCreation(t.ctx, owner, deps(), { code, state })
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(answer).toEqual({ owner: { login: "example-owner", type: "User" } })
    const row = await settingsRow()
    expect(row).toMatchObject({
      githubAppId: APP_ID,
      githubKeyVerified: true,
      githubKeyFingerprint: keyFingerprint(createPrivateKey(keys.privateKey)),
      githubGeneration: 1,
    })
    // The conversion went out without credentials, and GitHub accepted the new key for the App.
    expect(conversions()).toEqual([expect.objectContaining({ method: "POST", auth: "none" })])
    expect(standIn.requests.some((r) => r.path === "/app" && r.auth === "app")).toBe(true)
    const audits = await t.ctx.db.select().from(audit)
    const created = audits.find((a) => a.action === "settings.update")
    expect(created?.after).toMatchObject({
      githubAppId: APP_ID,
      githubKeyFingerprint: row.githubKeyFingerprint,
      githubPrivateKey: "set",
      githubAppCreated: { owner: "example-owner" },
    })
    const view = await gitHubView(t.ctx, deps(), handle.runner)
    expect(view.settings.key).toMatchObject({ set: true, readable: true, verified: true })
    const everything = JSON.stringify([answer, view, row, audits, lines])
    for (const secret of [CLIENT_ID, CLIENT_SECRET, WEBHOOK_SECRET, KEY_BODY, "PRIVATE KEY", code, state])
      expect(everything).not.toContain(secret)
  })

  it("refuses a state that is wrong, already used, or older than an hour, before calling GitHub", async () => {
    const { code, state } = await started()
    await expect(
      finishGitHubCreation(t.ctx, owner, deps(), { code, state: randomBytes(32).toString("base64url") }),
    ).rejects.toMatchObject({ code: "github_create_expired" })
    expect(conversions()).toHaveLength(0)

    // A wrong state leaves the right one waiting; a code GitHub does not know uses the state up.
    await expect(finishGitHubCreation(t.ctx, owner, deps(), { code: newCode(), state })).rejects.toMatchObject({
      code: "github_code_rejected",
    })
    await expect(finishGitHubCreation(t.ctx, owner, deps(), { code, state })).rejects.toMatchObject({
      code: "github_create_expired",
    })
    expect(conversions()).toHaveLength(1)
    await nothingSaved()

    const late = await started()
    t.clock.offsetMs += CREATION_TTL_MS + 1000
    await expect(finishGitHubCreation(t.ctx, owner, deps(), late)).rejects.toMatchObject({
      code: "github_create_expired",
    })
    // Expired is used up too.
    t.clock.offsetMs = 0
    await expect(finishGitHubCreation(t.ctx, owner, deps(), late)).rejects.toMatchObject({
      code: "github_create_expired",
    })
    expect(conversions()).toHaveLength(1)
    await nothingSaved()
  })

  it("keeps only the latest start", async () => {
    const first = await started()
    const second = await started()
    await expect(finishGitHubCreation(t.ctx, owner, deps(), first)).rejects.toMatchObject({
      code: "github_create_expired",
    })
    await finishGitHubCreation(t.ctx, owner, deps(), second)
    expect((await settingsRow()).githubAppId).toBe(APP_ID)
  })

  it("refuses when the GitHub settings changed since the start, before calling GitHub", async () => {
    const first = await started()
    // An App id saved and removed again: nothing is stored, but the settings changed.
    await saveGitHubApp(t.ctx, owner, deps(), { generation: 0, appId: APP_ID })
    await saveGitHubApp(t.ctx, owner, deps(), { generation: 1, appId: null })
    await expect(finishGitHubCreation(t.ctx, owner, deps(), first)).rejects.toMatchObject({ code: "conflict" })

    const second = await started()
    await saveGitHubApp(t.ctx, owner, deps(), { generation: 2, appId: APP_ID })
    await expect(finishGitHubCreation(t.ctx, owner, deps(), second)).rejects.toMatchObject({ code: "conflict" })

    await saveGitHubApp(t.ctx, owner, deps(), { generation: 3, appId: null })
    const third = await started()
    await expect(
      finishGitHubCreation(t.ctx, owner, deps({ githubInstallations: [USABLE] }), third),
    ).rejects.toMatchObject({ code: "setting_locked", details: { variable: "ADIUTOR_GITHUB_INSTALLATIONS" } })
    expect(conversions()).toHaveLength(0)
    expect((await settingsRow()).githubPrivateKeyEnc).toBeNull()
  })

  it("saves nothing when GitHub's answer is not the App the manifest asked for", async () => {
    const small = rsa(1024)
    const ed25519 = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    // PEM markers around a body that is no key, assembled here so no key-shaped text is in the repository.
    const marker = (edge: string) => `-----${edge} ${["RSA", "PRIVATE", "KEY"].join(" ")}-----`
    const notAKey = [marker("BEGIN"), randomBytes(24).toString("base64"), marker("END")].join("\n")
    const { metadata: _metadata, ...withoutMetadata } = ALL_READ
    const variants: [string, unknown, string][] = [
      ["more permissions", conversion({ permissions: { ...ALL_READ, contents: "read" } }), "permissions"],
      ["fewer permissions", conversion({ permissions: withoutMetadata }), "permissions"],
      ["a write permission", conversion({ permissions: { ...ALL_READ, issues: "write" } }), "permissions"],
      ["events", conversion({ events: ["push"] }), "events"],
      ["no id", conversion({ id: "1" }), "malformed"],
      ["no owner", conversion({ owner: null }), "malformed"],
      ["no slug", conversion({ slug: "" }), "malformed"],
      ["no key", conversion({ pem: undefined }), "malformed"],
      ["not JSON", "not an app", "malformed"],
      ["a list", [conversion()], "malformed"],
      ["a small key", conversion({ pem: small.privateKey }), "key"],
      ["not an RSA key", conversion({ pem: ed25519 }), "key"],
      ["not a key", conversion({ pem: notAKey }), "key"],
    ]
    for (const [name, body, reason] of variants) {
      const flow = await started({ body })
      await expect(finishGitHubCreation(t.ctx, owner, deps(), flow), name).rejects.toMatchObject({
        code: "github_app_invalid",
        details: { reason },
      })
    }
    // A key of another App: GitHub refuses it for this App id.
    await expect(
      finishGitHubCreation(t.ctx, owner, deps(), await started({ body: conversion({ pem: otherKeys.privateKey }) })),
    ).rejects.toMatchObject({ code: "github_key_rejected" })
    // Another App's id with this key: GitHub refuses the key for that App.
    await expect(
      finishGitHubCreation(t.ctx, owner, deps(), await started({ body: conversion({ id: Number(APP_ID) + 1 }) })),
    ).rejects.toMatchObject({ code: "github_key_rejected" })
    // GitHub failing the conversion itself.
    await expect(
      finishGitHubCreation(t.ctx, owner, deps(), await started({ status: 502, body: { message: "Server Error" } })),
    ).rejects.toMatchObject({ code: "github_unreachable" })
    await expect(
      finishGitHubCreation(t.ctx, owner, deps(), await started({ status: 422, body: { message: "Invalid code" } })),
    ).rejects.toMatchObject({ code: "github_code_rejected" })
    await nothingSaved()
    expect(await t.ctx.db.select().from(audit)).toEqual([])
  })

  it("saves nothing when GitHub cannot be reached", async () => {
    const flow = await started()
    const closed = { ...deps(), origin: "http://127.0.0.1:9" }
    await expect(finishGitHubCreation(t.ctx, owner, closed, flow)).rejects.toMatchObject({
      code: "github_unreachable",
    })
    await nothingSaved()
  })
})

describe("installing the App", () => {
  const setUp = () => saveGitHubApp(t.ctx, owner, deps(), { generation: 0, appId: APP_ID, privateKey: keys.privateKey })

  it("links GitHub's install page by the slug GitHub gives now", async () => {
    await setUp()
    expect(await gitHubInstallLink(t.ctx, owner, deps())).toEqual({
      url: `${WEB}/apps/${SLUG}/installations/new`,
    })
  })

  it("is refused while the environment sets the installations, and before the App is set up", async () => {
    await expect(gitHubInstallLink(t.ctx, owner, deps())).rejects.toMatchObject({ code: "github_not_set_up" })
    await setUp()
    await expect(gitHubInstallLink(t.ctx, owner, deps({ githubInstallations: [USABLE] }))).rejects.toMatchObject({
      code: "setting_locked",
      details: { variable: "ADIUTOR_GITHUB_INSTALLATIONS" },
    })
  })

  it("previews an installation as GitHub answers it, and stores nothing", async () => {
    await setUp()
    const preview = (id: number) => previewGitHubInstallation(t.ctx, owner, deps(), id)
    expect(await preview(USABLE)).toEqual({
      id: USABLE,
      account: { login: "example-org", type: "Organization" },
      state: "usable",
    })
    expect((await preview(BROAD)).state).toBe("too_broad")
    expect(await preview(SUSPENDED)).toMatchObject({ account: { login: "example-owner", type: "User" } })
    expect((await preview(SUSPENDED)).state).toBe("suspended")
    await expect(preview(4545)).rejects.toMatchObject({ code: "github_installation_not_found" })
    expect(await settingsRow()).toMatchObject({ githubInstallations: [], githubGeneration: 1 })
    await addGitHubInstallation(t.ctx, owner, deps(), { generation: 1, installationId: USABLE })
    expect((await preview(USABLE)).state).toBe("already_added")
  })

  it("previews an installation as locked while the environment sets the list, so no Add is offered", async () => {
    await setUp()
    const locked = deps({ githubInstallations: [USABLE] })
    expect(await previewGitHubInstallation(t.ctx, owner, locked, BROAD)).toMatchObject({ state: "locked" })
    expect(await previewGitHubInstallation(t.ctx, owner, locked, USABLE)).toMatchObject({ state: "already_added" })
    expect(await previewGitHubInstallation(t.ctx, owner, locked, SUSPENDED)).toMatchObject({ state: "locked" })
    await expect(
      addGitHubInstallation(t.ctx, owner, locked, { generation: 1, installationId: SUSPENDED }),
    ).rejects.toMatchObject({ code: "setting_locked" })
  })

  it("refuses to add a suspended installation or one granted more than the read permissions", async () => {
    await setUp()
    await expect(
      addGitHubInstallation(t.ctx, owner, deps(), { generation: 1, installationId: SUSPENDED }),
    ).rejects.toMatchObject({ code: "github_installation_suspended" })
    await expect(
      addGitHubInstallation(t.ctx, owner, deps(), { generation: 1, installationId: BROAD }),
    ).rejects.toMatchObject({ code: "github_installation_too_broad" })
    expect(await settingsRow()).toMatchObject({ githubInstallations: [], githubGeneration: 1 })
  })
})

describe("over HTTP", () => {
  it("creates the App and installs it through the owner's routes, none of them cached", async () => {
    const lines: string[] = []
    const spies = [
      vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line))),
      vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line))),
    ]
    try {
      const core = testCore(t, {
        config: { publicUrl: new URL(TEST_ORIGIN), version: "test" },
        github: { origin: standIn.origin },
      })
      const app = createApp({ checkDatabase: async () => true, core })
      const b = await ownerBrowser(t, app)

      const start = await b.call("POST", "/api/v1/github/create")
      expect(start.status).toBe(200)
      expect(start.headers.get("cache-control")).toBe("no-store")
      expect(JSON.parse(start.json.data.manifest).redirect_url).toBe(`${TEST_ORIGIN}/settings/github`)
      const state = stateOf(start.json.data.action)
      const code = newCode()
      standIn.registerConversion(code, { body: conversion() })

      const finish = await b.call("POST", "/api/v1/github/create/finish", { body: { code, state } })
      expect(finish.status).toBe(200)
      expect(finish.headers.get("cache-control")).toBe("no-store")
      expect(finish.json.data.owner).toEqual({ login: "example-owner", type: "User" })
      expect(finish.json.data.view.settings.appId.value).toBe(APP_ID)
      expect(finish.json.data.view.settings.key).toMatchObject({ verified: true })
      const again = await b.call("POST", "/api/v1/github/create/finish", { body: { code, state } })
      expect(again.json.error.code).toBe("github_create_expired")

      const install = await b.call("POST", "/api/v1/github/install")
      expect(install.json.data).toEqual({ url: `${WEB}/apps/${SLUG}/installations/new` })
      expect(install.headers.get("cache-control")).toBe("no-store")
      const preview = await b.call("GET", `/api/v1/github/installations/${USABLE}/preview`)
      expect(preview.json.data).toMatchObject({ id: USABLE, state: "usable" })
      expect(preview.headers.get("cache-control")).toBe("no-store")
      const added = await b.call("POST", "/api/v1/github/installations", {
        body: { generation: finish.json.data.view.settings.generation, installationId: USABLE },
      })
      expect(added.status).toBe(201)

      const everything = JSON.stringify([start.json, finish.json, again.json, install.json, preview.json, lines])
      for (const secret of [CLIENT_ID, CLIENT_SECRET, WEBHOOK_SECRET, KEY_BODY, code])
        expect(everything).not.toContain(secret)
      expect(lines.join("\n")).not.toContain(state)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
