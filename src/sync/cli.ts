import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { checkinRound, isRequestId, parseReport, readClaim } from "./checkin.ts"
import { type ConnectDeps, connect, defaultEnvFile, NAME_MAX } from "./connect.ts"
import {
  type AdiutorState,
  type CheckinClaim,
  type CheckinReport,
  type Command,
  type Failure,
  type Output,
  output,
  type StatusBody,
  type T3State,
} from "./contract.ts"
import { parseEnvFile, redactor } from "./env.ts"
import { ClientError } from "./errors.ts"
import { findCommand, systemCommand } from "./exec.ts"
import { MCP_TARGETS, type McpTarget, setupMcp } from "./mcp-setup.ts"
import { syncClient } from "./oauth.ts"
import { type Deps, EXIT_NOTHING_PUSHED, EXIT_OK, EXIT_USAGE, runSync } from "./run.ts"
import { DEFAULT_T3_URL, dataDir, envFileToRead, type Resolved, resolveSettings } from "./settings.ts"
import { readStatus, runningSince } from "./state.ts"
import { t3Session } from "./t3-session.ts"

export const USAGE = `Usage: node adiutor-sync.js run [--env <file>] [--overview <dir>] [--no-collect] [--dry-run] [--request <id>] [--json]
       node adiutor-sync.js status [--url <url>] [--env <file>] [--json]
       node adiutor-sync.js connect --name <name> [--url <url>] [--env <file>] [--replace] [--no-open] [--json]
       node adiutor-sync.js disconnect [--url <url>] [--env <file>] [--json]
       node adiutor-sync.js t3-connect [--env <file>] [--json]
       node adiutor-sync.js t3-disconnect [--env <file>] [--json]
       node adiutor-sync.js checkin [--url <url>] [--env <file>] [--json] < report.json
       node adiutor-sync.js setup-mcp --for <claude|codex> [--url <url>] [--env <file>]

run: runs the overview collector, reads T3's projects with the sync's T3 session and every project's threads through
the T3 CLI, and sends both to Adiutor. One run at a time: a second one answers that a run is going.

  --overview <dir>   overview checkout (default: ADIUTOR_OVERVIEW_DIR)
  --env <file>       KEY=VALUE file with the settings below (default: the sync.env that connect writes, if any)
  --no-collect       do not run the collector; use the newest existing snapshot
  --dry-run          print payload sizes and a sample; send nothing
  --request <id>     the sync request from Adiutor this run serves (from checkin); named in the run's report
  --json             one JSON object per line: events, then one result (see docs/sync.md)

Settings: ADIUTOR_URL, T3CODE_CLI_PATH (default: T3's own install), ADIUTOR_T3_URL (default: ${DEFAULT_T3_URL}),
ADIUTOR_OVERVIEW_DIR: an option, the env file, the environment, then the settings file in the sync's data folder.
Exit code: 0 when something was sent, 1 when nothing could be sent, 2 for bad arguments or settings.

status: the Adiutor connection, the T3 session, the last run and the last good sync. Nothing is sent.

connect: connects the sync to Adiutor. You approve it in Adiutor in the browser and keep the sync area ticked.

  --name <name>      the name the approval page and Settings, Agent access show (required, up to ${NAME_MAX} characters)
  --url <url>        Adiutor's address (default: ADIUTOR_URL from the env file, the environment or the settings file)
  --env <file>       the sync's env file, which gets ADIUTOR_URL (default: %LOCALAPPDATA%\\adiutor\\sync.env on
                     Windows, ~/.config/adiutor/sync.env elsewhere)
  --replace          connect again while a connection is kept; the old one ends once the new one is kept
  --no-open          do not open the browser; open the printed link yourself
Exit code: 0 when connected, 1 when not, 2 for bad arguments.

disconnect: ends the sync's connection at Adiutor, then forgets it. When Adiutor's answer is lost, the revocation is
kept and every later command tries it again. Exit code: 0 when done, 1 when the revocation is still pending.

t3-connect: issues the sync's read-only T3 session on this computer (t3 auth session issue) and keeps it in the
sync's connection folder; a session it had is replaced. t3-disconnect: revokes it, then forgets it.

checkin: the tray's check-in. Reads its report, one JSON object, on stdin (version, paused, pausedUntil, nextRunAt,
running, finished; see docs/sync.md), sends it to Adiutor, and keeps a sync request Adiutor hands back in the data
folder before it answers. Exit code: 0 when Adiutor answered, 1 when not, 2 for bad arguments or a bad report.

setup-mcp: sets up Claude Code or Codex to use Adiutor's MCP server with OAuth, replacing a setup with a key.

  --for <client>     claude: the adiutor entry of Claude Code's user scope (claude mcp remove, then add)
                     codex: Codex's adiutor entry (codex mcp list --json decides; add or login signs in)
  --url <url>        Adiutor's address (default: ADIUTOR_URL from the env file, the environment or the settings file)
Exit code: 0 when set up, 1 when something is left to do by hand, 2 for bad arguments.`

