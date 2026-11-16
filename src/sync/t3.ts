import { lastLine, type Runner, t3Env } from "./exec.ts"
import { asArray, asObject, asString, asTime, type JsonObject, parseJson } from "./json.ts"

// T3 data: the project list from T3's `GET /api/projects` (src/sync/t3-session.ts reads it with the sync's session),
// and each project's threads from `t3 thread list --project <id> --json`. Top-level and child threads are both kept;
// the server folds child threads into their parent's item. Everything read is untrusted data, passed on only as JSON.

export type RepositoryIdentity = { provider?: string; owner?: string; name?: string; rootPath?: string }

export type T3Project = {
  id: string
  title: string
  workspaceRoot?: string
  repositoryIdentity?: RepositoryIdentity
}

export type ThreadRecord = {
  threadId: string
  t3ProjectId: string
  title: string
  status: string
  settled: boolean
  settledAt: string | null
  parentThreadId: string | null
  updatedAt: string | null
  /** Snoozed in T3, until snoozedUntil when T3 gives a time (D-T6). */
  snoozed: boolean
  snoozedUntil: string | null
}

/** Project ids travel on the T3 CLI command line, so only plain id characters are accepted. */
export const PROJECT_ID = /^[A-Za-z0-9._:-]{1,200}$/

function identity(value: unknown): RepositoryIdentity | undefined {
  const data = asObject(value)
  if (!data) return undefined
  return {
    provider: asString(data.provider),
    owner: asString(data.owner),
    name: asString(data.name),
    rootPath: asString(data.rootPath),
  }
}

/** One project record as the sync keeps it: id, title, folder and repository identity. */
export function projectFrom(data: JsonObject, id: string): T3Project {
  return {
    id,
    title: asString(data.title) ?? "",
    workspaceRoot: asString(data.workspaceRoot),
    repositoryIdentity: identity(data.repositoryIdentity),
  }
}

export type Projects = { projects: T3Project[]; skipped: number }

/**
 * Reads T3's project list (`{projects: [...]}`). Deleted projects and records without a usable id are skipped and
 * counted.
 */
export function parseProjectList(body: unknown): Projects {
  const root = asObject(body)
  if (!root || !Array.isArray(root.projects)) throw new Error("T3's project list has no projects array")
  const projects: T3Project[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (const item of root.projects) {
    const data = asObject(item)
    const id = asString(data?.id)
    if (!data || !id || !PROJECT_ID.test(id) || seen.has(id) || asString(data.deletedAt)) {
      skipped += 1
      continue
    }
    seen.add(id)
    projects.push(projectFrom(data, id))
  }
  return { projects, skipped }
}

/**
 * The environment id in a thread's link (`https://app.t3.codes/threads/<environment id>/<thread id>`), or undefined
 * when the thread has no link of that shape. The sync checks it against the session's environment.
 */
export function linkEnvironment(link: unknown): string | undefined {
  const text = asString(link)
  const url = text ? URL.parse(text) : null
  const match = url ? /^\/threads\/([^/]+)\/[^/]+\/?$/.exec(url.pathname) : null
  if (!match?.[1]) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

function mapThread(data: JsonObject, t3ProjectId: string): ThreadRecord | undefined {
  const threadId = asString(data.threadId)
  const status = asString(data.status)
  if (!threadId || !status) return undefined
  return {
    threadId,
    t3ProjectId,
    title: asString(data.title) ?? "",
    status,
    settled: data.settled === true,
    settledAt: asTime(data.settledAt),
    parentThreadId: asString(data.parentThreadId) || null,
    updatedAt: asTime(data.updatedAt),
    snoozed: data.snoozed === true,
    snoozedUntil: data.snoozed === true ? asTime(data.snoozedUntil) : null,
  }
}

export type ThreadList = {
  threads: ThreadRecord[]
  invalid: number
  /** The environment ids the threads' links name. */
  environments: string[]
  /** Threads without a link that names an environment: their environment cannot be checked. */
  unverified: number
}

/** Maps the CLI's JSON output. Records without a thread id or status are skipped and counted. */
export function mapThreads(output: string, t3ProjectId: string): ThreadList {
  const list = parseJson(output, "the T3 thread list")
  if (!Array.isArray(list)) throw new Error("the T3 thread list is not a JSON array")
  const threads: ThreadRecord[] = []
  const environments = new Set<string>()
  let invalid = 0
  let unverified = 0
  for (const item of asArray(list)) {
    const data = asObject(item)
    const thread = data ? mapThread(data, t3ProjectId) : undefined
    if (thread) threads.push(thread)
    else invalid += 1
    const environment = data ? linkEnvironment(data.link) : undefined
    if (environment) environments.add(environment)
    else if (thread) unverified += 1
  }
  return { threads, invalid, environments: [...environments], unverified }
}

/** A project's threads through the T3 CLI, called by id, from T3's default data folder (src/sync/exec.ts, t3Env). */
export async function listThreads(
  runner: Runner,
  cliPath: string,
  projectId: string,
  timeoutMs: number,
  env: Record<string, string | undefined>,
): Promise<ThreadList> {
  if (!PROJECT_ID.test(projectId)) throw new Error("unsupported project id")
  const result = await runner(cliPath, ["thread", "list", "--project", projectId, "--json"], {
    timeoutMs,
    env: t3Env(env),
  })
  if (result.error) {
    const detail = lastLine(result.stderr)
    throw new Error(detail ? `${result.error}: ${detail}` : result.error)
  }
  return mapThreads(result.stdout, projectId)
}
