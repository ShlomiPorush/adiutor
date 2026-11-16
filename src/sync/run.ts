import { readFile } from "node:fs/promises"
import { loadSyncConfig, parseEnvFile, redactor, type SyncConfig } from "./env.ts"
import { lastLine, type Runner, systemCommand } from "./exec.ts"
import type { FetchLike } from "./http.ts"
import { type PushResult, type SyncClient, syncClient } from "./oauth.ts"
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
  /** For the connection (src/sync/oauth.ts); the process's own unless a test sets them. */
  platform?: NodeJS.Platform
  systemCommand?: (name: string) => Promise<string | undefined>
  sleep?: (ms: number) => Promise<void>
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

function describeResult(name: string, result: PushResult): string {
  if (result.kind === "outcome_unknown")
    return `${name}: outcome unknown${result.status ? ` (HTTP ${result.status})` : ""}: it may have reached Adiutor, and its answer was lost or failed. It is not sent again; the next run sends the whole state again.`
  if (result.kind === "failed") return `${name}: not sent: ${result.code}: ${result.message}`
  const body = result.body === undefined ? "" : ` ${compact(result.body)}`
  return ok(result) ? `${name}: sent (HTTP ${result.status})${body}` : `${name}: refused (HTTP ${result.status})${body}`
}

const ok = (result: PushResult) => result.kind === "answer" && result.status >= 200 && result.status < 300

/** The sync's connection ended or was never made: the output says so, and how to reconnect. */
const DISCONNECTED = new Set(["connection_ended", "not_connected"])
function disconnected(url: string, envFile: string | undefined): string {
  const env = envFile ? ` --env "${envFile}"` : ""
  return `The sync is disconnected from Adiutor; reconnect it: node adiutor-sync.js connect --name "<name>" --url "${url}"${env} --replace`
}

/**
 * One sync run: the overview collector, the T3 read, then the T3 push and the security push.
 * Returns the exit code: non-zero only when nothing could be pushed (or, in a dry run, nothing read).
 */
export async function runSync(options: RunOptions, deps: Deps): Promise<number> {
  let fileVars: Record<string, string> = {}
  let say = (line: string) => deps.out(redactor([deps.env.ADIUTOR_AGENT_TOKEN])(line))

  if (options.envFile) {
    try {
      fileVars = parseEnvFile(await readFile(options.envFile, "utf8"))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      say(`config: cannot read the env file: ${code ?? (error as Error).message}`)
      return EXIT_USAGE
    }
    say = (line) => deps.out(redactor([deps.env.ADIUTOR_AGENT_TOKEN, fileVars.ADIUTOR_AGENT_TOKEN])(line))
  }

  let config: SyncConfig
  try {
    config = loadSyncConfig(deps.env, fileVars, { requireServer: !options.dryRun })
  } catch (error) {
    say(`config: ${(error as Error).message}`)
    return EXIT_USAGE
  }
  if (config.oldToken)
    say(
      "config: ADIUTOR_AGENT_TOKEN, the sync's old agent key, is set but no longer used: the sync uses the connection `connect` keeps. Delete that line, and the key in Settings, Agent access, if it is still listed.",
    )

  // 1. The overview collector, then its newest snapshot (even when the collector failed).
  const overviewDir = options.overviewDir ?? config.overviewDir
  let snapshot: Snapshot | undefined
  if (!overviewDir) {
    say("overview: no folder (set ADIUTOR_OVERVIEW_DIR or pass --overview); security is not sent")
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
  // Projects with invalid thread records: their threads are sent, but the picture is not complete.
  const incomplete: string[] = []
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
      if (result.invalid > 0) {
        incomplete.push(result.project.id)
        say(`t3: project ${result.project.id} has ${result.invalid} invalid thread records; sent as not fully read`)
      }
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
  // The server must not read the missing threads of an unread or partly read project as "no threads".
  const t3Payload = {
    collectedAt,
    projects: projectRecords,
    threads: threadRecords,
    failedProjects: [...incomplete, ...failed],
  }
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

  // 5. Push: T3 first, then security, over the sync's connection (src/sync/oauth.ts).
  const url = config.url as string
  let client: SyncClient
  try {
    client = syncClient(url, {
      fetch: deps.fetch,
      runner: deps.runner,
      systemCommand: deps.systemCommand ?? ((name) => systemCommand(name, deps.env)),
      platform: deps.platform ?? process.platform,
      env: deps.env,
      now: () => deps.now().getTime(),
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      ...(deps.httpTimeoutMs ? { httpTimeoutMs: deps.httpTimeoutMs } : {}),
    })
  } catch (error) {
    say(`connection: ${(error as Error).message}`)
    return EXIT_USAGE
  }
  let pushed = 0
  let ended = false
  const pushOne = async (name: string, path: string, payload: unknown) => {
    if (ended) return say(`${name}: not sent (the sync is disconnected)`)
    const result = await client.push(path, payload)
    say(describeResult(name, result))
    if (result.kind === "failed" && DISCONNECTED.has(result.code)) {
      ended = true
      say(disconnected(url, options.envFile))
    }
    if (ok(result)) pushed += 1
  }
  if (canSendT3) await pushOne("t3 sync", "/api/v1/sync/t3", t3Payload)
  else say("t3 sync: not sent (no threads could be read)")
  if (securityPayload) await pushOne("security sync", "/api/v1/sync/security", securityPayload)
  else say("security sync: not sent (no snapshot data)")

  return pushed > 0 ? EXIT_OK : EXIT_NOTHING_PUSHED
}