export type MainDeps = Deps &
  Partial<Pick<ConnectDeps, "sleep" | "platform" | "findCommand" | "systemCommand">> & {
    /** The whole of stdin, for `checkin`'s report; the process's own unless a test gives it. */
    stdin?: () => Promise<string>
  }

const COMMANDS: readonly string[] = [
  "status",
  "connect",
  "disconnect",
  "t3-connect",
  "t3-disconnect",
  "run",
  "checkin",
  "setup-mcp",
]

type Values = {
  overview?: string
  env?: string
  "no-collect"?: boolean
  "dry-run"?: boolean
  name?: string
  for?: string
  url?: string
  replace?: boolean
  "no-open"?: boolean
  request?: string
  help?: boolean
  json?: boolean
}

export async function main(argv: string[], deps: MainDeps): Promise<number> {
  // The old agent key is never printed, whatever line it would land in.
  const secrets: Array<string | undefined> = [deps.env.ADIUTOR_AGENT_TOKEN]
  const out = output(argv.includes("--json"), (line) => deps.out(redactor(secrets)(line)))
  let command: Command | null = null
  try {
    let parsed: { values: Values; positionals: string[] }
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          overview: { type: "string" },
          env: { type: "string" },
          "no-collect": { type: "boolean" },
          "dry-run": { type: "boolean" },
          name: { type: "string" },
          for: { type: "string" },
          url: { type: "string" },
          replace: { type: "boolean" },
          "no-open": { type: "boolean" },
          request: { type: "string" },
          help: { type: "boolean", short: "h" },
          json: { type: "boolean" },
        },
      })
    } catch {
      return usage(out, "unknown or incomplete option")
    }
    const { values, positionals } = parsed
    if (values.help || positionals[0] === "help") {
      out.say(USAGE)
      out.result({ command: null, ok: true })
      return EXIT_OK
    }
    const name = positionals[0]
    if (positionals.length !== 1 || !name || !COMMANDS.includes(name)) return usage(out, "unknown command")
    if (name === "setup-mcp") {
      if (out.json) return usage(out, "setup-mcp has no --json output")
      return setupMcpCommand(values, deps, out)
    }
    command = name as Command
    // connect creates the env file it is given, and lets the environment win as before; every other command needs a
    // given one to be readable, and it wins over the environment.
    const resolved = await settingsFor(values, deps, command !== "connect")
    if ("error" in resolved) {
      out.say(`config: ${resolved.error}`)
      out.result({ command, ok: false, error: { code: "usage", message: resolved.error } })
      return EXIT_USAGE
    }
    secrets.push(resolved.oldTokenValue)
    const { settings } = resolved
    switch (command) {
      case "status":
        return await statusCommand(settings, deps, out)
      case "connect":
        return await connectCommand(values, settings, deps, out)
      case "disconnect":
        return await disconnectCommand(settings, deps, out)
      case "t3-connect":
        return await t3ConnectCommand(settings, deps, out)
      case "t3-disconnect":
        return await t3DisconnectCommand(settings, deps, out)
      case "checkin":
        return await checkinCommand(settings, deps, out)
      case "run": {
        if (values.request !== undefined && !isRequestId(values.request)) return usage(out, "--request must be an id")
        const { exit, body } = await runSync(
          {
            collect: !values["no-collect"],
            dryRun: values["dry-run"] === true,
            settings,
            oldToken: resolved.oldTokenValue !== undefined,
            ...(values.request ? { requestId: values.request.toLowerCase() } : {}),
          },
          deps,
          out,
        )
        out.result({ command: "run", ok: !body.error && !body.busy, ...body })
        return exit
      }
    }
  } catch (error) {
    // Every path ends in one result, an unexpected failure too; its message holds no secret.
    const message = error instanceof ClientError ? error.message : `unexpected error (${errorCode(error)})`
    out.say(`${command ?? "sync"}: ${message}`)
    out.result({ command, ok: false, error: { code: "internal_error", message } })
    return EXIT_NOTHING_PUSHED
  }
  return EXIT_NOTHING_PUSHED
}

