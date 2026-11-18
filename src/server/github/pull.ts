import type { AllowedInstallation } from "./settings.ts"
import { appClient, type FetchGuard, installationClient, type Octokit } from "./client.ts"
import { describeFailure, type Failure, failureCode, graphqlRateLimit } from "./errors.ts"

// One pull's reading: everything is read into memory first, under the generation the pull started with; nothing is
// written here (github/apply.ts writes it in one transaction). Requests go one installation after another, four
// repositories at a time, each page asked with explicit parameters.

/** The alert families the server reads; `overview` (the PC's old collector) is never read. */
export const ALERT_FAMILIES = ["dependabot", "code_scanning", "secret_scanning"] as const
export type AlertFamily = (typeof ALERT_FAMILIES)[number]

/** The read permissions the App may hold. An installation granted anything else is too broad and never read. */
export const READ_PERMISSIONS = [
  "vulnerability_alerts",
  "security_events",
  "secret_scanning_alerts",
  "issues",
  "metadata",
] as const

/** The permission each read needs. */
const PERMISSION: Record<AlertFamily | "issues", (typeof READ_PERMISSIONS)[number]> = {
  dependabot: "vulnerability_alerts",
  code_scanning: "security_events",
  secret_scanning: "secret_scanning_alerts",
  issues: "issues",
}

const ROUTES = {
  dependabot: "GET /repos/{owner}/{repo}/dependabot/alerts",
  code_scanning: "GET /repos/{owner}/{repo}/code-scanning/alerts",
  secret_scanning: "GET /repos/{owner}/{repo}/secret-scanning/alerts",
} as const

const PER_PAGE = 100
/** A list longer than this many pages is not believed: the family is `error`. */
const MAX_PAGES = 50
const REPOS_AT_ONCE = 4
const ISSUES_PER_QUERY = 25

export type Counts = { critical: number; high: number; medium: number; low: number }
export type FamilyRead =
  | { coverage: "enabled"; counts: Counts; asOf: Date }
  | { coverage: "not_enabled" | "no_access"; asOf: Date }
  | { coverage: "error"; code: string }
export type IssuesRead =
  | { kind: "count"; count: number; asOf: Date }
  | { kind: "cleared"; asOf: Date }
  | { kind: "error"; code: string }

/**
 * An allowed installation as this pull found it. `usable` is read; `too_broad`, `suspended`, `uninstalled` and
 * `other_account` are definitely not usable; `error` is unknown (it could not be checked, or its token or inventory
 * failed).
 */
export type InstallationState = "usable" | "too_broad" | "suspended" | "uninstalled" | "other_account" | "error"

export type InstallationRead = {
  id: number
  state: InstallationState
  /** Why it is `error`: a stable code. */
  code: string | null
  login: string | null
  accountType: string | null
  /** The inventory of a usable installation: complete only when every page answered and the count matched. */
  inventory: { complete: boolean; repos: number } | null
}

export type ProjectInput = {
  id: string
  githubRepo: string
  githubRepoVersion: number
  githubRepoId: number | null
}

export type ProjectRead = {
  projectId: string
  /** The repository binding version the pull read the project under (github/apply.ts skips a changed one). */
  version: number
  repo: string
  /** GitHub's id of the repository from the inventory that matched, to keep on the project; null when none did. */
  repoId: number | null
  families: Record<AlertFamily, FamilyRead>
  issues: IssuesRead
  /** The repository's new name, when only its id was found (renamed or moved): the owner updates the project. */
  movedTo: string | null
}

export type PullInput = {
  appId: string
  privateKey: string
  installations: AllowedInstallation[]
  projects: ProjectInput[]
}

export type PullOptions = FetchGuard & { clock: () => Date }

/** Why the pull stopped sending before its end. `superseded` and `aborted` write nothing. */
export type StopReason = { kind: "rate_limit"; until: Date } | { kind: "superseded" } | { kind: "aborted" }

export type PullRead = {
  /** True when an App call was answered, false when GitHub refused the key (401), null when neither happened. */
  keyAccepted: boolean | null
  installations: InstallationRead[]
  projects: ProjectRead[]
  stopped: StopReason | null
}

