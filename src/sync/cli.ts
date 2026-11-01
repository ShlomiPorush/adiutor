import { parseArgs } from "node:util"
import { type Deps, EXIT_USAGE, runSync } from "./run.ts"

export const USAGE = `Usage: node mikud-sync.js run --projects <file> [options]

Runs the overview collector, reads every T3 project's threads and sends both to Mikud.

  --projects <file>  T3 projects file written by the scheduled agent from t3_project_list (required)
  --overview <dir>   overview checkout (default: MIKUD_OVERVIEW_DIR)
  --env <file>       KEY=VALUE file with the settings below; it wins over the environment
  --no-collect       do not run the collector; use the newest existing snapshot
  --dry-run          print payload sizes and a sample; send nothing

Settings: MIKUD_URL, MIKUD_AGENT_TOKEN, T3CODE_CLI_PATH, MIKUD_OVERVIEW_DIR.
The token is read only from the environment or the env file, never from the command line.
Exit code: 0 when something was sent, 1 when nothing could be sent, 2 for bad arguments or settings.`

export async function main(argv: string[], deps: Deps): Promise<number> {
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
