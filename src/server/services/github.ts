import { asc, desc, eq, isNull } from "drizzle-orm"
import { GITHUB_ID } from "../config.ts"
import { projects, type StoredInstallation, settings, syncRuns } from "../db/schema.ts"
import { AppError, invalid } from "../errors.ts"
import { GITHUB_RUN_KIND } from "../github/apply.ts"
import { appClient } from "../github/client.ts"
import { describeFailure } from "../github/errors.ts"
import { type GitHubGate, lockGitHubExclusive } from "../github/gate.ts"
import { keyFingerprint, normalizeKey, pkcs8, readPrivateKey } from "../github/key.ts"
import type { InstallationState } from "../github/pull.ts"
import type { GitHubRunner } from "../github/runner.ts"
import { effectiveGitHub, GITHUB_KEY_COLUMN } from "../github/settings.ts"
import { gitHubCoverage } from "../github/status.ts"
import { auditableSettings, getSettings, type SettingsEnv, type SettingsRow } from "./admin.ts"
import { type By, type Ctx, requireOwner, writeAudit } from "./context.ts"

// The owner's saves of the GitHub settings: the App id and its private key, and the installations the server may
// read. Each save names the generation it was based on, checks what it can with GitHub first (outside any lock), and
// then commits through the gate (github/gate.ts): one at a time, under the exclusive GitHub lock, raising the
// generation, so a pull running under the old settings sends and writes nothing more.

/** How long a save waits for GitHub before it counts as unreachable. */
const CHECK_TIMEOUT_MS = 10_000

export type GitHubDeps = { env: SettingsEnv; gate: GitHubGate; origin: string }

const locked = (variable: string) =>
  new AppError(
    "setting_locked",
    `The environment variable ${variable} sets this. Change it there and restart Adiutor.`,
    {
      variable,
    },
  )

const unreachable = () => new AppError("github_unreachable", "GitHub did not answer. Try again in a minute.")
const rejected = () =>
  new AppError("github_key_rejected", "GitHub did not accept this key for the App. Check the App id and the key.")

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

/** Asks GitHub, as the App, for the App itself: whether the key is the App's. */
async function checkKey(origin: string, appId: string, privateKey: string): Promise<"ok" | "unreachable"> {
  const app = appClient({ origin, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }, appId, privateKey)
  try {
    const { data } = await app.request("GET /app")
    if (!isObject(data) || String(data.id) !== appId)
      throw new AppError("github_app_mismatch", "The key belongs to another GitHub App than the App id.")
    return "ok"
  } catch (error) {
    if (error instanceof AppError) throw error
    const failure = describeFailure(error, new Date())
    if (failure.kind === "status" && failure.status >= 400 && failure.status < 500 && failure.status !== 429)
      throw rejected()
    return "unreachable"
  }
}

/** Commits a change of GitHub fields at the generation it was based on, with its audit row. */
async function commit(
  ctx: Ctx,
  by: By,
  deps: GitHubDeps,
  basedOn: number,
  change: (row: SettingsRow) => Partial<SettingsRow>,
  note?: Record<string, unknown>,
): Promise<SettingsRow> {
  await getSettings(ctx.db)
  return deps.gate.save(async () => {
    const after = await ctx.db.transaction(async (tx) => {
      await lockGitHubExclusive(tx)
      const before = await getSettings(tx)
      if (before.githubGeneration !== basedOn)
        throw new AppError("conflict", "The GitHub settings changed meanwhile. Read them again.", {
          generation: before.githubGeneration,
        })
      const [row] = await tx
        .update(settings)
        .set({ ...change(before), githubGeneration: before.githubGeneration + 1, updatedAt: ctx.clock() })
        .where(eq(settings.id, 1))
        .returning()
      if (!row) throw new Error("settings row missing")
      await writeAudit(ctx, tx, by, {
        action: "settings.update",
        entityType: "settings",
        entityId: "1",
        before: auditableSettings(before),
        after: { ...auditableSettings(row), ...note },
      })
      return row
    })
    return { result: after, generation: after.githubGeneration }
  })
}

export type GitHubAppPatch = {
  /** The generation the owner's view was based on. */
  generation: number
  appId?: string | null
  /** A new private key (PEM), or null to remove the stored one. Never returned or audited. */
  privateKey?: string | null
}

/**
 * Saves the App id, the key, or both. A key is read locally first; then, when an App id and a key will be in effect,
 * GitHub is asked for the App: a refusal refuses the save, another App refuses it, and no answer saves a first key
 * as not verified yet but never replaces a key GitHub accepted.
 */
