# Sync tool

Status: built and tested against fixtures, a stand-in Adiutor, a stand-in T3 and, in the integration tests, the real authorization server. It connects by agent access by approval, so it works against the agent access release and later only: an Adiutor before it has no authorization server. The server routes it calls (`/api/v1/sync/t3`, `/api/v1/sync/security`) are on `main`; see [api.md](api.md). Not yet run against an Adiutor server; that happens in the launch checks in production.

`dist/sync/adiutor-sync.js` runs on the owner's PC. You start it by hand, and the tray app (planned: the sync tray plan's third pull request) starts it on a schedule and reads its JSON answers. It is the only way T3 and GitHub data reach Adiutor: the server never calls T3 or GitHub.

## What one run does

One run at a time, across the tray and the command line: a run holds the run lock (`run.lock` in the data folder, a file created exclusively and naming its holder) for the whole run, the collector included. A second run does not wait: it answers that a run is going, with the first run's start time, and runs nothing. A lock whose holder died (same computer, process gone) is taken over: under a guard file named after that dead holder, created exclusively, the taker reads the lock again and removes it only when it still names the dead holder. Of several takers only one holds the guard, and none can remove a lock another one created. The connection's lock and the T3 lock are taken over the same way.

1. Runs the `overview` collector (`node src/cli.mjs collect` in the overview checkout, 20 minute limit), then reads the newest snapshot: the run in `data/latest-run.txt`, or else the newest readable `data/runs/<runId>/snapshot.json`. When the collector fails (for example, another overview run holds its lock), the newest existing snapshot is used and the output says so.
2. Reads T3's project list with the sync's T3 session (below): first `GET <T3 address>/.well-known/t3/environment` must name the session's environment, then `GET <T3 address>/api/projects` with the session. Deleted projects and projects whose id holds characters other than letters, digits, `.`, `_`, `:` and `-` are skipped and counted. A list read this way is kept as the last good list (`t3-projects.json` in the data folder, with its time). When T3 cannot be reached or fails (connection refused, timeout, a 5xx answer; an answer whose body breaks off counts by its status), the last good list is used and the output says `T3 projects from <time>`; with no last good list, T3 is not read. When T3 refuses the session (401), or its address or its CLI answers as another environment, the T3 part stops (no last good list, no thread list) until you connect T3 again.
3. Runs `t3 thread list --project <id> --json` for every project, four at a time, 2 minute limit each. Top-level and child threads are both sent with their `parentThreadId` and their snooze (`snoozed`, and `snoozedUntil` when T3 gives a time; D-T6: shown on the item, read by no sync rule); the server folds child threads into their parent's item. Projects whose threads could not be read, or whose thread list had invalid records, are sent as `failedProjects`, so the server records the run as `partial` and does not decide their items in that run. When no project could be read, the T3 payload is not sent. Each thread's `link` (`https://app.t3.codes/threads/<environment id>/<thread id>`) must name the session's environment. A thread whose link names no environment cannot be checked: its project counts as not read (`failedProjects`), and none of its threads is sent.
4. Finds each project's GitHub repository: from T3's repository identity when its provider is GitHub, otherwise by matching the project's folder (`workspaceRoot` or the identity's `rootPath`) against the snapshot's local repositories and their worktrees, ignoring case and separators. When this run has no project list (T3 stopped), security still maps the repositories from the last good project list, a local file, and reads nothing from T3; with no such list, security is not sent (`no_projects`).
5. Sends `POST /api/v1/sync/t3`, then `POST /api/v1/sync/security` for the project repositories found in the snapshot, over the connection `connect` kept (below), and prints each answer. Each push goes with the policy revision of Adiutor's endpoints listing (`X-Adiutor-Policy`) and the kind it gives (`X-Adiutor-Kind: act`). The listing is kept in the data folder (`endpoints-<hash of the address>.json`, written in one step; no secret: the open calls, their kinds and the revision, with the address) and reused by every later command, the check-in included (the agent-access client contract, "Kind from the server"). It is read again only when it is missing, cannot be read, is for another address, does not hold the call, or after a `409 policy_changed`; a new connection or a disconnect forgets it. When the listing cannot be read, or a fresh one does not hold the push, nothing is sent. A push whose answer was lost, or that Adiutor answered with a server error, is reported as `outcome unknown` and never sent again in that run: a push carries the whole state, so the next run decides again. Adiutor's reserved refusals made before any route code runs get one more try each: `401 invalid_token` a refresh and the push again, `429 busy` a short wait, `409 policy_changed` the listing again. When the connection has ended, the run says `The sync is disconnected from Adiutor; reconnect it` with the `connect` command to run.
6. Writes the run's report into the status file (`status.json` in the data folder, in one step, under the run lock; no secret). A dry run writes no report; it still keeps a project list it read as the last good list, and may renew or end the T3 session like any run.

