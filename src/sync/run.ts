import { readFile } from "node:fs/promises"
import { loadSyncConfig, parseEnvFile, redactor, type SyncConfig } from "./env.ts"
import { lastLine, type Runner } from "./exec.ts"
import { type FetchLike, type PostResult, postJson } from "./http.ts"
import { resolveRepo } from "./repo.ts"
import { readLatestSnapshot, type Snapshot, securityReports } from "./snapshot.ts"
import { listThreads, parseProjectsFile, type ThreadRecord } from "./t3.ts"

export type RunOptions = {
  projectsFile: string
  overviewDir?: string
  envFile?: string
  collect: boolean
  dryRun: boolean
}

export type Deps = {
  env: Record<string, string | undefined>
  runner: Runner
  fetch: FetchLike
  /** Prints one line of output. */
  out: (line: string) => void
  now: () => Date
  /** The Node.js binary that runs the overview collector. */
  nodePath: string
  collectTimeoutMs?: number
  threadTimeoutMs?: number
  httpTimeoutMs?: number
}

export const EXIT_OK = 0
/** Nothing could be pushed. */
export const EXIT_NOTHING_PUSHED = 1
/** Bad arguments or configuration. */
export const EXIT_USAGE = 2

const THREAD_CONCURRENCY = 4

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function compact(value: unknown, max = 2000): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "")
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function describe(name: string, result: PostResult): string {
  if (result.error) return `${name}: not sent: ${result.error}`
  const body = result.body === undefined ? "" : ` ${compact(result.body)}`
  return result.ok ? `${name}: sent (HTTP ${result.status})${body}` : `${name}: refused (HTTP ${result.status})${body}`
}

/**
 * One sync run: the overview collector, the T3 read, then the T3 push and the security push.
 * Returns the exit code: non-zero only when nothing could be pushed (or, in a dry run, nothing read).
 */
