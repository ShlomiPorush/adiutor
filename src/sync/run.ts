import type { Output, PartResult, RunBody, RunReport, SecurityPart, T3Part } from "./contract.ts"
import { ClientError } from "./errors.ts"
import { lastLine, type Runner, systemCommand } from "./exec.ts"
import type { FetchLike } from "./http.ts"
import { type PushResult, type SyncClient, syncClient } from "./oauth.ts"
import { resolveRepo } from "./repo.ts"
import { dataDir, type Resolved } from "./settings.ts"
import { readLatestSnapshot, type Snapshot, securityReports } from "./snapshot.ts"
import { readProjectList, readStatus, saveProjectList, takeRunLock, writeStatus } from "./state.ts"
import { listThreads, type T3Project, type ThreadRecord } from "./t3.ts"
import { type CheckpointStep, t3Session } from "./t3-session.ts"

export type RunOptions = {
  collect: boolean
  dryRun: boolean
  /** The settings (src/sync/settings.ts): the command line, the env file, the environment and the settings file. */
  settings: Resolved
  /** Whether ADIUTOR_AGENT_TOKEN, the sync's agent key before agent approval, is still set (never its value). */
  oldToken: boolean
  /** The sync request from Adiutor this run serves (`--request`): named in its report, for the tray's check-in. */
  requestId?: string
  /** The connection that holds the request (oauth.ts identity()): every push of the run goes over it, or none. */
  connection?: string
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
  /** For the T3 session's pending records (src/sync/process-info.ts) and its test seam. */
  processCreation?: (pid: number) => Promise<string | null | undefined>
  t3Checkpoint?: (step: CheckpointStep) => void
}

export const EXIT_OK = 0
/** Nothing could be pushed, or another run holds the run lock. */
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
  return result.status >= 200 && result.status < 300
    ? `${name}: sent (HTTP ${result.status})${body}`
    : `${name}: refused (HTTP ${result.status})${body}`
}

type PartOutcome = { result: PartResult; reason?: string; message?: string; httpStatus?: number }

/**
 * A push's answer as a part's result. Adiutor answers a push it ran with 200 and `data.outcome` (succeeded, partial or
 * failed: src/server/services/sync.ts); a 2xx without a readable outcome may have done anything, so its outcome is
 * unknown. A part whose input was incomplete (projects not read, repositories missing from the snapshot) is partial at
 * best, with that reason.
 */
export function partOf(result: PushResult, incomplete?: string): PartOutcome {
  if (result.kind === "outcome_unknown")
    return { result: "outcome_unknown", ...(result.status ? { httpStatus: result.status } : {}) }
  if (result.kind === "failed") return { result: "failed", reason: result.code, message: result.message }
  const body = result.body as { data?: { outcome?: unknown }; error?: unknown } | undefined
  if (result.status < 200 || result.status >= 300) {
    const code = typeof body?.error === "string" ? body.error : `http_${result.status}`
    return { result: "failed", reason: code, httpStatus: result.status }
  }
  const outcome = body?.data?.outcome
  if (outcome === "succeeded")
    return incomplete
      ? { result: "partial", reason: incomplete, httpStatus: result.status }
      : { result: "accepted", httpStatus: result.status }
  if (outcome === "partial") return { result: "partial", reason: "server_partial", httpStatus: result.status }
  if (outcome === "failed") return { result: "failed", reason: "server_failed", httpStatus: result.status }
  return { result: "outcome_unknown", reason: "unreadable_answer", httpStatus: result.status }
}

/** The sync's connection ended or was never made: the output says so, and how to reconnect. */
const DISCONNECTED = new Set(["connection_ended", "not_connected"])
function disconnected(url: string, envFile: string | undefined): string {
  const env = envFile ? ` --env "${envFile}"` : ""
  return `The sync is disconnected from Adiutor; reconnect it: node adiutor-sync.js connect --name "<name>" --url "${url}"${env} --replace`
}

