import { lastLine, type Runner } from "./exec.ts"
import { asArray, asObject, asString, asTime, type JsonObject, parseJson } from "./json.ts"

// T3 data: the projects file written by the scheduled agent from t3_project_list, and each project's
// threads from `t3 thread list --project <id> --json`. Top-level and child threads are both kept; the
// server folds child threads into their parent's item.

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

export type ProjectsFile = { collectedAt: string | null; projects: T3Project[]; skipped: number }

/** Reads the projects file. Deleted projects and records without a usable id are skipped and counted. */
export function parseProjectsFile(text: string): ProjectsFile {
  const root = asObject(parseJson(text, "the projects file"))
  if (!root || !Array.isArray(root.projects)) throw new Error("the projects file has no projects array")
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
    projects.push({
      id,
      title: asString(data.title) ?? "",
      workspaceRoot: asString(data.workspaceRoot),
      repositoryIdentity: identity(data.repositoryIdentity),
    })
  }
  return { collectedAt: asTime(root.collectedAt), projects, skipped }
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
  }
}

/** Maps the CLI's JSON output. Records without a thread id or status are skipped and counted. */
export function mapThreads(output: string, t3ProjectId: string): { threads: ThreadRecord[]; invalid: number } {
  const list = parseJson(output, "the T3 thread list")
  if (!Array.isArray(list)) throw new Error("the T3 thread list is not a JSON array")
  const threads: ThreadRecord[] = []
  let invalid = 0
  for (const item of asArray(list)) {
    const data = asObject(item)
    const thread = data ? mapThread(data, t3ProjectId) : undefined
    if (thread) threads.push(thread)
    else invalid += 1
  }
  return { threads, invalid }
}

export async function listThreads(
  runner: Runner,
  cliPath: string,
  projectId: string,
  timeoutMs: number,
): Promise<{ threads: ThreadRecord[]; invalid: number }> {
  if (!PROJECT_ID.test(projectId)) throw new Error("unsupported project id")
  const result = await runner(cliPath, ["thread", "list", "--project", projectId, "--json"], { timeoutMs })
  if (result.error) {
    const detail = lastLine(result.stderr)
    throw new Error(detail ? `${result.error}: ${detail}` : result.error)
  }
  return mapThreads(result.stdout, projectId)
}