export async function runSync(options: RunOptions, deps: Deps): Promise<number> {
  let fileVars: Record<string, string> = {}
  let say = (line: string) => deps.out(redactor([deps.env.MIKUD_AGENT_TOKEN])(line))

  if (options.envFile) {
    try {
      fileVars = parseEnvFile(await readFile(options.envFile, "utf8"))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      say(`config: cannot read the env file: ${code ?? (error as Error).message}`)
      return EXIT_USAGE
    }
    say = (line) => deps.out(redactor([deps.env.MIKUD_AGENT_TOKEN, fileVars.MIKUD_AGENT_TOKEN])(line))
  }

  let config: SyncConfig
  try {
    config = loadSyncConfig(deps.env, fileVars, { requireServer: !options.dryRun })
  } catch (error) {
    say(`config: ${(error as Error).message}`)
    return EXIT_USAGE
  }

  // 1. The overview collector, then its newest snapshot (even when the collector failed).
  const overviewDir = options.overviewDir ?? config.overviewDir
  let snapshot: Snapshot | undefined
  if (!overviewDir) {
    say("overview: no folder (set MIKUD_OVERVIEW_DIR or pass --overview); security is not sent")
  } else {
    if (options.collect) {
      const result = await deps.runner(deps.nodePath, ["src/cli.mjs", "collect"], {
        cwd: overviewDir,
        timeoutMs: deps.collectTimeoutMs ?? 20 * 60_000,
      })
      if (result.error) {
        const detail = lastLine(result.stderr)
        say(
          `overview: the collector failed (${result.error}${detail ? `: ${detail}` : ""}); using the newest existing snapshot`,
        )
      } else say("overview: collector finished")
    } else say("overview: collector skipped (--no-collect)")
    try {
      snapshot = await readLatestSnapshot(overviewDir)
      say(`overview: snapshot ${snapshot.runId}${snapshot.finishedAt ? ` finished ${snapshot.finishedAt}` : ""}`)
    } catch (error) {
      say(`overview: ${(error as Error).message}; security is not sent`)
    }
  }

  // 2. The T3 projects file written by the scheduled agent.
  let projectsFile: ReturnType<typeof parseProjectsFile>
  try {
    projectsFile = parseProjectsFile(await readFile(options.projectsFile, "utf8"))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    say(`t3: cannot read the projects file: ${code ?? (error as Error).message}`)
    return EXIT_NOTHING_PUSHED
  }
  const { projects } = projectsFile
  const skipped = projectsFile.skipped ? ` (${projectsFile.skipped} records skipped)` : ""
  say(`t3: ${projects.length} projects in the projects file${skipped}`)

  // 3. Threads per project through the T3 CLI.
  const collectedAt = deps.now().toISOString()
  const threads = new Map<string, ThreadRecord>()
  const failed: string[] = []
  let invalid = 0
  if (!config.cliPath) {
    say("t3: T3CODE_CLI_PATH is not set; threads are not read")
  } else {
    const cliPath = config.cliPath
    const results = await mapLimit(projects, THREAD_CONCURRENCY, async (project) => {
      try {
        return { project, ...(await listThreads(deps.runner, cliPath, project.id, deps.threadTimeoutMs ?? 120_000)) }
      } catch (error) {
        return { project, error: (error as Error).message }
      }
    })
    for (const result of results) {
      if ("error" in result) {
        failed.push(result.project.id)
        say(`t3: threads of project ${result.project.id} not read: ${result.error}`)
        continue
      }
      invalid += result.invalid
      for (const thread of result.threads) if (!threads.has(thread.threadId)) threads.set(thread.threadId, thread)
    }
  }

  const local = snapshot?.local ?? []
  const projectRecords = projects.map((project) => {
    const repo = resolveRepo(project, local)
    return { t3ProjectId: project.id, title: project.title, ...(repo ? { repo } : {}) }
  })
  const threadRecords = [...threads.values()]
  const children = threadRecords.filter((t) => t.parentThreadId).length
  say(
    `t3: ${threadRecords.length} threads (${children} child threads)` +
      (invalid ? `, ${invalid} records skipped` : "") +
      (failed.length ? `, ${failed.length} of ${projects.length} projects not read` : ""),
  )
  const t3Payload = { collectedAt, projects: projectRecords, threads: threadRecords }
  const canSendT3 = config.cliPath !== undefined && failed.length < projects.length

  // 4. Security for the GitHub repositories of the projects.
  let securityPayload: { collectedAt: string; repos: ReturnType<typeof securityReports>["reports"] } | undefined
  if (snapshot) {
    const repos = projectRecords.map((p) => p.repo).filter((r): r is string => r !== undefined)
    const { reports, missing } = securityReports(snapshot, repos)
    say(
      `security: ${reports.length} repositories` +
        (missing.length ? `, ${missing.length} project repositories not in the snapshot` : ""),
    )
    if (reports.length > 0) securityPayload = { collectedAt, repos: reports }
  }

  if (options.dryRun) {
    say("dry run: nothing is sent")
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
    say(`dry run: t3 payload ${size(t3Payload)} bytes${canSendT3 ? "" : " (would not be sent)"}`)
    if (securityPayload) say(`dry run: security payload ${size(securityPayload)} bytes`)
    const sample = {
      project: projectRecords[0],
      thread: threadRecords.find((t) => !t.parentThreadId) ?? threadRecords[0],
      repo: securityPayload?.repos[0],
    }
    say(`dry run: sample ${compact(sample, 4000)}`)
    return canSendT3 || securityPayload ? EXIT_OK : EXIT_NOTHING_PUSHED
  }

  // 5. Push: T3 first, then security.
  const url = config.url as string
  const token = config.token as string
  const timeout = deps.httpTimeoutMs ?? 60_000
  let pushed = 0
  if (canSendT3) {
    const result = await postJson(deps.fetch, url, "/api/v1/sync/t3", token, t3Payload, timeout)
    say(describe("t3 sync", result))
    if (result.ok) pushed += 1
  } else say("t3 sync: not sent (no threads could be read)")
  if (securityPayload) {
    const result = await postJson(deps.fetch, url, "/api/v1/sync/security", token, securityPayload, timeout)
    say(describe("security sync", result))
    if (result.ok) pushed += 1
  } else say("security sync: not sent (no snapshot data)")

  return pushed > 0 ? EXIT_OK : EXIT_NOTHING_PUSHED
}
