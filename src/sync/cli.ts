import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import {
  type ConnectDeps,
  connect,
  DAYS_MAX,
  DAYS_MIN,
  defaultEnvFile,
  NAME_MAX,
  TARGETS,
  type Target,
} from "./connect.ts"
import { parseEnvFile } from "./env.ts"
import { type Deps, EXIT_USAGE, runSync } from "./run.ts"

export const DEFAULT_DAYS = 90

export const USAGE = `Usage: node mikud-sync.js run --projects <file> [options]
       node mikud-sync.js connect --name <name> --for <sync|claude|codex> [options]

run: runs the overview collector, reads every T3 project's threads and sends both to Mikud.

  --projects <file>  T3 projects file written by the scheduled agent from t3_project_list (required)
  --overview <dir>   overview checkout (default: MIKUD_OVERVIEW_DIR)
  --env <file>       KEY=VALUE file with the settings below; it wins over the environment
  --no-collect       do not run the collector; use the newest existing snapshot
  --dry-run          print payload sizes and a sample; send nothing

Settings: MIKUD_URL, MIKUD_AGENT_TOKEN, T3CODE_CLI_PATH, MIKUD_OVERVIEW_DIR.
The token is read only from the environment or the env file, never from the command line.
Exit code: 0 when something was sent, 1 when nothing could be sent, 2 for bad arguments or settings.

connect: you approve the agent in Mikud in the browser; it then gets one agent key.

  --name <name>      the name Settings, Agent access shows (required, up to ${NAME_MAX} characters)
  --for <target>     sync: save the key in the sync's env file (readable by you only)
                     claude: print the claude mcp add command once
                     codex: print the ~/.codex/config.toml lines and the variable to set once
  --days <days>      how long the key works, ${DAYS_MIN} to ${DAYS_MAX} days (default ${DEFAULT_DAYS})
  --url <url>        Mikud's address (default: MIKUD_URL, then MIKUD_URL in the env file)
  --env <file>       the sync's env file (default: %LOCALAPPDATA%\\mikud\\sync.env on Windows,
                     ~/.config/mikud/sync.env elsewhere)
  --no-open          do not open the browser; open the printed link yourself
Exit code: 0 when connected, 1 when not, 2 for bad arguments.`

export type MainDeps = Deps & Partial<Pick<ConnectDeps, "sleep" | "platform">>

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
        days: { type: "string" },
        url: { type: "string" },
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

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Mikud's address for connect: https, or http on this machine only (the approval's session token travels in it).
 * Undefined when it is not one.
 */
export function connectUrl(value: string): string | undefined {
  const parsed = URL.canParse(value) ? new URL(value) : undefined
  if (!parsed || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname))) return undefined
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "")
}

async function connectCommand(
  values: { name?: string; for?: string; days?: string; url?: string; env?: string; "no-open"?: boolean },
  deps: MainDeps,
): Promise<number> {
  const platform = deps.platform ?? process.platform
  const problems: string[] = []
  const name = (values.name ?? "").trim()
  if (!name || name.length > NAME_MAX) problems.push(`--name is required, up to ${NAME_MAX} characters`)
  const target = values.for as Target | undefined
  if (!target || !(TARGETS as readonly string[]).includes(target)) problems.push("--for must be sync, claude or codex")
  const days = values.days === undefined ? DEFAULT_DAYS : Number(values.days)
  if (!Number.isInteger(days) || days < DAYS_MIN || days > DAYS_MAX)
    problems.push(`--days must be a whole number from ${DAYS_MIN} to ${DAYS_MAX}`)
  const envFile = values.env ?? defaultEnvFile(platform, deps.env)

  let raw = values.url ?? deps.env.MIKUD_URL
  if (!raw) {
    try {
      raw = parseEnvFile(await readFile(envFile, "utf8")).MIKUD_URL
    } catch {
      raw = undefined
    }
  }
  const url = raw ? connectUrl(raw.trim()) : undefined
  if (!url) problems.push("--url (or MIKUD_URL) must be Mikud's https address, or http on localhost")

  if (problems.length > 0 || !target || !url) {
    deps.out(`connect: ${problems.join("; ")}`)
    return EXIT_USAGE
  }
  return connect(
    { url, name, days, target, envFile, open: values["no-open"] !== true },
    {
      fetch: deps.fetch,
      out: deps.out,
      runner: deps.runner,
      platform,
      env: deps.env,
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: () => deps.now().getTime(),
      httpTimeoutMs: deps.httpTimeoutMs,
    },
  )
}