**The result of each part** (T3, security): `accepted` (Adiutor answered `succeeded`), `partial` (Adiutor answered `partial`, or the input was incomplete: projects not read, `failedProjects` not empty, reason `projects_missing`; or project repositories missing from the snapshot, reason `repos_missing`), `failed` (Adiutor refused the push or answered `failed`, or the push was not made because of the connection), `outcome_unknown` (the answer was lost, Adiutor failed with a 5xx, or a 2xx answer had no outcome the sync can read) and `not_run` (not sent: the reason says why). The report also has the data's age: the time of the project list (`projectsAt`, with `projectsFrom` `t3` or `last_good`) and the snapshot's finish time (`snapshotAt`). The **last good sync** is the last run in which both parts were `accepted`. The exit code does not tell this.

The server refuses times more than 5 minutes ahead of its own clock ([api.md](api.md), "Times later than the server's clock"). Keep the PC's clock, and the clocks behind T3's and the collector's times, set automatically. When the PC runs ahead, the run prints `refused (HTTP 400)` with `validation_failed` and Settings, Sync shows the T3 run as failed; a single record that is ahead shows in the answer's `errors` as `time_in_future`.

Security values follow the snapshot honestly: an enabled family sends its alert counts by severity; a family carried over from an earlier run (`stale.since`) keeps its counts with that time as `asOf`; `not-enabled`, `no-access` and `error` keep their meaning; a missing or unrecognized family is `unknown`. `asOf` is always the source's last successful read, never the time of the sync. Code scanning rule levels are counted, never dropped: `error` and an unknown severity as medium, `warning` and `note` as low.

## Settings

The data folder is `%LOCALAPPDATA%\adiutor` on Windows and `$XDG_CONFIG_HOME/adiutor` (`~/.config/adiutor`) elsewhere. Each setting comes from the first of: an option (`--url`, `--overview`), the env file given with `--env`, the environment, `sync.env` in the data folder (when it exists and no `--env` was given), the settings file `settings.json` in the data folder, and the default. As before, `connect` and `setup-mcp` let the environment win over any env file:

| Name                   | Settings file key | Purpose                                                                                                 |
| ---------------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `ADIUTOR_URL`          | `adiutorUrl`      | Adiutor's address alone, for example `https://adiutor.example.com` (https, or http on `localhost` only) |
| `T3CODE_CLI_PATH`      | `t3CliPath`       | The T3 CLI; default `%USERPROFILE%\.t3\bin\t3.cmd` on Windows, `~/.t3/bin/t3` elsewhere                 |
| `ADIUTOR_T3_URL`       | `t3Url`           | T3's address alone; default `http://127.0.0.1:3773` (https, or http on this computer only)              |
| `ADIUTOR_OVERVIEW_DIR` | `overviewDir`     | The `overview` checkout; `--overview` overrides it                                                      |

The settings file is the tray's: it writes it, and the engine only reads it. It also holds the tray's pause, `"pause": {"until": "<time>"}` or `{"until": null}` (until resumed), which `status` reports. Neither file holds a secret: `connect` writes `ADIUTOR_URL` into the env file (`%LOCALAPPDATA%\adiutor\sync.env` on Windows, `~/.config/adiutor/sync.env` elsewhere, readable only by the owner). `ADIUTOR_AGENT_TOKEN`, the agent key of the sync before agent access, is no longer read: when it is still set, each run says so once (never its value), and the owner deletes that line, and the key in Settings, Agent access, if it is still listed.

## The connection

