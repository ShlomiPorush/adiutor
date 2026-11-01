# Sync tool

Status: built and tested against fixtures and a stub server. The server routes it calls (`/api/v1/sync/t3`, `/api/v1/sync/security`) are on `main`; see [api.md](api.md). Not yet run against a Mikud server; that happens in the dry run.

`dist/sync/mikud-sync.js` runs on the owner's PC, started by the T3 scheduled task in [prompts/reconcile.md](../prompts/reconcile.md). It is the only way T3 and GitHub data reach Mikud: the server never calls T3 or GitHub.

## What one run does

1. Runs the `overview` collector (`node src/cli.mjs collect` in the overview checkout, 20 minute limit), then reads the newest snapshot: the run in `data/latest-run.txt`, or else the newest readable `data/runs/<runId>/snapshot.json`. When the collector fails (for example, another overview run holds its lock), the newest existing snapshot is used and the output says so.
2. Reads the projects file that the scheduled agent wrote from `t3_project_list`. Deleted projects and projects whose id holds characters other than letters, digits, `.`, `_`, `:` and `-` are skipped and counted.
3. Runs `t3 thread list --project <id> --json` for every project, four at a time, 2 minute limit each. Top-level and child threads are both sent with their `parentThreadId`; the server folds child threads into their parent's item. Projects whose threads could not be read, or whose thread list had invalid records, are sent as `failedProjects`, so the server records the run as `partial` and does not decide their items in that run. When no project could be read, the T3 payload is not sent.
4. Finds each project's GitHub repository: from T3's repository identity when its provider is GitHub, otherwise by matching the project's folder (`workspaceRoot` or the identity's `rootPath`) against the snapshot's local repositories and their worktrees, ignoring case and separators.
5. Sends `POST /api/v1/sync/t3`, then `POST /api/v1/sync/security` for the project repositories found in the snapshot, and prints each answer.

Security values follow the snapshot honestly: an enabled family sends its alert counts by severity; a family carried over from an earlier run (`stale.since`) keeps its counts with that time as `asOf`; `not-enabled`, `no-access` and `error` keep their meaning; a missing or unrecognized family is `unknown`. `asOf` is always the source's last successful read, never the time of the sync. Code scanning rule levels are counted, never dropped: `error` and an unknown severity as medium, `warning` and `note` as low.

## Settings

Read from the environment, or from a `--env` file of `KEY=VALUE` lines, which wins over the environment:

| Name | Purpose |
|---|---|
| `MIKUD_URL` | Base URL of the Mikud server, for example `https://mikud.example.com` |
| `MIKUD_AGENT_TOKEN` | The agent token. Never accepted on the command line, never printed (any echo is replaced with `[redacted]`), never passed to a child process |
| `T3CODE_CLI_PATH` | The T3 CLI. T3 sets it for its agents; on Windows it is a `.cmd` file |
| `MIKUD_OVERVIEW_DIR` | The `overview` checkout; `--overview` overrides it |

Keep the env file outside every repository, for example `%LOCALAPPDATA%\mikud\sync.env`, readable only by the owner.

## Commands

```
node dist/sync/mikud-sync.js run --projects <file> [--env <file>] [--overview <dir>] [--no-collect] [--dry-run]
```

- `--no-collect` uses the newest existing snapshot without running the collector.
- `--dry-run` prints the payload sizes and a sample and sends nothing; it needs no URL or token.
- Exit code 0 when at least one payload was accepted (or a dry run had something to send), 1 when nothing could be sent, 2 for bad arguments or settings.

## Building it on the PC

`dist/` is not tracked. Build the bundle from the Mikud checkout in WSL:

```bash
source scripts/lib/common.sh && build_toolchain && install_deps && in_toolchain "pnpm build:sync"
```

The bundle needs only Node.js 24 on Windows; it has no runtime dependencies.

## Safety

- Child processes run through `execFile` with an argument array and no shell. Node refuses to start a `.cmd` file without a shell, so the T3 CLI runs as `cmd.exe /d /v:off /s /c ""<cli>" "thread" "list" "--project" "<id>" "--json""`. Every part is quoted; a part holding a quote, a percent sign or a line break is refused, because `cmd.exe` would still expand or split it inside quotes.
- Titles, paths and other text from T3 and the snapshot travel only as JSON to the API, never into a command line or a prompt.
- Redirects are refused, so the token is sent only to `MIKUD_URL`.