const zero = (): Counts => ({ critical: 0, high: 0, medium: 0, low: 0 })
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Dependabot: the advisory's severity, else the vulnerability's; an unknown one counts as medium. */
function dependabotSeverity(alert: Record<string, unknown>): keyof Counts {
  const advisory = isObject(alert.security_advisory) ? alert.security_advisory.severity : undefined
  const vulnerability = isObject(alert.security_vulnerability) ? alert.security_vulnerability.severity : undefined
  const level = String(advisory ?? vulnerability ?? "").toLowerCase()
  if (level === "critical" || level === "high" || level === "low") return level
  return "medium"
}

/** Code scanning: the security severity, else the rule's severity: error and unknown are medium, warning and note low. */
function codeScanningSeverity(alert: Record<string, unknown>): keyof Counts {
  const rule = isObject(alert.rule) ? alert.rule : {}
  const level = String(rule.security_severity_level ?? rule.severity ?? "").toLowerCase()
  if (level === "critical" || level === "high" || level === "medium" || level === "low") return level
  if (level === "warning" || level === "note" || level === "none") return "low"
  return "medium"
}

const severity: Record<AlertFamily, (alert: Record<string, unknown>) => keyof Counts> = {
  dependabot: dependabotSeverity,
  code_scanning: codeScanningSeverity,
  // A leaked secret counts as high (docs/api.md).
  secret_scanning: () => "high",
}

/** The `rel="next"` address of a `Link` header, or null. */
function nextLink(link: unknown): string | null {
  if (typeof link !== "string") return null
  for (const part of link.split(",")) {
    const match = /<([^<>]+)>\s*;\s*rel="?next"?/.exec(part)
    if (match?.[1]) return match[1]
  }
  return null
}

/** The permissions an installation was granted are all within the five read permissions. */
export function withinReadPermissions(permissions: Record<string, unknown>): boolean {
  return Object.entries(permissions).every(
    ([name, level]) => (READ_PERMISSIONS as readonly string[]).includes(name) && level === "read",
  )
}

/** The permissions named in an `X-Accepted-GitHub-Permissions` header. */
const acceptedPermissions = (header: string | undefined) => [...(header ?? "").matchAll(/([a-z_]+)=/g)].map((m) => m[1])

type Usable = { read: InstallationRead; granted: Record<string, string>; client: Octokit | null }

/** Runs `work` over `list`, at most `limit` at a time. */
async function pool<T>(list: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const item = list[next++] as T
      await work(item)
    }
  })
  await Promise.all(runners)
}

