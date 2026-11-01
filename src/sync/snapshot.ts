import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { asArray, asCount, asObject, asString, asTime, type JsonObject, parseJson } from "./json.ts"

// Reads the overview collector's newest snapshot and turns each GitHub repository into the security
// payload. A family that is stale keeps its counts with the time of its last successful read; a
// family that is missing or unreadable is reported as unknown or error, never as zero alerts.

export const FAMILIES = [
  { family: "dependabot", key: "dependabot" },
  { family: "code_scanning", key: "codeScanning" },
  { family: "secret_scanning", key: "secretScanning" },
] as const

export type Family = (typeof FAMILIES)[number]["family"]
export type Coverage = "enabled" | "not_enabled" | "no_access" | "error" | "unknown"
export type Counts = { critical: number; high: number; medium: number; low: number }
export type FamilyReport = { family: Family; coverage: Coverage; counts: Counts; asOf: string | null }
export type RepoReport = {
  repo: string
  openIssues: number | null
  issuesAsOf: string | null
  families: FamilyReport[]
}

const COVERAGE: Record<string, Coverage> = {
  enabled: "enabled",
  "not-enabled": "not_enabled",
  "no-access": "no_access",
  error: "error",
}

// The collector also writes code scanning rule levels (error, warning, note) and unknown. They are
// counted, never dropped: error and unknown as medium, warning and note as low.
const SEVERITY: Record<string, keyof Counts> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  error: "medium",
  unknown: "medium",
  warning: "low",
  note: "low",
}

const zero = (): Counts => ({ critical: 0, high: 0, medium: 0, low: 0 })

const staleSince = (record: JsonObject | undefined) => asTime(asObject(record?.stale)?.since)

export function mapFamily(family: Family, value: unknown, repoStaleSince: string | null): FamilyReport {
  const data = asObject(value)
  if (!data) return { family, coverage: "unknown", counts: zero(), asOf: null }
  const coverage = COVERAGE[asString(data.status) ?? ""] ?? "unknown"
  const counts = zero()
  if (coverage === "enabled") {
    for (const alert of asArray(data.alerts)) {
      const severity = asString(asObject(alert)?.severity)?.toLowerCase() ?? "unknown"
      counts[SEVERITY[severity] ?? "medium"] += 1
    }
  }
  // The time of the last successful read, never the time of this sync. An error or an unknown status
  // has no successful read behind it.
  const asOf =
    coverage === "error" || coverage === "unknown"
      ? null
      : (staleSince(data) ?? repoStaleSince ?? asTime(data.succeededAt))
  return { family, coverage, counts, asOf }
}

export function mapRepo(repo: string, entry: JsonObject): RepoReport {
  const repoStale = staleSince(entry)
  const source = asObject(entry.source)
  const openIssues = asCount(entry.openIssues) ?? null
  const issuesAsOf =
    openIssues === null ? null : (repoStale ?? asTime(source?.lastSuccessAt) ?? asTime(source?.succeededAt))
  const security = asObject(entry.security)
  return {
    repo,
    openIssues,
    issuesAsOf,
    families: FAMILIES.map(({ family, key }) => mapFamily(family, security?.[key], repoStale)),
  }
}

export type Snapshot = {
  runId: string
  finishedAt: string | null
  /** GitHub repositories by lower-case full name. */
  github: Map<string, JsonObject>
  local: JsonObject[]
}

export function parseSnapshot(data: unknown, runId: string): Snapshot {
  const root = asObject(data)
  if (!root) throw new Error("the snapshot is not a JSON object")
  const github = new Map<string, JsonObject>()
  for (const item of asArray(root.github)) {
    const entry = asObject(item)
    const fullName = asString(entry?.fullName)
    if (entry && fullName) github.set(fullName.toLowerCase(), entry)
  }
  const local = asArray(root.local)
    .map(asObject)
    .filter((x): x is JsonObject => x !== undefined)
  return { runId, finishedAt: asTime(root.finishedAt), github, local }
}

/** The security payload for the given repositories; those absent from the snapshot are listed apart. */
export function securityReports(
  snapshot: Snapshot,
  repos: Iterable<string>,
): { reports: RepoReport[]; missing: string[] } {
  const reports: RepoReport[] = []
  const missing: string[] = []
  const seen = new Set<string>()
  for (const repo of repos) {
    const key = repo.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const found = snapshot.github.get(key)
    // Named as in the projects payload, so both payloads spell a repository the same way.
    if (found) reports.push(mapRepo(repo, found))
    else missing.push(repo)
  }
  return { reports, missing }
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The newest snapshot of an overview checkout: the run named in data/latest-run.txt, or else the
 * newest run directory that holds a readable snapshot.
 */
export async function readLatestSnapshot(overviewDir: string): Promise<Snapshot> {
  const dataDir = join(overviewDir, "data")
  const runsDir = join(dataDir, "runs")
  const tryRun = async (runId: string): Promise<Snapshot | undefined> => {
    if (!RUN_ID.test(runId)) return undefined
    try {
      const text = await readFile(join(runsDir, runId, "snapshot.json"), "utf8")
      return parseSnapshot(parseJson(text, "the snapshot"), runId)
    } catch {
      return undefined
    }
  }

  let latest = ""
  try {
    latest = (await readFile(join(dataDir, "latest-run.txt"), "utf8")).trim()
  } catch {
    // Fall back to the run directories.
  }
  const named = latest ? await tryRun(latest) : undefined
  if (named) return named

  let runs: string[] = []
  try {
    runs = (await readdir(runsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    throw new Error("no overview snapshot found (data/runs is missing)")
  }
  for (const runId of runs.sort().reverse()) {
    const snapshot = await tryRun(runId)
    if (snapshot) return snapshot
  }
  throw new Error("no readable overview snapshot found")
}