export async function saveGitHubApp(ctx: Ctx, by: By, deps: GitHubDeps, patch: GitHubAppPatch): Promise<SettingsRow> {
  requireOwner(by, "change the GitHub settings")
  const { overrides, cipher } = deps.env
  if (patch.appId !== undefined && overrides.githubAppId !== undefined) throw locked("ADIUTOR_GITHUB_APP_ID")
  if (patch.privateKey !== undefined && overrides.githubPrivateKey !== undefined)
    throw locked("ADIUTOR_GITHUB_PRIVATE_KEY")
  if (patch.appId !== undefined && patch.appId !== null && !GITHUB_ID.test(patch.appId))
    throw invalid("The App id is the number on the App's settings page.", { field: "appId" })
  const current = effectiveGitHub(await getSettings(ctx.db), overrides, cipher)
  if (patch.privateKey === null && current.meantOn)
    throw new AppError(
      "github_key_required",
      "An environment variable turns GitHub on, so the key cannot be removed. Paste a new key instead.",
    )

  let key: { pem: string; fingerprint: string } | null | undefined
  if (patch.privateKey !== undefined && patch.privateKey !== null) {
    const read = readPrivateKey(patch.privateKey)
    if ("problem" in read)
      throw new AppError("github_key_invalid", "This is not a GitHub App private key (a .pem file).", {
        field: "privateKey",
      })
    key = { pem: pkcs8(read.key), fingerprint: keyFingerprint(read.key) }
  } else if (patch.privateKey === null) key = null

  const appId = patch.appId !== undefined ? patch.appId : current.appId
  const pem = key !== undefined ? (key?.pem ?? null) : current.privateKey
  let verified: boolean | undefined
  if (appId && pem && (patch.appId !== undefined || key !== undefined)) {
    const answer = await checkKey(deps.origin, appId, pem)
    if (answer === "ok") verified = true
    else if (key && current.view.key.verified === true) throw unreachable()
    else verified = false
  }

  return commit(
    ctx,
    by,
    deps,
    patch.generation,
    (before) => {
      // Read again under the lock: a pull may have marked the stored key verified while GitHub was being asked.
      if (key && verified === false && before.githubPrivateKeyEnc !== null && before.githubKeyVerified)
        throw unreachable()
      return {
        ...(patch.appId !== undefined ? { githubAppId: patch.appId } : {}),
        ...(key !== undefined
          ? {
              githubPrivateKeyEnc: key ? cipher.encrypt(GITHUB_KEY_COLUMN, normalizeKey(key.pem)) : null,
              githubKeyFingerprint: key?.fingerprint ?? null,
            }
          : {}),
        ...(verified !== undefined
          ? { githubKeyVerified: verified }
          : key === null
            ? { githubKeyVerified: false }
            : {}),
      }
    },
    key !== undefined ? { githubKeyChange: key ? "replaced" : "removed" } : undefined,
  )
}

/**
 * Adds an installation to the allow-list by its id (from the address of its settings page on GitHub). The server
 * asks GitHub for that one installation as the App and stores the account it is bound to; it never lists the App's
 * installations, so a stranger's installation is never offered or read.
 */
export async function addGitHubInstallation(
  ctx: Ctx,
  by: By,
  deps: GitHubDeps,
  input: { generation: number; installationId: number },
): Promise<SettingsRow> {
  requireOwner(by, "change the GitHub settings")
  const { overrides, cipher } = deps.env
  if (overrides.githubInstallations !== undefined) throw locked("ADIUTOR_GITHUB_INSTALLATIONS")
  if (!GITHUB_ID.test(String(input.installationId)))
    throw invalid("The installation id is the number at the end of the installation's address.", {
      field: "installationId",
    })
  const current = effectiveGitHub(await getSettings(ctx.db), overrides, cipher)
  if (!current.appId || !current.privateKey)
    throw new AppError("github_not_set_up", "Set the App id and its key before adding an installation.")
  if (current.installations.some((i) => i.id === input.installationId))
    throw new AppError("conflict", "This installation is already on the list.")
  const app = appClient(
    { origin: deps.origin, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) },
    current.appId,
    current.privateKey,
  )
  let data: unknown
  try {
    ;({ data } = await app.request("GET /app/installations/{installation_id}", {
      installation_id: input.installationId,
    }))
  } catch (error) {
    const failure = describeFailure(error, new Date())
    if (failure.kind === "status" && failure.status === 404)
      throw new AppError("github_installation_not_found", "The App has no installation with this id.", {
        field: "installationId",
      })
    if (failure.kind === "status" && failure.status === 401) throw rejected()
    throw unreachable()
  }
  const account = isObject(data) && isObject(data.account) ? data.account : null
  if (
    !isObject(data) ||
    data.id !== input.installationId ||
    !account ||
    typeof account.id !== "number" ||
    typeof account.type !== "string"
  )
    throw unreachable()
  const entry: StoredInstallation = {
    id: input.installationId,
    accountId: account.id,
    accountType: account.type,
    login: typeof account.login === "string" ? account.login.slice(0, 100) : "",
  }
  return commit(ctx, by, deps, input.generation, (row) => ({
    githubInstallations: [...row.githubInstallations.filter((i) => i.id !== entry.id), entry],
  }))
}