function usage(out: Output, message: string): number {
  out.say(message)
  if (!out.json) out.say(USAGE)
  out.result({ command: null, ok: false, error: { code: "usage", message } })
  return EXIT_USAGE
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? "unknown"

const failure = (error: unknown): Failure =>
  error instanceof ClientError
    ? { code: error.code, message: error.message }
    : { code: "internal_error", message: `unexpected error (${errorCode(error)})` }

/** The settings of a command: the env file read (when --env is given it must be readable), then resolveSettings. */
async function settingsFor(
  values: Values,
  deps: MainDeps,
  requireEnvFile = true,
): Promise<{ settings: Resolved; oldTokenValue?: string } | { error: string }> {
  const platform = deps.platform ?? process.platform
  const target = envFileToRead(values.env, platform, deps.env)
  let vars: Record<string, string> = {}
  if (target) {
    try {
      vars = parseEnvFile(await readFile(target.path, "utf8"))
    } catch (error) {
      if (target.required && requireEnvFile) {
        const code = (error as NodeJS.ErrnoException).code
        return { error: `cannot read the env file: ${code ?? (error as Error).message}` }
      }
    }
  }
  const settings = resolveSettings({
    platform,
    env: deps.env,
    envFileVars: vars,
    envFileFirst: target?.required === true && requireEnvFile,
    ...(target ? { envFile: target.path } : {}),
    now: deps.now().getTime(),
    flags: { url: values.url, overviewDir: values.overview },
  })
  const oldToken = (vars.ADIUTOR_AGENT_TOKEN ?? deps.env.ADIUTOR_AGENT_TOKEN ?? "").trim()
  return { settings, ...(oldToken ? { oldTokenValue: oldToken } : {}) }
}

function connectDeps(deps: MainDeps): ConnectDeps {
  const platform = deps.platform ?? process.platform
  return {
    fetch: deps.fetch,
    out: deps.out,
    runner: deps.runner,
    findCommand: deps.findCommand ?? ((command) => findCommand(command, platform, deps.env)),
    systemCommand: deps.systemCommand ?? ((command) => systemCommand(command, deps.env)),
    platform,
    env: deps.env,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: () => deps.now().getTime(),
    httpTimeoutMs: deps.httpTimeoutMs,
  }
}

function sessionOf(settings: Resolved, deps: MainDeps) {
  const all = connectDeps(deps)
  return t3Session({
    ...all,
    cliPath: settings.cliPath,
    origin: settings.t3Url ?? DEFAULT_T3_URL,
    ...(deps.processCreation ? { processCreation: deps.processCreation } : {}),
    ...(deps.t3Checkpoint ? { checkpoint: deps.t3Checkpoint } : {}),
  })
}

const URL_PROBLEM = "--url (or ADIUTOR_URL) must be Adiutor's address alone: https, or http on localhost"
const PENDING: Failure = {
  code: "revocation_pending",
  message: "The connection is forgotten here, and its revocation is kept: every later command tries it again.",
}

// --- status ---

async function statusCommand(settings: Resolved, deps: MainDeps, out: Output): Promise<number> {
  const all = connectDeps(deps)
  let adiutor: AdiutorState = { state: "not_connected", url: settings.url ?? null, revocationPending: false }
  const problems = [...settings.problems]
  let identity: string | null = null
  if (settings.url) {
    try {
      const client = syncClient(settings.url, all)
      const pending = await client.retryRevocations().catch(() => true)
      const kept = await client.status()
      identity = await client.identity()
      adiutor = {
        state: kept.state,
        url: settings.url,
        ...(kept.connected ? { label: kept.label, scope: kept.scope } : {}),
        revocationPending: pending || kept.revocationPending,
      }
    } catch (error) {
      problems.push(`the Adiutor connection cannot be read: ${failure(error).message}`)
    }
  }
  let t3: T3State = { state: "not_connected", revocationPending: false }
  try {
    t3 = await sessionOf(settings, deps).status()
  } catch (error) {
    problems.push(`the T3 session cannot be read: ${failure(error).message}`)
  }
  const data = dataDir(all.platform, deps.env)
  const kept = readStatus(data)
  const body: StatusBody = {
    adiutor,
    t3,
    lastRun: kept.lastRun,
    lastGoodSyncAt: kept.lastGoodSyncAt,
    running: runningSince(data, { platform: all.platform, env: deps.env }),
    paused: settings.pause,
    claim: readClaim(data, identity),
    settings: { problems },
  }
  const said: Record<AdiutorState["state"], string> = {
    connected: `connected to ${adiutor.url} as "${adiutor.label}" (${adiutor.scope})`,
    not_connected: adiutor.url ? `not connected to ${adiutor.url}` : "not connected (no address set)",
    ended: `the connection to ${adiutor.url} has ended; connect again with --replace`,
  }
  out.say(`Adiutor: ${said[adiutor.state]}${adiutor.revocationPending ? "; a revocation is still pending" : ""}`)
  const t3Said =
    t3.state === "connected"
      ? `connected (environment ${t3.environmentId}, the session lasts until ${t3.expiresAt})`
      : t3.state === "ended"
        ? t3.reason === "other_environment"
          ? "ended: T3 address points to another environment; connect T3 again"
          : "ended: T3 refused the session; connect T3 again"
        : "not connected"
  out.say(`T3: ${t3Said}${t3.revocationPending ? "; a revocation is still pending" : ""}`)
  const last = kept.lastRun
  out.say(
    last
      ? `Last run: ${last.finishedAt}: T3 ${last.t3.result}, security ${last.security.result}`
      : "Last run: none recorded",
  )
  out.say(`Last good sync: ${kept.lastGoodSyncAt ?? "none recorded"}`)
  if (body.running) out.say(`A run is going since ${body.running.startedAt}`)
  if (body.paused) out.say(`Paused ${body.paused.until ? `until ${body.paused.until}` : "until resumed"}`)
  if (body.claim) out.say(`A sync request from Adiutor is kept to run: ${body.claim.requestId}`)
  for (const problem of problems) out.say(`Problem: ${problem}`)
  out.result({ command: "status", ok: true, ...body })
  return EXIT_OK
}

// --- connect and disconnect (Adiutor) ---

async function connectCommand(values: Values, settings: Resolved, deps: MainDeps, out: Output): Promise<number> {
  const all = { ...connectDeps(deps), out: out.say }
  const problems: string[] = []
  if (values.for !== undefined)
    problems.push("connect connects the sync only; for Claude Code or Codex run setup-mcp --for <claude|codex>")
  const name = (values.name ?? "").trim()
  if (!name || [...name].length > NAME_MAX) problems.push(`--name is required, up to ${NAME_MAX} characters`)
  const envFile = values.env ?? defaultEnvFile(all.platform, deps.env)
  if (!settings.url) problems.push(URL_PROBLEM)
  if (problems.length > 0 || !settings.url) {
    const message = problems.join("; ")
    out.say(`connect: ${message}`)
    out.result({ command: "connect", ok: false, state: "not_connected", error: { code: "usage", message } })
    return EXIT_USAGE
  }
  const outcome = await connect(
    { url: settings.url, name, envFile, open: values["no-open"] !== true, replace: values.replace === true },
    { ...all, approval: (link, userCode) => out.event({ event: "approval", link, userCode }) },
  )
  out.result({
    command: "connect",
    ok: outcome.state !== "not_connected",
    state: outcome.state,
    ...(outcome.scope !== undefined ? { scope: outcome.scope } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  })
  return outcome.exit
}

async function disconnectCommand(settings: Resolved, deps: MainDeps, out: Output): Promise<number> {
  if (!settings.url) {
    out.say(`disconnect: ${URL_PROBLEM}`)
    out.result({
      command: "disconnect",
      ok: false,
      wasConnected: false,
      revocationPending: false,
      error: { code: "usage", message: URL_PROBLEM },
    })
    return EXIT_USAGE
  }
  try {
    const done = await syncClient(settings.url, connectDeps(deps)).disconnect()
    if (!done.wasConnected) out.say(`The sync is not connected to ${settings.url}.`)
    else out.say(`The sync is disconnected from ${settings.url}.`)
    if (done.revocationPending)
      out.say("Adiutor did not confirm the revocation; it is kept and every later command tries it again.")
    else if (done.wasConnected) out.say("Adiutor ended the connection.")
    out.result({
      command: "disconnect",
      ok: !done.revocationPending,
      ...done,
      ...(done.revocationPending ? { error: PENDING } : {}),
    })
    return done.revocationPending ? EXIT_NOTHING_PUSHED : EXIT_OK
  } catch (error) {
    out.say(`disconnect: ${failure(error).message}`)
    out.result({
      command: "disconnect",
      ok: false,
      wasConnected: false,
      revocationPending: false,
      error: failure(error),
    })
    return EXIT_NOTHING_PUSHED
  }
}

// --- t3-connect and t3-disconnect ---

async function t3ConnectCommand(settings: Resolved, deps: MainDeps, out: Output): Promise<number> {
  if (!settings.t3Url) {
    const message = "T3's address must be its address alone: http on this computer, or https"
    out.say(`t3-connect: ${message}`)
    out.result({ command: "t3-connect", ok: false, error: { code: "usage", message } })
    return EXIT_USAGE
  }
  try {
    const session = await sessionOf(settings, deps).connect()
    out.say(
      `T3 is connected: a read-only session for environment ${session.environmentId}, until ${session.expiresAt}. It is kept in the sync's connection folder, readable by you only.`,
    )
    out.result({ command: "t3-connect", ok: true, environmentId: session.environmentId, expiresAt: session.expiresAt })
    return EXIT_OK
  } catch (error) {
    out.say(`t3-connect: ${failure(error).message}`)
    out.result({ command: "t3-connect", ok: false, error: failure(error) })
    return EXIT_NOTHING_PUSHED
  }
}

async function t3DisconnectCommand(settings: Resolved, deps: MainDeps, out: Output): Promise<number> {
  try {
    const done = await sessionOf(settings, deps).disconnect()
    out.say(done.wasConnected ? "T3 is disconnected." : "T3 is not connected.")
    if (done.revocationPending)
      out.say("T3 did not confirm the revocation; it is kept and every later T3 command tries it again.")
    out.result({
      command: "t3-disconnect",
      ok: !done.revocationPending,
      ...done,
      ...(done.revocationPending ? { error: PENDING } : {}),
    })
    return done.revocationPending ? EXIT_NOTHING_PUSHED : EXIT_OK
  } catch (error) {
    out.say(`t3-disconnect: ${failure(error).message}`)
    out.result({
      command: "t3-disconnect",
      ok: false,
      wasConnected: false,
      revocationPending: false,
      error: failure(error),
    })
    return EXIT_NOTHING_PUSHED
  }
}

// --- checkin ---

async function checkinCommand(settings: Resolved, deps: MainDeps, out: Output): Promise<number> {
  const all = connectDeps(deps)
  const data = dataDir(all.platform, deps.env)
  const fail = (error: Failure, exit: number, claim: CheckinClaim | null = null) => {
    out.say(`checkin: ${error.message}`)
    out.result({ command: "checkin", ok: false, claim, error })
    return exit
  }
  if (!settings.url) return fail({ code: "usage", message: URL_PROBLEM }, EXIT_USAGE)
  const client = syncClient(settings.url, all)
  let report: CheckinReport
  try {
    report = parseReport(await (deps.stdin ?? readStdin)())
  } catch (error) {
    return fail(failure(error), EXIT_USAGE, readClaim(data, await client.identity().catch(() => null)))
  }
  await client.retryRevocations().catch(() => true)
  let round: Awaited<ReturnType<typeof checkinRound>>
  try {
    round = await checkinRound(data, client, report, {
      platform: all.platform,
      env: deps.env,
      now: all.now,
      sleep: all.sleep,
    })
  } catch (error) {
    return fail(failure(error), EXIT_NOTHING_PUSHED, readClaim(data, await client.identity().catch(() => null)))
  }
  const { sent, claim } = round
  if (!sent.ok) return fail({ code: sent.code, message: sent.message }, EXIT_NOTHING_PUSHED, claim)
  out.say(sent.claim ? `Adiutor asks for a sync: request ${sent.claim}` : "Checked in; no sync request waits.")
  out.result({ command: "checkin", ok: true, claim: sent.claim ? claim : null })
  return EXIT_OK
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

// --- setup-mcp (no JSON output) ---

async function setupMcpCommand(values: Values, deps: MainDeps, out: Output): Promise<number> {
  const all = connectDeps(deps)
  const problems: string[] = []
  const target = values.for as McpTarget | undefined
  if (!target || !(MCP_TARGETS as readonly string[]).includes(target)) problems.push("--for must be claude or codex")
  const resolved = await settingsFor(values, deps, false)
  const url = "error" in resolved ? undefined : resolved.settings.url
  if (!url) problems.push(URL_PROBLEM)
  if (problems.length > 0 || !url || !target) {
    out.say(`setup-mcp: ${problems.join("; ")}`)
    return EXIT_USAGE
  }
  return setupMcp(url, target, all)
}
