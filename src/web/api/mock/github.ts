// The mock of the server's GitHub reading (GET /api/v1/github and its changes) over invented data, for development and
// screenshots. `adiutor.mock.github` in localStorage picks how it starts: "off" (nothing set up), "notread" (set up,
// never read), "fine" (read, every project current) or "problems" (the default: a read that failed in part, projects
// not covered, a moved repository, a rate limit). `adiutor.mock.env` locks the fields as the environment would
// (ADIUTOR_GITHUB_APP_ID, ADIUTOR_GITHUB_PRIVATE_KEY, ADIUTOR_GITHUB_INSTALLATIONS). No value here is a credential:
// a pasted key is only looked at for its PEM markers and never kept; its fingerprint is invented on each save.

import type { TransportResponse } from "../client.ts"
import type { GitHubInstallation, GitHubStatus, GitHubView, Project } from "../types.ts"
import { ago } from "./fixtures.ts"

type Mode = "off" | "notread" | "fine" | "problems"

function mockMode(): Mode {
  try {
    const value = localStorage.getItem("adiutor.mock.github")
    return value === "off" || value === "notread" || value === "fine" ? value : "problems"
  } catch {
    return "problems"
  }
}

function lockedVariables(): Set<string> {
  try {
    return new Set(
      (localStorage.getItem("adiutor.mock.env") ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    )
  } catch {
    return new Set()
  }
}

/** An invented fingerprint in GitHub's form, new on every save. */
function fingerprint(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `SHA256:${btoa(String.fromCharCode(...bytes))}`
}

const PULL_MS = 4000

type Store = {
  mode: Mode
  appId: string | null
  key: { set: boolean; readable: boolean; verified: boolean | null; fingerprint: string | null }
  installations: GitHubInstallation[]
  generation: number
  /** The fingerprint of a key the environment sets, made once. */
  envFingerprint: string
  running: boolean
  rateLimitedUntil: string | null
  lastRun: GitHubView["lastRun"]
}

function createStore(): Store {
  const mode = mockMode()
  const setUp = mode !== "off"
  const installation = (
    id: number,
    login: string,
    accountType: string,
    state: GitHubInstallation["state"],
    repos: number | null,
  ): GitHubInstallation => ({
    id,
    accountId: id * 7,
    accountType,
    login,
    state: mode === "notread" ? null : state,
    inventory: mode === "notread" || repos === null ? null : { complete: state === "usable", repos },
  })
  return {
    mode,
    appId: setUp ? "1048576" : null,
    key: setUp
      ? { set: true, readable: true, verified: true, fingerprint: fingerprint() }
      : { set: false, readable: true, verified: false, fingerprint: null },
    installations: setUp
      ? [
          installation(51234567, "example-owner", "User", "usable", 14),
          installation(51239876, "example-org", "Organization", mode === "problems" ? "too_broad" : "usable", 9),
        ]
      : [],
    generation: 3,
    envFingerprint: fingerprint(),
    running: false,
    rateLimitedUntil: mode === "problems" ? ago(-0.4) : null,
    lastRun:
      mode === "fine" || mode === "problems"
        ? {
            startedAt: ago(mode === "problems" ? 0.55 : 0.25),
            finishedAt: ago(mode === "problems" ? 0.5 : 0.2),
            outcome: mode === "problems" ? "partial" : "succeeded",
            counts:
              mode === "problems"
                ? {
                    installations: 2,
                    installationsRead: 1,
                    projects: 5,
                    projectsWritten: 3,
                    projectsSkipped: 0,
                    projectsChanged: 2,
                    enabled: 7,
                    not_enabled: 1,
                    no_access: 3,
                    error: 1,
                  }
                : {
                    installations: 2,
                    installationsRead: 2,
                    projects: 5,
                    projectsWritten: 5,
                    projectsSkipped: 0,
                    projectsChanged: 1,
                    enabled: 13,
                    not_enabled: 2,
                    no_access: 0,
                    error: 0,
                  },
            errors:
              mode === "problems"
                ? [
                    { record: "installation:51239876", code: "too_broad" },
                    { record: "project:p:code_scanning", code: "timeout" },
                  ]
                : [],
          }
        : null,
  }
}

let store: Store | null = null
const current = () => {
  store ??= createStore()
  return store
}

function settingsView(s: Store): GitHubView["settings"] {
  const env = lockedVariables()
  const lock = (variable: string) =>
    env.has(variable) ? { locked: true, variable } : { locked: false, variable: null }
  const keyLock = lock("ADIUTOR_GITHUB_PRIVATE_KEY")
  const appLock = lock("ADIUTOR_GITHUB_APP_ID")
  const listLock = lock("ADIUTOR_GITHUB_INSTALLATIONS")
  const key = keyLock.locked ? { set: true, readable: true, verified: null, fingerprint: s.envFingerprint } : s.key
  const appId = appLock.locked ? (s.appId ?? "1048576") : s.appId
  const installations = s.installations.map(({ id, accountId, accountType, login }) => ({
    id,
    accountId,
    accountType,
    login,
  }))
  return {
    appId: { value: appId, ...appLock },
    key: { ...key, ...keyLock },
    installations: { value: installations, ...listLock },
    generation: s.generation,
    on: appId !== null && key.set && key.readable && installations.length > 0,
  }
}

/** The projects with a repository and no current GitHub data: every one before a read, two in "problems". */
function coverage(s: Store, projects: Project[]) {
  const withRepo = projects.filter((project) => project.githubRepo)
  const entry = (project: Project, reason: "no_access" | "stale" | "never") => ({
    id: project.id,
    name: project.name,
    repo: project.githubRepo as string,
    reason,
  })
  if (!s.lastRun) return withRepo.map((project) => entry(project, "never"))
  if (s.mode !== "problems") return []
  return withRepo.slice(0, 2).map((project, index) => entry(project, index === 0 ? "no_access" : "stale"))
}

function status(s: Store, projects: Project[]): GitHubStatus {
  const { on } = settingsView(s)
  if (!on) return { state: "off", notCovered: 0, oldestGoodReadAt: null }
  if (!s.lastRun) return { state: "not_read", notCovered: 0, oldestGoodReadAt: null }
  const missing = coverage(s, projects)
  if (missing.length === 0) return { state: "fine", notCovered: 0, oldestGoodReadAt: null }
  return { state: "not_covered", notCovered: missing.length, oldestGoodReadAt: ago(31) }
}

/** What the morning view says about GitHub. */
export function mockGitHubStatus(projects: Project[]): GitHubStatus {
  return status(current(), projects)
}

function view(projects: Project[]): GitHubView {
  const s = current()
  const settings = settingsView(s)
  const missing = coverage(s, projects)
  const withRepo = projects.filter((project) => project.githubRepo)
  const moved = s.mode === "problems" && s.lastRun ? withRepo.slice(2, 3) : []
  return {
    settings,
    status: status(s, projects),
    running: s.running,
    rateLimitedUntil: s.rateLimitedUntil && s.rateLimitedUntil > new Date().toISOString() ? s.rateLimitedUntil : null,
    lastRun: s.lastRun,
    installations: s.installations,
    notCovered: missing.map((project) => ({
      ...project,
      covered: false as const,
      lastGoodReadAt: project.reason === "stale" ? ago(31) : null,
    })),
    moved: moved.map((project) => ({
      id: project.id,
      name: project.name,
      repo: project.githubRepo,
      movedTo: `example-org/${(project.githubRepo ?? "").split("/")[1] ?? "renamed"}-app`,
    })),
    withoutRepo: projects
      .filter((project) => !project.githubRepo)
      .map((project) => ({ id: project.id, name: project.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

const ok = (data: unknown, status = 200): TransportResponse => ({ status, body: { data } })
const refuse = (status: number, code: string, message: string, details: Record<string, unknown> = {}) => ({
  status,
  body: { error: { code, message, ...details } },
})
const locked = (variable: string) =>
  refuse(409, "setting_locked", `The environment variable ${variable} sets this. Change it there.`, { variable })
const stale = () => refuse(409, "conflict", "The GitHub settings changed meanwhile. Read them again.")

/** The /github routes over the mock store. */
export function githubRoute(
  method: string,
  url: URL,
  parts: string[],
  body: Record<string, unknown>,
  projects: Project[],
): TransportResponse {
  const s = current()
  const [, sub, target] = parts
  const settings = settingsView(s)
  const changed = () => {
    s.generation++
    return ok(view(projects))
  }
  if (!sub && method === "GET") return ok(view(projects))
  if (sub === "app" && method === "PATCH") {
    if (body.generation !== s.generation) return stale()
    if (body.appId !== undefined && settings.appId.locked) return locked("ADIUTOR_GITHUB_APP_ID")
    if (body.privateKey !== undefined && settings.key.locked) return locked("ADIUTOR_GITHUB_PRIVATE_KEY")
    if (typeof body.appId === "string" && !/^[1-9][0-9]{0,15}$/.test(body.appId))
      return refuse(400, "validation_failed", "The App id is the number on the App's settings page.", {
        field: "appId",
      })
    if (typeof body.privateKey === "string" && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(body.privateKey))
      return refuse(400, "github_key_invalid", "This is not a GitHub App private key (a .pem file).", {
        field: "privateKey",
      })
    if (body.appId !== undefined) s.appId = (body.appId as string | null) ?? null
    if (body.privateKey === null) s.key = { set: false, readable: true, verified: false, fingerprint: null }
    else if (typeof body.privateKey === "string")
      s.key = { set: true, readable: true, verified: true, fingerprint: fingerprint() }
    return changed()
  }
  if (sub === "installations" && !target && method === "POST") {
    if (body.generation !== s.generation) return stale()
    if (settings.installations.locked) return locked("ADIUTOR_GITHUB_INSTALLATIONS")
    if (!settings.appId.value || !settings.key.set || !settings.key.readable)
      return refuse(409, "github_not_set_up", "Set the App id and its key before adding an installation.")
    const id = Number(body.installationId)
    if (s.installations.some((installation) => installation.id === id))
      return refuse(409, "conflict", "This installation is already on the list.")
    // An id under 1000 stands for one the App does not have, for screenshots of the refusal.
    if (id < 1000)
      return refuse(422, "github_installation_not_found", "The App has no installation with this id.", {
        field: "installationId",
      })
    s.installations.push({
      id,
      accountId: id * 7,
      accountType: "Organization",
      login: `example-team-${String(id).slice(-3)}`,
      state: null,
      inventory: null,
    })
    return { ...changed(), status: 201 }
  }
  if (sub === "installations" && target && method === "DELETE") {
    if (Number(url.searchParams.get("generation")) !== s.generation) return stale()
    if (settings.installations.locked) return locked("ADIUTOR_GITHUB_INSTALLATIONS")
    const id = Number(target)
    if (!s.installations.some((installation) => installation.id === id))
      return refuse(404, "not_found", "This installation is not on the list.")
    s.installations = s.installations.filter((installation) => installation.id !== id)
    return changed()
  }
  if (sub === "pull" && method === "POST") {
    if (s.running) return ok({ joined: true, view: view(projects) }, 202)
    if (!settings.on) return refuse(409, "github_not_set_up", "Set the App id, its key and an installation first.")
    const until = view(projects).rateLimitedUntil
    if (until) return refuse(429, "github_rate_limited", "GitHub asked to wait before the next read.", { until })
    s.running = true
    const startedAt = new Date().toISOString()
    setTimeout(() => {
      s.running = false
      s.mode = s.mode === "notread" ? "fine" : s.mode
      for (const installation of s.installations) {
        if (installation.state === null) installation.state = "usable"
        if (installation.state === "usable") installation.inventory = { complete: true, repos: 6 }
      }
      const problems = s.mode === "problems"
      s.lastRun = {
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: problems ? "partial" : "succeeded",
        counts: {
          installations: s.installations.length,
          installationsRead: s.installations.filter((i) => i.state === "usable").length,
          projects: 5,
          projectsWritten: problems ? 3 : 5,
          projectsSkipped: 0,
          projectsChanged: 1,
          enabled: problems ? 7 : 13,
          not_enabled: problems ? 1 : 2,
          no_access: problems ? 3 : 0,
          error: problems ? 1 : 0,
        },
        errors: s.installations
          .filter((installation) => installation.state !== "usable")
          .map((installation) => ({ record: `installation:${installation.id}`, code: installation.state ?? "error" })),
      }
    }, PULL_MS)
    return ok({ joined: false, view: view(projects) }, 202)
  }
  return refuse(404, "not_found", "Nothing is here.")
}