/**
 * One sync run under the run lock: the overview collector, T3's project list with the sync's session (or the last good
 * list when T3 cannot be reached), the threads through the T3 CLI, then the T3 push and the security push. The report
 * states each part's result; the status file keeps it for `status`. The exit code is non-zero only when nothing could
 * be pushed (or, in a dry run, nothing read); it is not the result.
 */
export async function runSync(options: RunOptions, deps: Deps, out: Output): Promise<{ exit: number; body: RunBody }> {
  const platform = deps.platform ?? process.platform
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const nowMs = () => deps.now().getTime()
  const say = out.say
  const { settings } = options
  const data = dataDir(platform, deps.env)
  const lockDeps = { platform, env: deps.env, now: nowMs, sleep }

  if (!options.dryRun && !settings.url) {
    const message = settings.problems[0] ?? "ADIUTOR_URL is required"
    say(`config: Invalid configuration: ${message}`)
    return { exit: EXIT_USAGE, body: { error: { code: "usage", message } } }
  }

  // One run at a time across the tray and the command line, for the whole run, the collector included.
  const held = await takeRunLock(data, lockDeps)
  if (held.busy) {
    const message = `another run is going (since ${held.startedAt ?? "an unknown time"}); nothing ran`
    say(`run: ${message}`)
    return {
      exit: EXIT_NOTHING_PUSHED,
      body: { busy: { startedAt: held.startedAt }, error: { code: "busy", message } },
    }
  }
  try {
    const report = await runLocked(options, deps, say, { platform, sleep, nowMs, data, lockDeps })
    if (!options.dryRun) {
      const before = readStatus(data)
      const good = report.t3.result === "accepted" && report.security.result === "accepted"
      report.lastGoodSyncAt = good ? report.finishedAt : before.lastGoodSyncAt
      await writeStatus(data, { v: 1, lastRun: report, lastGoodSyncAt: report.lastGoodSyncAt }, lockDeps)
    }
    const sent = (part: { result: PartResult }) => part.result === "accepted" || part.result === "partial"
    const exit = options.dryRun
      ? report.t3.reason === "dry_run" || report.security.reason === "dry_run"
        ? EXIT_OK
        : EXIT_NOTHING_PUSHED
      : sent(report.t3) || sent(report.security)
        ? EXIT_OK
        : EXIT_NOTHING_PUSHED
    // A run for a request whose connection changed meanwhile sends nothing more: it ends with connection_changed.
    const changed = [report.t3, report.security].some((part) => part.reason === "connection_changed")
    if (changed)
      return {
        exit,
        body: {
          report,
          error: {
            code: "connection_changed",
            message: "The sync connected again during this run, so nothing more was sent for the request.",
          },
        },
      }
    return { exit, body: { report } }
  } finally {
    held.release()
  }
}