The sync connects like the agent skill, as a client of the agent REST contract (`src/sync/oauth.ts`; the agent-access standard's client contract):

- **Where:** its own folder, never the skill's `~/.adiutor`: `%LOCALAPPDATA%\adiutor\connection` on Windows, which must be inside the user profile, and `$XDG_CONFIG_HOME/adiutor/connection` (`~/.config/adiutor/connection`) elsewhere. One file per Adiutor address (a hash of the address), written in one step through a private temporary file. No token is ever printed, logged, put on a command line or handed to a child process.
- **Owner-only, checked, never loosened:** mode 0700 and 0600 elsewhere; on Windows `%SystemRoot%\System32\icacls.exe` limits the folder to the user, SYSTEM and Administrators, makes the user its owner, and reads the access lists back (`/save`), refusing any other entry. Every run checks the folder again before it reads the connection.
- **Refresh:** the access token (15 minutes) is reused until a minute before its end, so a run refreshes once, after the collection and before the first push. A refresh runs under the connection's lock (a file created exclusively, naming its holder; never taken from a live holder, taken over from a dead one as the run lock is), with its start written first. Adiutor rotates the refresh token on every use and ends the connection when a spent one comes back, so a refresh whose answer was lost is never sent again within 30 seconds, is tried once more after that (which continues the connection or ends it), and two lost answers end it on this computer.
- **Ended:** when Adiutor ends the connection (disconnected in Adiutor, unused for its idle days, sign-in settings changed, or a token used twice), the file is kept without any token, so `status` says it ended; `connect --replace` connects again.
- **Disconnect:** `disconnect` revokes the refresh token at Adiutor's revocation endpoint (`/oauth/revoke`, the authorization server library's own, which ends the whole connection), then deletes the file. Before the request leaves, the file is rewritten without any token and with the token to revoke, so a crash or a lost answer leaves it disconnected with the revocation pending, never active. When the revocation's answer is lost, the token is kept, with no connection, and every later command (`status`, `connect`, `disconnect`, `run`) tries the revocation again.

## The T3 session

The sync reads T3's project list with a read-only session of its own (owner's decision D-T4: 30 days), kept like the Adiutor connection in the owner-only connection folder (`t3-session.json`: session id, token, expiry, environment id, T3's address and the session's label). T3's own clients use `/api/projects`; it is not a documented public API, which is why the last good list exists.

- **`t3-connect`** reads T3's environment id from `<T3 address>/.well-known/t3/environment`, then, under the T3 lock (`t3.lock`), writes a pending record (`t3-pending.json`: a label `Adiutor sync <random id>` and its start), runs `t3 auth session issue --scope orchestration:read --ttl 30d --label "<label>" --json`, adds the child's process id and creation time to the record, checks the new session against T3's address (its project list must answer), saves the session in one step, and only then clears the record. A session it had is replaced: the old one is listed as pending revoke first, and revoked once the new one is saved. When the CLI's T3 and the address's T3 are different environments, the new session is revoked and nothing is kept.
- **Recovery:** every T3 command (`t3-connect`, `t3-disconnect`, `run`) first finishes what a cut-off command left. A pending issue is looked up only once its child is certainly gone (no process with that id and creation time, or, when the record names no child, two minutes after it started): in `t3 auth session list --json` by its label, the saved session is kept and any other session with that label is revoked. A `t3-disconnect` cut off before it deleted the session is finished: the session is deleted and revoked, and the T3 part stops. Any other pending revoke (a replaced session) is done only when the saved session is no longer that session; otherwise the entry is dropped. So a crash never revokes the only saved session the owner kept. An identity failure found in a run ends only the session that run read with, never one `t3-connect` saved meanwhile. Started from the command line, the engine's children can outlive it when it is stopped; the pending record's process id covers that.
- **Renewal:** when less than a quarter of the 30 days is left and the session still works, a run replaces it the same way. A renewal that fails keeps the old session.
- **Ended:** a 401 on the project list, or an address or a CLI that names another environment, marks the session ended. An address that answers without any environment id (not T3) only stops that run: the session is not sent there, and stays. It is never issued again on its own, and the T3 part of every run stops until `t3-connect`.
- **`t3-disconnect`** revokes the session with `t3 auth session revoke <id>`, then deletes it; a failed revoke stays pending and later T3 commands try it again. While a `t3-disconnect` that was cut off waits for the next T3 command to finish it, `status` reports T3 as `not_connected` with its revocation pending, from the files alone.
- Every T3 CLI call runs from T3's default data folder: `T3CODE_HOME`, `VITE_DEV_SERVER_URL` and `T3CODE_BOOTSTRAP_FD` (which T3 reads to move its data folder) are removed from its environment. The token goes only into the session file and the `Authorization` header to T3's address, never in a redirect; the output of `t3 auth session issue` is never printed.

## Requests from Adiutor

The owner can ask for a sync from Adiutor ("Sync now" in Settings, Sync and on the sync card). Adiutor never calls the computer: the tray app checks in every minute, also while a run is going, with `checkin --json`, and Adiutor hands back a waiting request in the answer ([api.md](api.md), "Sync requests").

