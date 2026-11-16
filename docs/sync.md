# Sync tool

Status: built and tested against fixtures, a stand-in Adiutor and, in the integration tests, the real authorization server. It connects by agent access by approval, so it works against the agent access release and later only: an Adiutor before it has no authorization server. The server routes it calls (`/api/v1/sync/t3`, `/api/v1/sync/security`) are on `main`; see [api.md](api.md). Not yet run against an Adiutor server; that happens in the launch checks in production.

`dist/sync/adiutor-sync.js` runs on the owner's PC, started by the T3 scheduled task in [prompts/reconcile.md](../prompts/reconcile.md). It is the only way T3 and GitHub data reach Adiutor: the server never calls T3 or GitHub.

## What one run does

1. Runs the `overview` collector (`node src/cli.mjs collect` in the overview checkout, 20 minute limit), then reads the newest snapshot: the run in `data/latest-run.txt`, or else the newest readable `data/runs/<runId>/snapshot.json`. When the collector fails (for example, another overview run holds its lock), the newest existing snapshot is used and the output says so.
2. Reads the projects file that the scheduled agent wrote from `t3_project_list`. Deleted projects and projects whose id holds characters other than letters, digits, `.`, `_`, `:` and `-` are skipped and counted.
3. Runs `t3 thread list --project <id> --json` for every project, four at a time, 2 minute limit each. Top-level and child threads are both sent with their `parentThreadId`; the server folds child threads into their parent's item. Projects whose threads could not be read, or whose thread list had invalid records, are sent as `failedProjects`, so the server records the run as `partial` and does not decide their items in that run. When no project could be read, the T3 payload is not sent.
4. Finds each project's GitHub repository: from T3's repository identity when its provider is GitHub, otherwise by matching the project's folder (`workspaceRoot` or the identity's `rootPath`) against the snapshot's local repositories and their worktrees, ignoring case and separators.
5. Sends `POST /api/v1/sync/t3`, then `POST /api/v1/sync/security` for the project repositories found in the snapshot, over the connection `connect` kept (below), and prints each answer. First it reads Adiutor's endpoints listing once and sends each push with the listing's policy revision (`X-Adiutor-Policy`) and the kind it gives (`X-Adiutor-Kind: act`); when the listing cannot be read, or does not hold the push, nothing is sent. A push whose answer was lost, or that Adiutor answered with a server error, is reported as `outcome unknown` and never sent again in that run: a push carries the whole state, so the next run decides again. Adiutor's reserved refusals made before any route code runs get one more try each: `401 invalid_token` a refresh and the push again, `429 busy` a short wait, `409 policy_changed` the listing again. When the connection has ended, the run says `The sync is disconnected from Adiutor; reconnect it` with the `connect` command to run.

The server refuses times more than 5 minutes ahead of its own clock ([api.md](api.md), "Times later than the server's clock"). Keep the PC's clock, and the clocks behind T3's and the collector's times, set automatically. When the PC runs ahead, the run prints `refused (HTTP 400)` with `validation_failed` and Settings, Sync shows the T3 run as failed; a single record that is ahead shows in the answer's `errors` as `time_in_future`.

Security values follow the snapshot honestly: an enabled family sends its alert counts by severity; a family carried over from an earlier run (`stale.since`) keeps its counts with that time as `asOf`; `not-enabled`, `no-access` and `error` keep their meaning; a missing or unrecognized family is `unknown`. `asOf` is always the source's last successful read, never the time of the sync. Code scanning rule levels are counted, never dropped: `error` and an unknown severity as medium, `warning` and `note` as low.

## Settings

Read from the environment, or from a `--env` file of `KEY=VALUE` lines, which wins over the environment:

| Name                   | Purpose                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `ADIUTOR_URL`          | Adiutor's address alone, for example `https://adiutor.example.com` (https, or http on `localhost` only) |
| `T3CODE_CLI_PATH`      | The T3 CLI. T3 sets it for its agents; on Windows it is a `.cmd` file                                   |
| `ADIUTOR_OVERVIEW_DIR` | The `overview` checkout; `--overview` overrides it                                                      |

