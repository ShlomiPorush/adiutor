import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { type ConnectDeps, connect, defaultEnvFile, NAME_MAX } from "./connect.ts"
import { parseEnvFile } from "./env.ts"
import { findCommand, systemCommand } from "./exec.ts"
import { MCP_TARGETS, type McpTarget, setupMcp } from "./mcp-setup.ts"
import { ClientError, issuerOf } from "./oauth.ts"
import { type Deps, EXIT_USAGE, runSync } from "./run.ts"

export const USAGE = `Usage: node adiutor-sync.js run --projects <file> [options]
       node adiutor-sync.js connect --name <name> [--url <url>] [--env <file>] [--replace] [--no-open]
       node adiutor-sync.js setup-mcp --for <claude|codex> [--url <url>] [--env <file>]

run: runs the overview collector, reads every T3 project's threads and sends both to Adiutor.

  --projects <file>  T3 projects file written by the scheduled agent from t3_project_list (required)
  --overview <dir>   overview checkout (default: ADIUTOR_OVERVIEW_DIR)
  --env <file>       KEY=VALUE file with the settings below; it wins over the environment
  --no-collect       do not run the collector; use the newest existing snapshot
  --dry-run          print payload sizes and a sample; send nothing

Settings: ADIUTOR_URL, T3CODE_CLI_PATH, ADIUTOR_OVERVIEW_DIR. The connection is the one connect keeps.
Exit code: 0 when something was sent, 1 when nothing could be sent, 2 for bad arguments or settings.

connect: connects the sync to Adiutor. You approve it in Adiutor in the browser and keep the sync area ticked.

  --name <name>      the name the approval page and Settings, Agent access show (required, up to ${NAME_MAX} characters)
  --url <url>        Adiutor's address (default: ADIUTOR_URL, then ADIUTOR_URL in the env file)
  --env <file>       the sync's env file, which gets ADIUTOR_URL (default: %LOCALAPPDATA%\\adiutor\\sync.env on
                     Windows, ~/.config/adiutor/sync.env elsewhere)
  --replace          connect again while a connection is kept; the old one ends once the new one is kept
  --no-open          do not open the browser; open the printed link yourself
Exit code: 0 when connected, 1 when not, 2 for bad arguments.

setup-mcp: sets up Claude Code or Codex to use Adiutor's MCP server with OAuth, replacing a setup with a key.

  --for <client>     claude: the adiutor entry of Claude Code's user scope (claude mcp remove, then add)
                     codex: Codex's adiutor entry (codex mcp list --json decides; add or login signs in)
  --url <url>        Adiutor's address (default: ADIUTOR_URL, then ADIUTOR_URL in the env file)
Exit code: 0 when set up, 1 when something is left to do by hand, 2 for bad arguments.`

export type MainDeps = Deps & Partial<Pick<ConnectDeps, "sleep" | "platform" | "findCommand" | "systemCommand">>

export async function main(argv: string[], deps: MainDeps): Promise<number> {
  const parse = (args: string[]) =>
    parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        projects: { type: "string" },
        overview: { type: "string" },
        env: { type: "string" },
        "no-collect": { type: "boolean" },
        "dry-run": { type: "boolean" },
        name: { type: "string" },
        for: { type: "string" },
        url: { type: "string" },
        replace: { type: "boolean" },
        "no-open": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    })
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(argv)
  } catch {
    deps.out("unknown or incomplete option")
    deps.out(USAGE)
    return EXIT_USAGE
  }
  const { values, positionals } = parsed
  if (values.help || positionals[0] === "help") {
    deps.out(USAGE)
    return 0
  }
  if (positionals.length === 1 && positionals[0] === "connect") return connectCommand(values, deps)
  if (positionals.length === 1 && positionals[0] === "setup-mcp") return setupMcpCommand(values, deps)
  if (positionals.length !== 1 || positionals[0] !== "run" || !values.projects) {
    deps.out(USAGE)
    return EXIT_USAGE
  }
  return runSync(
    {
      projectsFile: values.projects,
      overviewDir: values.overview,
      envFile: values.env,
      collect: !values["no-collect"],
      dryRun: values["dry-run"] === true,
    },
    deps,
  )
}

/** Adiutor's address: --url, ADIUTOR_URL, then ADIUTOR_URL in the env file; undefined when there is no usable one. */
async function addressOf(value: string | undefined, envFile: string, deps: MainDeps): Promise<string | undefined> {
  let raw = value ?? deps.env.ADIUTOR_URL
  if (!raw) {
    try {
      raw = parseEnvFile(await readFile(envFile, "utf8")).ADIUTOR_URL
    } catch {
      raw = undefined
    }
  }
  if (!raw) return undefined
  try {
    return issuerOf(raw)
  } catch (error) {
    if (error instanceof ClientError) return undefined
    throw error
  }
}

const URL_PROBLEM = "--url (or ADIUTOR_URL) must be Adiutor's address alone: https, or http on localhost"

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

async function connectCommand(
  values: { name?: string; for?: string; url?: string; env?: string; replace?: boolean; "no-open"?: boolean },
  deps: MainDeps,
): Promise<number> {
  const all = connectDeps(deps)
  const problems: string[] = []
  if (values.for !== undefined)
    problems.push("connect connects the sync only; for Claude Code or Codex run setup-mcp --for <claude|codex>")
  const name = (values.name ?? "").trim()
  if (!name || [...name].length > NAME_MAX) problems.push(`--name is required, up to ${NAME_MAX} characters`)
  const envFile = values.env ?? defaultEnvFile(all.platform, deps.env)
  const url = await addressOf(values.url, envFile, deps)
  if (!url) problems.push(URL_PROBLEM)
  if (problems.length > 0 || !url) {
    deps.out(`connect: ${problems.join("; ")}`)
    return EXIT_USAGE
  }
  return connect({ url, name, envFile, open: values["no-open"] !== true, replace: values.replace === true }, all)
}

async function setupMcpCommand(values: { for?: string; url?: string; env?: string }, deps: MainDeps): Promise<number> {
  const all = connectDeps(deps)
  const problems: string[] = []
  const target = values.for as McpTarget | undefined
  if (!target || !(MCP_TARGETS as readonly string[]).includes(target)) problems.push("--for must be claude or codex")
  const url = await addressOf(values.url, values.env ?? defaultEnvFile(all.platform, deps.env), deps)
  if (!url) problems.push(URL_PROBLEM)
  if (problems.length > 0 || !url || !target) {
    deps.out(`setup-mcp: ${problems.join("; ")}`)
    return EXIT_USAGE
  }
  return setupMcp(url, target, all)
}