export async function readGitHub(input: PullInput, options: PullOptions): Promise<PullRead> {
  const now = () => options.clock()
  const app = appClient(options, input.appId, input.privateKey)
  const result: PullRead = { keyAccepted: null, installations: [], projects: [], stopped: null }

  /** Records a failure that stops the whole pull; answers the code to record for the read it ended. */
  const stopOn = (failure: Failure): string | null => {
    if (failure.kind === "rate_limit") result.stopped ??= { kind: "rate_limit", until: failure.until }
    else if (failure.kind === "aborted") result.stopped ??= { kind: "aborted" }
    else if (failure.kind === "refused" && failure.code === "superseded") result.stopped ??= { kind: "superseded" }
    else return null
    return failureCode(failure)
  }
  const stoppedCode = () =>
    result.stopped?.kind === "rate_limit" ? "rate_limited" : result.stopped ? result.stopped.kind : null

  // 1. The allowed installations, each as the App sees it.
  const usable: Usable[] = []
  for (const allowed of input.installations) {
    const read: InstallationRead = {
      id: allowed.id,
      state: "error",
      code: null,
      login: allowed.login,
      accountType: allowed.accountType,
      inventory: null,
    }
    result.installations.push(read)
    const stop = stoppedCode()
    if (stop) {
      read.code = stop
      continue
    }
    if (result.keyAccepted === false) {
      read.code = "key_rejected"
      continue
    }
    let data: unknown
    try {
      ;({ data } = await app.request("GET /app/installations/{installation_id}", { installation_id: allowed.id }))
      result.keyAccepted = true
    } catch (error) {
      const failure = describeFailure(error, now())
      read.code = stopOn(failure) ?? failureCode(failure)
      if (failure.kind === "status" && failure.status === 404) {
        // The App's JWT was accepted: the installation is gone.
        result.keyAccepted = true
        read.state = "uninstalled"
        read.code = null
      } else if (failure.kind === "status" && failure.status === 401) {
        result.keyAccepted = false
        read.code = "key_rejected"
      }
      continue
    }
    const account = isObject(data) && isObject(data.account) ? data.account : null
    const permissions = isObject(data) && isObject(data.permissions) ? data.permissions : null
    if (
      !isObject(data) ||
      data.id !== allowed.id ||
      !account ||
      typeof account.id !== "number" ||
      typeof account.type !== "string" ||
      !permissions
    ) {
      read.code = "malformed"
      continue
    }
    read.login = typeof account.login === "string" ? account.login : read.login
    read.accountType = account.type
    if (allowed.accountId !== null && (account.id !== allowed.accountId || account.type !== allowed.accountType))
      read.state = "other_account"
    else if (data.suspended_at) read.state = "suspended"
    else if (!withinReadPermissions(permissions)) read.state = "too_broad"
    else {
      read.state = "usable"
      usable.push({ read, granted: permissions as Record<string, string>, client: null })
    }
  }

  // 2. A token and the inventory of each usable installation. The token is asked with the read permissions the
  // installation holds and nothing else, so it never carries more even if the installation's permissions grew.
  const byName = new Map<string, { installation: Usable; id: number }>()
  const byId = new Map<number, string>()
  for (const installation of usable) {
    const { read, granted } = installation
    const stop = stoppedCode()
    if (stop) {
      read.state = "error"
      read.code = stop
      continue
    }
    const permissions = Object.fromEntries(
      READ_PERMISSIONS.filter((name) => granted[name] === "read").map((name) => [name, "read"]),
    )
    try {
      const auth = await app.auth({ type: "installation", installationId: read.id, permissions })
      installation.client = installationClient(options, (auth as { token: string }).token)
    } catch (error) {
      const failure = describeFailure(error, now())
      read.state = "error"
      read.code = stopOn(failure) ?? failureCode(failure)
      continue
    }
    const seen = new Map<number, string>()
    let total: number | null = null
    let complete = false
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (stoppedCode()) break
      let response: { data: unknown; headers: Record<string, unknown> }
      try {
        response = await installation.client.request("GET /installation/repositories", { per_page: PER_PAGE, page })
      } catch (error) {
        const failure = describeFailure(error, now())
        read.code = stopOn(failure) ?? failureCode(failure)
        break
      }
      const data = response.data
      const repositories = isObject(data) && Array.isArray(data.repositories) ? data.repositories : null
      if (!isObject(data) || typeof data.total_count !== "number" || !repositories) {
        read.code = "malformed"
        break
      }
      let malformed = false
      for (const repo of repositories) {
        if (!isObject(repo) || typeof repo.id !== "number" || typeof repo.full_name !== "string") malformed = true
        else seen.set(repo.id, repo.full_name)
      }
      if (malformed) {
        read.code = "malformed"
        break
      }
      total = data.total_count
      if (!nextLink(response.headers.link)) {
        complete = seen.size === total
        if (!complete) read.code = "inventory_count"
        break
      }
    }
    read.inventory = { complete, repos: seen.size }
    for (const [id, fullName] of seen) {
      const key = fullName.toLowerCase()
      if (!byName.has(key)) byName.set(key, { installation, id })
      if (!byId.has(id)) byId.set(id, fullName)
    }
  }

  // Whether every allowed installation is known: read in full, or definitely not usable. Only then is a repository
  // found in none of them `no_access`; otherwise it may be in the part that was not read.
  const allKnown = result.installations.every(
    (i) => (i.state === "usable" && i.inventory?.complete === true) || (i.state !== "usable" && i.state !== "error"),
  )

  // 3. Each project with a repository: where it is read, or why not.
  type Planned = { project: ProjectRead; installation: Usable | null; owner: string; name: string }
  const planned: Planned[] = []
  for (const p of input.projects) {
    const [owner, name, ...rest] = p.githubRepo.split("/")
    const errorAll = (code: string) => ({
      dependabot: { coverage: "error", code },
      code_scanning: { coverage: "error", code },
      secret_scanning: { coverage: "error", code },
    }) as Record<AlertFamily, FamilyRead>
    const project: ProjectRead = {
      projectId: p.id,
      version: p.githubRepoVersion,
      repo: p.githubRepo,
      repoId: null,
      families: errorAll("not_read"),
      issues: { kind: "error", code: "not_read" },
      movedTo: null,
    }
    result.projects.push(project)
    if (!owner || !name || rest.length > 0) {
      project.families = errorAll("bad_repo")
      project.issues = { kind: "error", code: "bad_repo" }
      continue
    }
    const hit = byName.get(p.githubRepo.toLowerCase())
    if (hit) {
      project.repoId = hit.id
      planned.push({ project, installation: hit.installation, owner, name })
      continue
    }
    const movedTo = p.githubRepoId !== null ? byId.get(p.githubRepoId) : undefined
    if (movedTo !== undefined) {
      project.movedTo = movedTo
      project.families = errorAll("moved")
      project.issues = { kind: "error", code: "moved" }
    } else if (allKnown) {
      const asOf = now()
      project.families = {
        dependabot: { coverage: "no_access", asOf },
        code_scanning: { coverage: "no_access", asOf },
        secret_scanning: { coverage: "no_access", asOf },
      }
      project.issues = { kind: "cleared", asOf }
    }
  }

  /** The App's answer for a repository's installation: whether it is this one (a family that is off answers 404). */
  const installedHere = async (owner: string, name: string, installationId: number): Promise<string | null> => {
    try {
      const { data } = await app.request("GET /repos/{owner}/{repo}/installation", { owner, repo: name })
      return isObject(data) && data.id === installationId ? null : "other_installation"
    } catch (error) {
      const failure = describeFailure(error, now())
      return stopOn(failure) ?? failureCode(failure)
    }
  }

  const readFamily = async (plan: Planned, family: AlertFamily): Promise<FamilyRead> => {
    const installation = plan.installation as Usable
    if (installation.granted[PERMISSION[family]] !== "read") return { coverage: "no_access", asOf: now() }
    const client = installation.client as Octokit
    const base = {
      owner: plan.owner,
      repo: plan.name,
      state: "open",
      per_page: PER_PAGE,
      ...(family === "secret_scanning" ? { hide_secret: true } : {}),
    }
    const counts = zero()
    const seen = new Set<string>()
    let cursor: Record<string, string> = {}
    let path: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const stop = stoppedCode()
      if (stop) return { coverage: "error", code: stop }
      let response: { data: unknown; headers: Record<string, unknown>; url: string }
      try {
        response = await client.request(ROUTES[family], { ...base, ...cursor })
      } catch (error) {
        const failure = describeFailure(error, now())
        const stopped = stopOn(failure)
        if (stopped) return { coverage: "error", code: stopped }
        if (failure.kind !== "status") return { coverage: "error", code: failureCode(failure) }
        const { status, message, headers } = failure
        if (status === 403) {
          const lacking = acceptedPermissions(headers["x-accepted-github-permissions"]).some(
            (name) => installation.granted[name as string] !== "read",
          )
          if (/resource not accessible by integration/i.test(message) || lacking)
            return { coverage: "no_access", asOf: now() }
          if (family === "code_scanning" && /(advanced security|code security)\b.*\b(must be|is not|not) enabled/i.test(message))
            return { coverage: "not_enabled", asOf: now() }
          if (family === "dependabot" && /alerts are disabled/i.test(message))
            return { coverage: "not_enabled", asOf: now() }
          return { coverage: "error", code: failureCode(failure) }
        }
        if (status === 404 && page === 0) {
          const off = family === "secret_scanning" || (family === "code_scanning" && /no analysis found/i.test(message))
          if (!off) return { coverage: "error", code: failureCode(failure) }
          const problem = await installedHere(plan.owner, plan.name, installation.read.id)
          return problem ? { coverage: "error", code: problem } : { coverage: "not_enabled", asOf: now() }
        }
        return { coverage: "error", code: failureCode(failure) }
      }
      if (!Array.isArray(response.data)) return { coverage: "error", code: "malformed" }
      for (const alert of response.data) {
        if (!isObject(alert)) return { coverage: "error", code: "malformed" }
        counts[severity[family](alert)]++
      }
      const asOf = now()
      const current = URL.canParse(response.url) ? new URL(response.url) : null
      if (current === null) return { coverage: "error", code: "malformed" }
      path ??= current.pathname
      const next = nextLink(response.headers.link)
      if (!next) return { coverage: "enabled", counts, asOf }
      // The next page must stay on this list: the same origin and path, a cursor not seen before.
      const url = URL.canParse(next) ? new URL(next) : null
      if (!url || url.origin !== options.origin || url.pathname !== path) return { coverage: "error", code: "malformed" }
      const key = url.searchParams.has("after") ? "after" : url.searchParams.has("page") ? "page" : null
      const value = key ? url.searchParams.get(key) : null
      if (!key || !value || seen.has(`${key}=${value}`)) return { coverage: "error", code: "malformed" }
      seen.add(`${key}=${value}`)
      cursor = { [key]: value }
    }
    return { coverage: "error", code: "too_many_pages" }
  }

  // 4. Alerts, four repositories at a time.
  await pool(planned, REPOS_AT_ONCE, async (plan) => {
    for (const family of ALERT_FAMILIES) plan.project.families[family] = await readFamily(plan, family)
  })

  // 5. Open Issues counts, by GraphQL per installation, up to 25 repositories a query. A repository renamed since the
  // inventory is not followed, and its database id must be the inventory's.
  const byInstallation = new Map<Usable, Planned[]>()
  for (const plan of planned) {
    const installation = plan.installation as Usable
    if (installation.granted[PERMISSION.issues] !== "read") {
      plan.project.issues = { kind: "cleared", asOf: now() }
      continue
    }
    byInstallation.set(installation, [...(byInstallation.get(installation) ?? []), plan])
  }
  for (const [installation, plans] of byInstallation) {
    for (let start = 0; start < plans.length; start += ISSUES_PER_QUERY) {
      const chunk = plans.slice(start, start + ISSUES_PER_QUERY)
      const stop = stoppedCode()
      if (stop) {
        for (const plan of chunk) plan.project.issues = { kind: "error", code: stop }
        continue
      }
      const variables: Record<string, string> = {}
      const fields = chunk.map((plan, i) => {
        variables[`o${i}`] = plan.owner
        variables[`n${i}`] = plan.name
        return `r${i}: repository(owner: $o${i}, name: $n${i}, followRenames: false) { databaseId issues(states: [OPEN]) { totalCount } }`
      })
      const query = `query(${chunk.map((_, i) => `$o${i}: String!, $n${i}: String!`).join(", ")}) { ${fields.join(" ")} }`
      let body: unknown
      let headers: Record<string, string> = {}
      try {
        const response = await (installation.client as Octokit).request("POST /graphql", { query, variables })
        body = response.data
        headers = Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
      } catch (error) {
        const failure = describeFailure(error, now())
        // A GraphQL rate limit can come with any status.
        const data = (error as { response?: { data?: unknown } }).response?.data
        const limit = isObject(data) ? graphqlRateLimit(data.errors, failure.kind === "status" ? failure.headers : {}, now()) : null
        const code = limit ? (stopOn({ kind: "rate_limit", until: limit }) as string) : (stopOn(failure) ?? failureCode(failure))
        for (const plan of chunk) plan.project.issues = { kind: "error", code }
        continue
      }
      const limit = isObject(body) ? graphqlRateLimit(body.errors, headers, now()) : null
      if (limit) {
        const code = stopOn({ kind: "rate_limit", until: limit }) as string
        for (const plan of chunk) plan.project.issues = { kind: "error", code }
        continue
      }
      const data = isObject(body) && isObject(body.data) ? body.data : {}
      const failed = new Set(
        (isObject(body) && Array.isArray(body.errors) ? body.errors : []).flatMap((e) =>
          isObject(e) && Array.isArray(e.path) && typeof e.path[0] === "string" ? [e.path[0]] : [],
        ),
      )
      const asOf = now()
      chunk.forEach((plan, i) => {
        const alias = `r${i}`
        const repo = data[alias]
        const issues = isObject(repo) && isObject(repo.issues) ? repo.issues.totalCount : undefined
        if (failed.has(alias) || !isObject(repo)) plan.project.issues = { kind: "error", code: "graphql_error" }
        else if (repo.databaseId !== plan.project.repoId) plan.project.issues = { kind: "error", code: "moved" }
        else if (typeof issues !== "number" || !Number.isInteger(issues) || issues < 0)
          plan.project.issues = { kind: "error", code: "malformed" }
        else plan.project.issues = { kind: "count", count: issues, asOf }
      })
    }
  }
  return result
}