async function runLocked(
  options: RunOptions,
  deps: Deps,
  say: (line: string) => void,
  ctx: {
    platform: NodeJS.Platform
    sleep: (ms: number) => Promise<void>
    nowMs: () => number
    data: string
    lockDeps: Parameters<typeof saveProjectList>[2]
  },
): Promise<RunReport> {
  const { settings } = options
  const startedAt = deps.now().toISOString()
  const t3: T3Part = {
    result: "not_run",
    projectsFrom: null,
    projectsAt: null,
    projects: 0,
    threads: 0,
    failedProjects: 0,
  }
  const security: SecurityPart = {
    result: "not_run",
    snapshotRunId: null,
    snapshotAt: null,
    repos: 0,
    projectsFrom: null,
    projectsAt: null,
  }
  const stopT3 = (reason: string, message: string) => {
    Object.assign(t3, { result: "not_run", reason, message })
    say(`t3: ${message}`)
  }
  const sysCommand = deps.systemCommand ?? ((name: string) => systemCommand(name, deps.env))

  if (options.oldToken)
    say(
      "config: ADIUTOR_AGENT_TOKEN, the sync's old agent key, is set but no longer used: the sync uses the connection `connect` keeps. Delete that line, and the key in Settings, Agent access, if it is still listed.",
    )

  // 0. The Adiutor connection: revocations a disconnect left are retried first.
  let client: SyncClient | undefined
  if (!options.dryRun && settings.url) {
    try {
      client = syncClient(settings.url, {
        fetch: deps.fetch,
        runner: deps.runner,
        systemCommand: sysCommand,
        platform: ctx.platform,
        env: deps.env,
        now: ctx.nowMs,
        sleep: ctx.sleep,
        ...(deps.httpTimeoutMs ? { httpTimeoutMs: deps.httpTimeoutMs } : {}),
      })
      if (await client.retryRevocations())
        say("connection: a disconnected connection could not be revoked yet; the next command tries again")
    } catch (error) {
      say(`connection: ${(error as Error).message}`)
      if (!client) {
        const finishedAt = deps.now().toISOString()
        const reason = error instanceof ClientError ? error.code : "connection_failed"
        return {
          startedAt,
          finishedAt,
          dryRun: false,
          requestId: options.requestId ?? null,
          t3: { ...t3, reason },
          security: { ...security, reason },
          lastGoodSyncAt: null,
        }
      }
    }
  }

  // 1. The overview collector, then its newest snapshot (even when the collector failed).
  const overviewDir = settings.overviewDir
  let snapshot: Snapshot | undefined
  if (!overviewDir) {
    say("overview: no folder (set ADIUTOR_OVERVIEW_DIR or pass --overview); security is not sent")
    Object.assign(security, { reason: "no_overview", message: "no overview folder is set" })
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
      security.snapshotRunId = snapshot.runId
      security.snapshotAt = snapshot.finishedAt
      say(`overview: snapshot ${snapshot.runId}${snapshot.finishedAt ? ` finished ${snapshot.finishedAt}` : ""}`)
    } catch (error) {
      say(`overview: ${(error as Error).message}; security is not sent`)
      Object.assign(security, { reason: "no_snapshot", message: (error as Error).message })
    }
  }

  // 2. T3's project list with the sync's session; the last good list only when T3 cannot be reached.
  const collectedAt = deps.now().toISOString()
  let projects: T3Project[] | undefined
  let environmentId: string | undefined
  // The session this run read with: an identity failure later in the run ends this one, never a newer one.
  let sessionId: string | undefined
  const session =
    settings.t3Url !== undefined
      ? t3Session({
          runner: deps.runner,
          fetch: deps.fetch,
          platform: ctx.platform,
          env: deps.env,
          now: ctx.nowMs,
          sleep: ctx.sleep,
          systemCommand: sysCommand,
          cliPath: settings.cliPath,
          origin: settings.t3Url,
          ...(deps.processCreation ? { processCreation: deps.processCreation } : {}),
          ...(deps.t3Checkpoint ? { checkpoint: deps.t3Checkpoint } : {}),
          ...(deps.httpTimeoutMs ? { httpTimeoutMs: deps.httpTimeoutMs } : {}),
        })
      : undefined
  if (!session) stopT3("t3_settings", "T3's address is not usable; T3 is not read")
  else {
    try {
      const read = await session.readProjects()
      if (read.kind === "ok") {
        projects = read.projects.projects
        environmentId = read.environmentId
        sessionId = read.sessionId
        Object.assign(t3, { projectsFrom: "t3", projectsAt: collectedAt })
        const skipped = read.projects.skipped ? ` (${read.projects.skipped} skipped: deleted or unusable ids)` : ""
        say(`t3: ${projects.length} projects${skipped}`)
        if (read.renewal) say(`t3: ${read.renewal}`)
        try {
          await saveProjectList(ctx.data, { savedAt: collectedAt, environmentId, projects }, ctx.lockDeps)
        } catch {
          say("t3: the project list could not be kept as the last good list")
        }
      } else if (read.kind === "unavailable") {
        const last = readProjectList(ctx.data)
        if (last && last.environmentId === read.environmentId) {
          projects = last.projects
          environmentId = read.environmentId
          sessionId = read.sessionId
          Object.assign(t3, { projectsFrom: "last_good", projectsAt: last.savedAt })
          say(`t3: ${read.message}; T3 projects from ${last.savedAt} (${projects.length} projects)`)
        } else stopT3("t3_unavailable", `${read.message}, and there is no last good project list; T3 is not read`)
      } else stopT3(read.code, read.message)
    } catch (error) {
      stopT3(
        error instanceof ClientError ? error.code : "t3_failed",
        `the T3 session could not be used: ${(error as Error).message}`,
      )
    }
  }

  // 3. Threads per project through the T3 CLI, from T3's default data folder.
  const threads = new Map<string, ThreadRecord>()
  const failed: string[] = []
  // Projects with invalid thread records: their threads are sent, but the picture is not complete.
  const incomplete: string[] = []
  let invalid = 0
  let otherEnvironment = false
  if (projects && environmentId && session) {
    const results = await mapLimit(projects, THREAD_CONCURRENCY, async (project) => {
      try {
        return {
          project,
          ...(await listThreads(deps.runner, settings.cliPath, project.id, deps.threadTimeoutMs ?? 120_000, deps.env)),
        }
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
      if (result.environments.some((id) => id !== environmentId)) otherEnvironment = true
      // A thread whose environment cannot be checked is not sent: its project counts as not read.
      if (result.unverified > 0) {
        failed.push(result.project.id)
        say(
          `t3: project ${result.project.id} has ${result.unverified} threads without a link to check their environment; not read`,
        )
        continue
      }
      invalid += result.invalid
      if (result.invalid > 0) {
        incomplete.push(result.project.id)
        say(`t3: project ${result.project.id} has ${result.invalid} invalid thread records; sent as not fully read`)
      }
      for (const thread of result.threads) if (!threads.has(thread.threadId)) threads.set(thread.threadId, thread)
    }
    if (otherEnvironment) {
      // The CLI reads another T3 than the session's: an identity failure, which stops the T3 part until t3-connect.
      if (sessionId) await session.markEnded("other_environment", sessionId).catch(() => {})
      stopT3(
        "t3_other_environment",
        "the T3 CLI reads another environment than the sync's session; check the CLI path and connect T3 again (t3-connect)",
      )
    }
  }

  const readable = projects !== undefined && !otherEnvironment
  const projectList = readable ? (projects ?? []) : []
  const local = snapshot?.local ?? []
  const projectRecords = projectList.map((project) => {
    const repo = resolveRepo(project, local)
    return { t3ProjectId: project.id, title: project.title, ...(repo ? { repo } : {}) }
  })
  const threadRecords = readable ? [...threads.values()] : []
  if (readable) {
    const children = threadRecords.filter((t) => t.parentThreadId).length
    say(
      `t3: ${threadRecords.length} threads (${children} child threads)` +
        (invalid ? `, ${invalid} records skipped` : "") +
        (failed.length ? `, ${failed.length} of ${projectList.length} projects not read` : ""),
    )
  }
  // The server must not read the missing threads of an unread or partly read project as "no threads".
  const failedProjects = [...incomplete, ...failed]
  const t3Payload = { collectedAt, projects: projectRecords, threads: threadRecords, failedProjects }
  const canSendT3 = readable && failed.length < projectList.length
  if (readable)
    Object.assign(t3, {
      projects: projectList.length,
      threads: threadRecords.length,
      failedProjects: failedProjects.length,
    })
  if (readable && !canSendT3) stopT3("no_threads", "no project's threads could be read; the T3 part is not sent")

  // 4. Security for the GitHub repositories of the projects. It reads nothing from T3: when this run has no project
  // list, the last good list (a local file) still maps the projects to their repositories.
  let securityPayload: { collectedAt: string; repos: ReturnType<typeof securityReports>["reports"] } | undefined
  let securityMissing = 0
  let securityProjects: { repo?: string }[] | undefined
  if (snapshot && readable) {
    securityProjects = projectRecords
    Object.assign(security, { projectsFrom: t3.projectsFrom, projectsAt: t3.projectsAt })
  } else if (snapshot) {
    const last = readProjectList(ctx.data)
    if (last) {
      securityProjects = last.projects.map((project) => {
        const repo = resolveRepo(project, local)
        return repo ? { repo } : {}
      })
      Object.assign(security, { projectsFrom: "last_good", projectsAt: last.savedAt })
      say(`security: repositories from the last good project list of ${last.savedAt}`)
    } else Object.assign(security, { reason: "no_projects", message: "no T3 project list to find the repositories" })
  }
  if (snapshot && securityProjects) {
    const repos = securityProjects.map((p) => p.repo).filter((r): r is string => r !== undefined)
    const { reports, missing } = securityReports(snapshot, repos)
    say(
      `security: ${reports.length} repositories` +
        (missing.length ? `, ${missing.length} project repositories not in the snapshot` : ""),
    )
    security.repos = reports.length
    securityMissing = missing.length
    if (reports.length > 0) securityPayload = { collectedAt, repos: reports }
    else Object.assign(security, { reason: "no_repos", message: "no project repository is in the snapshot" })
  }

  const finish = (): RunReport => ({
    startedAt,
    finishedAt: deps.now().toISOString(),
    dryRun: options.dryRun,
    requestId: options.requestId ?? null,
    t3,
    security,
    lastGoodSyncAt: null,
  })

  if (options.dryRun) {
    say("dry run: nothing is sent")
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
    say(`dry run: t3 payload ${size(t3Payload)} bytes${canSendT3 ? "" : " (would not be sent)"}`)
    if (securityPayload) say(`dry run: security payload ${size(securityPayload)} bytes`)
    // Ids and counts only: titles and paths stay out of the output.
    const sample = {
      project: projectRecords[0]?.t3ProjectId,
      thread: (threadRecords.find((t) => !t.parentThreadId) ?? threadRecords[0])?.threadId,
      repo: securityPayload?.repos[0]?.repo,
    }
    say(`dry run: sample ${compact(sample, 4000)}`)
    if (canSendT3) Object.assign(t3, { reason: "dry_run", message: undefined })
    if (securityPayload) Object.assign(security, { reason: "dry_run", message: undefined })
    return finish()
  }

  // 5. Push: T3 first, then security, over the sync's connection (src/sync/oauth.ts).
  const url = settings.url as string
  let ended: string | null = null
  const pushOne = async (
    name: string,
    path: string,
    payload: unknown,
    part: T3Part | SecurityPart,
    incomplete: string | undefined,
  ) => {
    if (!client) return
    if (ended) {
      say(
        `${name}: not sent (${ended === "connection_changed" ? "the sync connected again" : "the sync is disconnected"})`,
      )
      Object.assign(part, { result: "not_run", reason: ended })
      return
    }
    const result = await client.push(path, payload, options.connection ? { connection: options.connection } : {})
    say(describeResult(name, result))
    Object.assign(part, partOf(result, incomplete))
    if (result.kind === "failed" && result.code === "connection_changed") ended = "connection_changed"
    if (result.kind === "failed" && DISCONNECTED.has(result.code)) {
      ended = "connection_ended"
      say(disconnected(url, settings.envFile))
    }
  }
  if (canSendT3)
    await pushOne(
      "t3 sync",
      "/api/v1/sync/t3",
      t3Payload,
      t3,
      failedProjects.length > 0 ? "projects_missing" : undefined,
    )
  else say("t3 sync: not sent (no threads could be read)")
  if (securityPayload)
    await pushOne(
      "security sync",
      "/api/v1/sync/security",
      securityPayload,
      security,
      securityMissing > 0 ? "repos_missing" : undefined,
    )
  else say("security sync: not sent (no snapshot data)")

  return finish()
}