The env file holds no secret: `connect` writes `ADIUTOR_URL` into it (`%LOCALAPPDATA%\adiutor\sync.env` on Windows, `~/.config/adiutor/sync.env` elsewhere, readable only by the owner). `ADIUTOR_AGENT_TOKEN`, the agent key of the sync before agent access, is no longer read: when it is still set, each run says so once (never its value), and the owner deletes that line, and the key in Settings, Agent access, if it is still listed.

## The connection

The sync connects like the agent skill, as a client of the agent REST contract (`src/sync/oauth.ts`; the agent-access standard's client contract):

- **Where:** its own folder, never the skill's `~/.adiutor`: `%LOCALAPPDATA%\adiutor\connection` on Windows, which must be inside the user profile, and `$XDG_CONFIG_HOME/adiutor/connection` (`~/.config/adiutor/connection`) elsewhere. One file per Adiutor address (a hash of the address), written in one step through a private temporary file. No token is ever printed, logged, put on a command line or handed to a child process.
- **Owner-only, checked, never loosened:** mode 0700 and 0600 elsewhere; on Windows `%SystemRoot%\System32\icacls.exe` limits the folder to the user, SYSTEM and Administrators, makes the user its owner, and reads the access lists back (`/save`), refusing any other entry. Every run checks the folder again before it reads the connection.
- **Refresh:** the access token (15 minutes) is reused until a minute before its end, so a run refreshes once, after the collection and before the first push. A refresh runs under the connection's lock (a file created exclusively, naming its holder; never taken from a live holder, taken over from a dead one by moving it aside), with its start written first. Adiutor rotates the refresh token on every use and ends the connection when a spent one comes back, so a refresh whose answer was lost is never sent again within 30 seconds, is tried once more after that (which continues the connection or ends it), and two lost answers end it on this computer.

## Commands

```
node dist/sync/adiutor-sync.js run --projects <file> [--env <file>] [--overview <dir>] [--no-collect] [--dry-run]
```

- `--no-collect` uses the newest existing snapshot without running the collector.
- `--dry-run` prints the payload sizes and a sample and sends nothing; it needs no URL or connection.
- Exit code 0 when at least one payload was accepted (or a dry run had something to send), 1 when nothing could be sent (an `outcome unknown` push counts as not accepted), 2 for bad arguments or settings.

## Connecting the sync

```
node dist/sync/adiutor-sync.js connect --name <name> [--url <url>] [--env <file>] [--replace] [--no-open]
```

1. Before it asks Adiutor for anything, it creates the env file (`--env`, or the default above) and restricts it to the current user (on Windows `icacls <file> /inheritance:r /grant:r <DOMAIN\user>:F`, read back; elsewhere 0600 in a 0700 folder), and prepares the connection's folder. It checks that the address answers as Adiutor with agents on (`/.well-known/oauth-authorization-server` names the same issuer).
2. It asks for a device code as Adiutor's built-in client `adiutor-agent`, for the `sync` area alone on the REST resource (`<url>/api/v1`), with `--name` (up to 60 characters) as `client_label`, the name the approval page and Settings, Agent access show. The page marks it as the name the agent gives itself: grant `sync` only to a sync you just started.
3. It prints the link with the code in it and the code (`ABCD-EFGH`), and opens the browser (`%SystemRoot%\System32\rundll32.exe url.dll,FileProtocolHandler` on Windows, `open` on macOS, `xdg-open` elsewhere, never a shell; `--no-open` skips it). The link must be on the address given.
4. It polls every 5 seconds (5 more after each `slow_down`) until the owner approves or denies, or the code ends. A poll whose answer was lost is never repeated (the code may have been spent): it stops and says to run `connect` again.
5. Approved, it keeps the connection (above) and sets `ADIUTOR_URL` in the env file, keeping every other line. When the `sync` area was not approved, it says so: the sync cannot push.

A connection already kept for the address is reported and left alone. `--replace` connects again (for example after the owner disconnected it in Settings, Agent access) and ends the old connection once the new one is kept. `--url` falls back to `ADIUTOR_URL` in the environment, then in the env file. Exit code 0 when connected, 1 when not, 2 for bad arguments. `connect --for claude|codex` is gone: `setup-mcp` below replaces it.

## Setting up Claude Code and Codex

```
node dist/sync/adiutor-sync.js setup-mcp --for <claude|codex> [--url <url>] [--env <file>]
```

Claude Code and Codex connect to Adiutor's MCP server (`<url>/mcp`) themselves, with OAuth; the owner approves each once in Adiutor, and no key or token passes through this command. It moves a setup that the old `connect --for` wrote (a static key) to that, and runs only the clients' own documented commands, never editing their files:

- **Claude Code:** `claude mcp get adiutor` first: an `adiutor` entry of local or project scope in the current folder is reported and left as it is. Then `claude mcp remove adiutor --scope user` (its answer `No MCP server named "adiutor" in user scope` means there is nothing to remove, also after a run that stopped there), then `claude mcp add --transport http --scope user adiutor "<url>/mcp"`, with no header. No other name or scope is touched. When the add fails after the remove, it prints that add command and says Adiutor is not set up in Claude Code until it runs. Claude Code signs in the first time it uses Adiutor (or through `/mcp`).
- **Codex:** `codex mcp list --json` decides, from the `adiutor` entry's URL, its bearer source (`bearer_token_env_var`, or an `Authorization` header) and its `auth_status`:
  - an old entry (a bearer source, or another transport than streamable HTTP): `codex mcp remove adiutor`, then `codex mcp add adiutor --url "<url>/mcp"`, which signs in at once when the server offers OAuth (Codex 0.169.0): one approval;
  - no entry: the same add: one approval;
  - exactly `<url>/mcp`, no bearer source, `auth_status` `o_auth` (signed in): nothing changes;
  - exactly `<url>/mcp`, no bearer source, `not_logged_in` (a sign-in that was cancelled or failed): `codex mcp login adiutor` once: one approval;
  - another URL, any other `auth_status` (`unknown` when the server cannot be reached), or a list that fails or is not JSON: nothing changes; it reports what it found and the commands to run by hand. An unknown or unreadable state is never read as not signed in.
- **`ADIUTOR_AGENT_KEY`**, where the old setup kept Codex's key, is removed only once `codex mcp list --json` shows no entry that reads it any longer: on Windows only that value, with `%SystemRoot%\System32\reg.exe delete HKCU\Environment /v ADIUTOR_AGENT_KEY /f` (new terminals no longer see it); elsewhere `~/.config/adiutor/codex.env` (`$XDG_CONFIG_HOME/adiutor/`) when it holds that variable alone, and it says to remove the `. "<file>"` line from the shell profile. The key itself is refused by Adiutor from the agent access release on.

A client's own sign-in status is not proof that Adiutor still accepts the connection: Settings, Agent access lists every connection with its last use, and one Adiutor ended is missing there. Exit code 0 when the client is set up (or was already), 1 when something is left to do by hand, 2 for bad arguments.

## Building it on the PC

`dist/` is not tracked. Build the bundle from the Adiutor checkout in WSL:

```bash
source scripts/lib/common.sh && build_toolchain && install_deps && in_toolchain "pnpm build:sync"
```

The bundle needs only Node.js 24 or later on Windows; it has no runtime dependencies. The server runs on Node.js 26, but `build:sync` stays at `--target=node24` on purpose, because the PC runs Node.js 24. After the PC moves to Node.js 26, the target can move to `node26` too.

## Safety

- Child processes run through `execFile` with an argument array and no shell. Started by bare name, Node looks in the current folder before `PATH` on Windows, so every command runs by its full path: `icacls`, `whoami`, `rundll32` and `reg` from `%SystemRoot%\System32` (where Windows installs them; only administrators can write there), `claude` and `codex` from the absolute `PATH` entries, and the T3 CLI from `T3CODE_CLI_PATH`. Node refuses to start a `.cmd` file without a shell, so the T3 CLI runs as `cmd.exe /d /v:off /s /c ""<cli>" "thread" "list" "--project" "<id>" "--json""`, and so does `codex.cmd` for `setup-mcp --for codex`. Every part is quoted; a part holding a quote, a percent sign or a line break is refused, because `cmd.exe` would still expand or split it inside quotes.
- Titles, paths and other text from T3 and the snapshot travel only as JSON to the API, never into a command line or a prompt.
- Redirects are not followed, so a token is sent only to `ADIUTOR_URL` (or `--url`).