/**
 * Removes an installation from the allow-list: the server stops reading it at once. The UI then asks the owner to
 * uninstall the App from that account on GitHub too, so a database restored from before the removal cannot read it.
 */
export async function removeGitHubInstallation(
  ctx: Ctx,
  by: By,
  deps: GitHubDeps,
  input: { generation: number; installationId: number },
): Promise<SettingsRow> {
  requireOwner(by, "change the GitHub settings")
  if (deps.env.overrides.githubInstallations !== undefined) throw locked("ADIUTOR_GITHUB_INSTALLATIONS")
  const row = await getSettings(ctx.db)
  if (!row.githubInstallations.some((i) => i.id === input.installationId))
    throw new AppError("not_found", "This installation is not on the list.")
  return commit(ctx, by, deps, input.generation, (before) => ({
    githubInstallations: before.githubInstallations.filter((i) => i.id !== input.installationId),
  }))
}

const INSTALLATION_STATES: readonly string[] = ["usable", "too_broad", "suspended", "uninstalled", "other_account"]

/**
 * Settings, GitHub: the settings in effect (the key only as its fingerprint), the GitHub status, the pulls of this
 * process and the last one recorded, each allowed installation's state, and the projects without a repository or not
 * covered.
 */
export async function gitHubView(ctx: Ctx, deps: GitHubDeps, runner: GitHubRunner) {
  const now = ctx.clock()
  const row = await getSettings(ctx.db)
  const github = effectiveGitHub(row, deps.env.overrides, deps.env.cipher)
  const [lastRun] = await ctx.db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.kind, GITHUB_RUN_KIND))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1)
  const coverage = await gitHubCoverage(ctx.db, now, github.on)
  const withoutRepo = await ctx.db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(isNull(projects.githubRepo))
    .orderBy(asc(projects.name))
  const named = await ctx.db.select({ id: projects.id, name: projects.name, repo: projects.githubRepo }).from(projects)
  const pulls = runner.state()
  const installations = github.installations.map((installation) => {
    const read = pulls.last?.installations.find((i) => i.id === installation.id)
    const recorded = lastRun?.errors.find((e) => e.record === `installation:${installation.id}`)
    // This process's last pull knows each state; after a restart the run row names those that were not read in full.
    const state: InstallationState | null = read
      ? read.state
      : recorded
        ? INSTALLATION_STATES.includes(recorded.code)
          ? (recorded.code as InstallationState)
          : "error"
        : null
    return {
      ...installation,
      login: read?.login ?? installation.login,
      state,
      inventory: read?.inventory ?? null,
    }
  })
  return {
    settings: github.view,
    status: coverage.status,
    running: pulls.running,
    rateLimitedUntil: pulls.rateLimitedUntil,
    lastRun: lastRun
      ? {
          startedAt: lastRun.startedAt,
          finishedAt: lastRun.finishedAt,
          outcome: lastRun.outcome,
          counts: lastRun.counts,
          errors: lastRun.errors,
        }
      : null,
    installations,
    notCovered: coverage.projects.filter((p) => !p.covered),
    /** Repositories the last pull found only by their id: renamed or moved, the owner updates the project. */
    moved: (pulls.last?.moved ?? []).flatMap((m) => {
      const p = named.find((row) => row.id === m.projectId)
      // Only while the project is still bound to the repository the pull read: an edit since then answered it.
      return p && p.repo === m.from ? [{ id: p.id, name: p.name, repo: p.repo, movedTo: m.to }] : []
    }),
    withoutRepo,
  }
}