```
node dist/sync/adiutor-sync.js checkin [--url <url>] [--env <file>] [--json] < report.json
```

- **The report** is one JSON object on stdin, written by the tray: `{version, paused, pausedUntil, nextRunAt, running, finished}`. `version` is the tray app's version (digits, letters, `.`, `+`, `-`); `paused` true or false; `pausedUntil` a time while paused, or null (until resumed; always null when not paused); `nextRunAt` a time or null; `running` `{"kind":"request","requestId":...}` while a run serves a request, `{"kind":"local","startedAt":...}` while a run of its own goes, or null; `finished` the requests whose run ended since the last answered check-in, at most 20, each `{"requestId":...,"result":{"t3":...,"security":...}}` with the parts' results of that run's report. Every field is required. A report that is not valid is refused (`invalid_report`, exit 2) and nothing is sent.
- **The claim** Adiutor answers is written, in one step, to `request.json` in the data folder (`{requestId, receivedAt}`, no secret) before `checkin` answers, and `status` shows it as `claim`, so a tray that stopped finds it again. It is cleared only after a check-in that listed it in `finished` was answered; a newer claim in an answer replaces it. The tray runs a claim with `run --request <id>`, which names it in the run's report (`requestId`), and reports that report's parts in `finished` at its next check-in.
- **A lost answer** (`outcome_unknown`) is safe: a check-in is a state report, so the next one sends the same report and Adiutor answers the same claim again. `checkin` does not take the run lock.
- **The activity log**: every agent call is audited (owner's decision D-T2), so one check-in a minute is one row a minute (about 1,440 a day): the engine keeps the endpoints listing (below) and reads it again only when it must. Run by hand, `checkin` reads stdin to its end: pipe or redirect the report, or it waits.
- **An older Adiutor**, whose endpoints listing has the sync's pushes but no check-in, is answered `server_older` (exit 1) without sending anything: requests from Adiutor are not available there, and the tray says so. Adiutor's other refusals are passed on with their code.
- The result: `{"type":"result","v":1,"command":"checkin","ok":...,"claim":{"requestId","receivedAt"}|null}`; with `ok` false, `error` and the claim kept from an earlier check-in, if any. Exit code 0 when Adiutor answered, 1 when not, 2 for bad arguments or a bad report.

## Commands

```
node dist/sync/adiutor-sync.js run [--env <file>] [--overview <dir>] [--no-collect] [--dry-run] [--request <id>] [--json]
node dist/sync/adiutor-sync.js status [--url <url>] [--env <file>] [--json]
node dist/sync/adiutor-sync.js disconnect [--url <url>] [--env <file>] [--json]
node dist/sync/adiutor-sync.js t3-connect [--env <file>] [--json]
node dist/sync/adiutor-sync.js t3-disconnect [--env <file>] [--json]
node dist/sync/adiutor-sync.js checkin [--url <url>] [--env <file>] [--json] < report.json
```

- `--no-collect` uses the newest existing snapshot without running the collector.
- `--dry-run` prints the payload sizes and a sample of ids and sends nothing; it needs no Adiutor address or connection, and still reads T3 with the session.
- `--request <id>` names the sync request from Adiutor the run serves in its report (`requestId`), for the tray's next check-in. The pushes carry no request id: the check-in's `finished` reports the result.
- `run`'s exit code: 0 when at least one part was `accepted` or `partial` (or a dry run had something to send), 1 when nothing could be sent or another run is going, 2 for bad arguments or settings. `status` exits 0; `disconnect` and `t3-disconnect` exit 1 while a revocation is pending; `t3-connect` exits 0 when connected.

## Machine-readable output

With `--json`, a command writes one JSON object per line on stdout and nothing else: events, then exactly one result, also after a failure. The types are in `src/sync/contract.ts`. No line holds a token. The sync names projects by id and puts no T3 title or path in a line; a failure's message can pass on the last error line the T3 CLI or the collector printed.

- **Events:** `{"type":"event","event":"message","text":...}` for each human line, and for `connect` `{"type":"event","event":"approval","link":...,"userCode":"ABCD-EFGH"}`.
- **Result:** `{"type":"result","v":1,"command":...,"ok":...}` with, by command:
  - `status`: `adiutor` (`state`: `connected`, `not_connected` or `ended`; `url`, `label`, `scope`, `revocationPending`), `t3` (`state`: `connected`, `not_connected` or `ended`; `reason` `rejected` or `other_environment`; `environmentId`, `expiresAt`, `revocationPending`), `lastRun` (the last run's report), `lastGoodSyncAt`, `running` (`{startedAt}` while a run holds the lock), `paused` (the settings file's pause), `claim` (a sync request from Adiutor kept to run, or null), `settings.problems`.
  - `connect`: `state` (`connected`, `already_connected`, `not_connected`), `scope`.
  - `disconnect`, `t3-disconnect`: `wasConnected`, `revocationPending`.
  - `t3-connect`: `environmentId`, `expiresAt`.
  - `checkin`: `claim` ("Requests from Adiutor", above).
  - `run`: `report` (`startedAt`, `finishedAt`, `dryRun`, `requestId`, `t3` and `security` each with `result`, `reason`, `message`, `httpStatus`; `t3` with `projectsFrom`, `projectsAt`, `projects`, `threads`, `failedProjects`; `security` with `snapshotRunId`, `snapshotAt`, `repos`; and `lastGoodSyncAt`), or `busy` (`{startedAt}`: another run holds the lock, nothing ran).
  - `ok` is true when the command did what it was asked. When it is false, `error` (`code`, `message`) always says why, with the command's own fields where it has them: `busy` for a run that did not start (code `busy`), `revocationPending` for a disconnect whose revocation is kept (code `revocation_pending`). Bad arguments have `command` null and the code `usage`.

`setup-mcp` has no JSON output.

## Connecting the sync

```
node dist/sync/adiutor-sync.js connect --name <name> [--url <url>] [--env <file>] [--replace] [--no-open]
```

1. Before it asks Adiutor for anything, it creates the env file (`--env`, or the default above) and restricts it to the current user (on Windows `icacls <file> /inheritance:r /grant:r <DOMAIN\user>:F`, read back; elsewhere 0600 in a 0700 folder), and prepares the connection's folder. It checks that the address answers as Adiutor with agents on (`/.well-known/oauth-authorization-server` names the same issuer).
2. It asks for a device code as Adiutor's built-in client `adiutor-agent`, for the `sync` area alone on the REST resource (`<url>/api/v1`), with `--name` (up to 60 characters) as `client_label`, the name the approval page and Settings, Agent access show. The page marks it as the name the agent gives itself: grant `sync` only to a sync you just started.
3. It prints the link with the code in it and the code (`ABCD-EFGH`), and opens the browser (`%SystemRoot%\System32\rundll32.exe url.dll,FileProtocolHandler` on Windows, `open` on macOS, `xdg-open` elsewhere, never a shell; `--no-open` skips it). The link must be on the address given.
4. It polls every 5 seconds (5 more after each `slow_down`) until the owner approves or denies, or the code ends. A poll whose answer was lost is never repeated (the code may have been spent): it stops and says to run `connect` again.
5. Approved, it keeps the connection (above) and sets `ADIUTOR_URL` in the env file, keeping every other line. When the `sync` area was not approved, it says so: the sync cannot push.

A connection already kept for the address is reported and left alone. `--replace` connects again (for example after the owner disconnected it in Settings, Agent access) and ends the old connection once the new one is kept. `--url` falls back to `ADIUTOR_URL` as in "Settings" above (the env file, the environment, the settings file). Exit code 0 when connected, 1 when not, 2 for bad arguments. `connect --for claude|codex` is gone: `setup-mcp` below replaces it.

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

- Child processes run through `execFile` with an argument array and no shell. Started by bare name, Node looks in the current folder before `PATH` on Windows, so every command runs by its full path: `icacls`, `whoami`, `rundll32`, `reg` and Windows PowerShell (`WindowsPowerShell\v1.0\powershell.exe`, which reads a process's creation time for the T3 session's pending record, given only a number) from `%SystemRoot%\System32` (where Windows installs them; only administrators can write there), `claude` and `codex` from the absolute `PATH` entries, and the T3 CLI from its setting (`T3CODE_CLI_PATH`, by default where T3 installs it). Node refuses to start a `.cmd` file without a shell, so the T3 CLI runs as `cmd.exe /d /v:off /s /c ""<cli>" "thread" "list" "--project" "<id>" "--json""`, and so does `codex.cmd` for `setup-mcp --for codex`. Every part is quoted; a part holding a quote, a percent sign or a line break is refused, because `cmd.exe` would still expand or split it inside quotes.
- Titles, paths and other text from T3 and the snapshot travel only as JSON to the API, never into a command line or a prompt.
- Redirects are not followed, so a token is sent only to `ADIUTOR_URL` (or `--url`).
