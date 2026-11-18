import { asc, eq, inArray, isNotNull } from "drizzle-orm"
import { projects, securitySources, syncRuns } from "../db/schema.ts"
import type { DbOrTx } from "../services/context.ts"
import { GITHUB_RUN_KIND } from "./apply.ts"
import { ALERT_FAMILIES } from "./pull.ts"

// Whether the security data the board and the morning message show really comes from GitHub and is current, from
// what is stored, so "all clear" is never shown while nothing was checked. A project with a repository is covered
// when each alert family and its Issues count were read from GitHub (origin `github`) within 26 hours, and its
// families are not all `no_access`.

/** Data older than this is stale (as STALE_AFTER_MS in services/reads.ts). */
const COVERED_FOR_MS = 26 * 60 * 60 * 1000

/**
 * `off`: GitHub is not set up. `not_read`: set up, and no pull ever finished and no project is covered.
 * `not_covered`: some projects with a repository are not covered. `fine`: every one is.
 */
export type GitHubState = "off" | "not_read" | "not_covered" | "fine"

/** Why a project is not covered: no access to any family, some data older than 26 hours, or none from GitHub yet. */
export type NotCoveredReason = "no_access" | "stale" | "never"

export type GitHubStatus = {
  state: GitHubState
  /** Projects with a repository that are not covered. */
  notCovered: number
  /** The oldest last good read from GitHub among them; null when none of them was ever read. */
  oldestGoodReadAt: Date | null
}

export type ProjectCoverage = {
  id: string
  name: string
  repo: string
  covered: boolean
  reason: NotCoveredReason | null
  /** The oldest as-of time of its data from GitHub; null when part of it never came from GitHub. */
  lastGoodReadAt: Date | null
}

export async function gitHubCoverage(
  db: DbOrTx,
  now: Date,
  on: boolean,
): Promise<{ status: GitHubStatus; projects: ProjectCoverage[] }> {
  const withRepo = await db
    .select({
      id: projects.id,
      name: projects.name,
      repo: projects.githubRepo,
      issuesOrigin: projects.openIssuesOrigin,
      issuesAsOf: projects.openIssuesAsOf,
    })
    .from(projects)
    .where(isNotNull(projects.githubRepo))
    .orderBy(asc(projects.name))
  const ids = withRepo.map((p) => p.id)
  const sources =
    ids.length === 0 ? [] : await db.select().from(securitySources).where(inArray(securitySources.projectId, ids))
  const fresh = (asOf: Date | null) => asOf !== null && now.getTime() - asOf.getTime() <= COVERED_FOR_MS
  const list: ProjectCoverage[] = withRepo.map((p) => {
    const own = ALERT_FAMILIES.map((family) => sources.find((s) => s.projectId === p.id && s.family === family))
    const fromGitHub = own.map((s) => (s?.origin === "github" ? s.asOf : null))
    const issues = p.issuesOrigin === "github" ? p.issuesAsOf : null
    const times = [...fromGitHub, issues]
    const allNoAccess = own.every((s) => s?.origin === "github" && s.coverage === "no_access")
    const covered = times.every(fresh) && !allNoAccess
    const known = times.filter((t): t is Date => t !== null)
    const reason: NotCoveredReason | null = covered
      ? null
      : allNoAccess
        ? "no_access"
        : known.length === 0
          ? "never"
          : "stale"
    return {
      id: p.id,
      name: p.name,
      repo: p.repo as string,
      covered,
      reason,
      lastGoodReadAt: known.length === times.length ? new Date(Math.min(...known.map((t) => t.getTime()))) : null,
    }
  })
  const notCovered = list.filter((p) => !p.covered)
  let state: GitHubState
  if (!on) state = "off"
  else if (notCovered.length === 0) state = "fine"
  else {
    const [run] = await db.select({ id: syncRuns.id }).from(syncRuns).where(eq(syncRuns.kind, GITHUB_RUN_KIND)).limit(1)
    state = !run && notCovered.length === list.length ? "not_read" : "not_covered"
  }
  const reads = notCovered.flatMap((p) => (p.lastGoodReadAt ? [p.lastGoodReadAt.getTime()] : []))
  return {
    status: {
      state,
      notCovered: state === "not_covered" ? notCovered.length : 0,
      oldestGoodReadAt: state === "not_covered" && reads.length > 0 ? new Date(Math.min(...reads)) : null,
    },
    projects: list,
  }
}
