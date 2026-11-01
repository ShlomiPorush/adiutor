# Mikud project foundation

Status: Preparation. Nothing below is implemented unless its status says so.

This document separates the repository's current state from the approved desired state. Product behavior is in [requirements.md](requirements.md). A planned file, command or feature does not exist until its status and verification evidence say otherwise.

## Current truth

- The repository holds documentation only: `README.md`, `AGENTS.md`, `LICENSE`, `.gitignore`, `.gitattributes`, `docs/requirements.md` and this document.
- No code, scripts, container files, CI workflows or lockfiles exist yet.
- `docs/private/` is ignored by Git and may exist only on the owner's machine. It holds environment facts that must not be public.
- Facts checked on 2026-11-01 for this plan:
  - The owner's machine has Node.js 24.20.0, Docker 29.8.2 and WSL (Ubuntu) with Docker.
  - The T3 Code CLI (`t3`, path in `T3CODE_CLI_PATH`) prints a project's threads as JSON with `t3 thread list --project <id> --json`, including `status`, `settled` and `parentThreadId`. `status` and `settled` are independent: a `completed` thread can be unsettled. The CLI has no command to list projects; the T3 MCP tool `t3_project_list` does.
  - T3 sets `T3CODE_THREAD_ID` only for Claude agents. Every agent with the T3 MCP tools can read its own thread id as `currentThreadId` from `t3_thread_list` (or `parentThreadId` from `orchestrator_capabilities`).
  - The `overview` collector (`node src/cli.mjs collect` in the owner's `overview` checkout) writes `data/runs/<runId>/snapshot.json`. Each GitHub repository entry has `openIssues`, a `source` with completeness and last success time, and `security.{dependabot,codeScanning,secretScanning}` with `status` (`enabled`, `not-enabled`, `no-access`, `error`), `alerts[]` with `severity`, and `stale.since` when the values were carried over from an earlier run.
  - `overview` runs today as a T3 scheduled task at 08:00 Sunday to Friday, bound to one thread in a T3 project whose default thread mode is `local`.

## Product intent and boundaries

- **Problem:** see requirements section 1. One owner, about 30 projects, work happening in T3 agent threads.
- **Users:** the owner (desktop and phone) and his AI agents.
- **Stage:** preparation. Single launch after a dry run on real data and the owner's approval (requirements section 9).
- **Deployment shape:** one application container and a PostgreSQL database. Development and the dry run run on the owner's PC. The owner deploys production himself; agents never deploy.
- **Non-goals:** multiple users or roles, a login screen, importing or syncing GitHub Issues, writing to T3 or to GitHub, a backup feature (the owner backs up the database with his own tools), public internet exposure, an offline mobile app, generic Kanban features (swimlanes, free drag and drop, due dates, assignees).

## Preparation decisions

| Decision | Status | Choice | Rationale or blocker |
|---|---|---|---|
| Publication posture | Approved | Public-ready; public repository `ShlomiPorush/mikud` | Owner's choice. Private values live only on the server and in ignored `docs/private/`. |
| Repository language | Approved | English everywhere except the Hebrew locale file | Public-ready posture. |
| License | Provisional | MIT | Same as the owner's other public repositories; no dependency forces another license. Kanzo (AGPL) is inspiration only; no code is taken from it. |
| Database | Approved | PostgreSQL | Owner's decision (2026-11-01): he already runs PostgreSQL; production uses a new database there. |
| Backups | Approved | Out of scope | Owner's decision (2026-11-01): his own tools back up the database. |
| Production deployment | Approved | Done by the owner | Owner's decision (2026-11-01). Agents have no access to the production server. |
| Runtime shape | Approved | One application container; PostgreSQL outside it (a separate container in development) | n8n-ops style. |
| Language and runtime | Approved | TypeScript on Node.js 24 LTS, version pinned in the image | Same as n8n-ops. |
| Package manager | Provisional | pnpm, one package (no workspace), `pnpm-lock.yaml` | One deployable; a workspace adds nothing. |
| Server framework | Provisional | Hono with `@hono/node-server` | Small and typed; used in n8n-ops. |
| Data access | Provisional | Drizzle ORM with postgres.js, Drizzle migrations run on start | Same as n8n-ops. |
| MCP | Provisional | `@modelcontextprotocol/sdk`, Streamable HTTP at `/mcp`, bearer token | Works with Claude Code and Codex over HTTP. |
| UI | Provisional | React 19 and Vite, one stylesheet of tokens and `ui-` components, no utility CSS framework | UI follows the `v3-ui-style` skill (owner's explicit adoption), whose tokens and components are plain CSS. |
| UI languages | Approved | Hebrew (RTL, default) and English (LTR) from the first UI task | Owner's baseline; Hebrew first. |
| Format and lint | Provisional | Biome 2 | Used in n8n-ops. |
| Tests | Provisional | Vitest (unit, and HTTP and MCP against a real PostgreSQL), Playwright end to end against the container | Same as n8n-ops. |
| Bundling | Provisional | esbuild bundles the server and the sync tool; Vite builds the UI | The runtime image needs no `node_modules`. |
| Workflow scripts | Approved | WSL Bash under `scripts/`; tools run in a toolchain container | Owner's baseline; the host needs Docker only. |
| Release artifact | Provisional | Image `ghcr.io/shlomiporush/mikud`, SemVer tags plus `latest`, GitHub Release from the changelog | Release never deploys. |
| Versioning | Provisional | SemVer from `package.json` `version`; `CHANGELOG.md` with `Unreleased` | First release `0.1.0` at launch. |
| GitHub configuration | Provisional | Same as the owner's other public repositories (see below) | Owner's standard. |
| Access control | Provisional | Network: NetBird only (owner's deployment). Application: owner token and agent token; browsers paired once with the owner token | Requirement: a token on every call, no login screen. See "Security design". |
| Telegram transport | Provisional | Long polling (`getUpdates`) | The server is not reachable from the internet, so a webhook cannot work. |
| Archive | Provisional | Derived by query from `status` and `closed_at`; no archive job | Plan review P14. |

## Publication and language policy

- Everything tracked is English, except `src/shared/locales/he.json`. A guard in `scripts/verify.sh` fails on Hebrew characters in any other tracked file. Tests read Hebrew samples from that file.
- No hostnames, IP addresses, network details, tokens, real project names or real project data in tracked files, fixtures, screenshots or docs. Fixtures use invented projects. Names of the integrations Mikud depends on (T3 Code, the `overview` collector, n8n-ops, NetBird, Telegram) are allowed.
- Guards: one fails on IPv4 literals outside documentation ranges and loopback; a local-only check reads an ignored deny list (`docs/private/deny-list.txt`, real project names and private domains) and runs in `scripts/verify.sh` when the file exists.
- Commits, Issues and pull requests are in English. The commit email is the GitHub noreply address.

## Planned architecture

| Component | Responsibility | Expected path | Status | Dependencies or blockers |
|---|---|---|---|---|
| Schema and migrations | Tables below; Drizzle migrations run on start | `src/server/db/` | Planned | None |
| Services | Every write: validation, permission by actor, optimistic concurrency, audit row in the same transaction, secret check for agent text | `src/server/services/` | Planned | Schema |
| HTTP API | `/api/v1` for the UI and the sync tool; `/healthz`; static UI | `src/server/http/` | Planned | Services |
| MCP server | Tools for agents over Streamable HTTP at `/mcp` | `src/server/mcp/` | Planned | Services |
| Jobs | Morning message at 08:00 Asia/Jerusalem, Sunday to Friday, with durable run state | `src/server/jobs/` | Planned | Services, Telegram |
| Telegram | Long-polling bot: owner-only quick add, morning message | `src/server/telegram/` | Planned | Bot token from the owner |
| Web UI | Morning view, projects, project, item, inbox, archive, audit log, settings; Hebrew and English; light and dark; phone | `src/web/` | Planned | API |
| Shared | Enum codes, request and response schemas (zod), locale files | `src/shared/` | Planned | None |
| Sync tool | Runs on the PC: runs the `overview` collector, reads T3 threads, calls the API | `src/sync/` | Planned | API, agent token |
| Reconciler prompt | Instructions for the T3 scheduled task | `prompts/reconcile.md` | Planned | Sync tool |
| Agent instruction | Proposed text for the owner's shared agent configuration | `docs/agent-instruction.md` | Planned | MCP tools |
| Deployment notes | What the owner needs to deploy: image, Compose, `.env`, database, network | `docs/deployment.md` | Planned | Container |

Load-bearing relationships:

- Every write goes through the services layer, which knows the actor (`owner`, `agent`, `bot`, `sync`, `system`) and enforces the rules in requirements section 3. HTTP, MCP and Telegram are thin adapters.
- The server never reaches T3 or GitHub. T3 data and security counts arrive only through the sync tool on the PC, which pushes them to the API with the agent token.
- Statuses, stages, types and severities are stored and sent as English codes. Labels come from the locale files only.

### Data model (planned)

- `projects`: name, slug, T3 project id (unique, optional), GitHub repository `owner/name` (optional), stage (nullable until the owner sets one), current goal, where-we-are line, open Issues count with its as-of time.
- `goals`: project, text, created and closed time. Progress is the count of `done` items linked to the current goal out of all items linked to it.
- `items`: project (null for the inbox), type, status, title, body, severity (security only), goal, `version` (optimistic concurrency), status set by (actor kind) and when, created by, created, updated and closed time.
- `item_threads`: item, T3 thread id (unique), T3 project id, title, last T3 status and settled flag, last T3 activity time, linked time.
- `suppressions`: T3 thread ids and T3 project ids whose item or project the owner deleted; the sync never recreates them. The owner can remove a suppression in the UI.
- `comments`: item, author, text, thread id, time.
- `stage_proposals`: project, proposed stage, reason, author, state (`open`, `accepted`, `rejected`).
- `security_sources`: project, family (`dependabot`, `code_scanning`, `secret_scanning`, `overview`), coverage (`enabled`, `not_enabled`, `no_access`, `error`, `unknown`), counts by severity, data as-of time (the source's last success, not the sync time).
- `sync_runs`: kind, start and end, outcome, counts, per-record errors.
- `job_runs`: job, local date, state (`sending`, `sent`, `failed`, `unknown`), time, detail. Unique on job and local date.
- `telegram_updates`: `update_id` (primary key), outcome (`item_created`, `ignored`, `refused`), time.
- `visits`: one row per owner visit, for "new since your last visit".
- `settings`: closed-item days in the morning view (default 7), date and time format, language. The morning time and days are fixed (plan review P19): they must stay after the reconciler's fixed T3 schedule.
- `devices`: paired browser sessions (hashed secret, label, created, last seen, revoked).
- `audit`: time, actor kind and label, action, entity, before and after (JSON), source (`ui`, `api`, `mcp`, `telegram`, `sync`).

### Agent and sync rules (planned)

- **Start of thread, one call.** MCP `mikud_start_thread(threadId, parentThreadId, projectId?, title, itemId?)` finds the item linked to the thread, or links the given item, or creates one, and sets `in_progress`, in one transaction. The unique thread id makes a retry or a race return the existing item instead of creating a second one.
- **Status from T3, decided per item over all its linked threads:** any linked thread `running` (or `starting`, `queued`, `preparing`) → `in_progress`; otherwise any `waiting` → `waiting_on_you`; otherwise all linked threads settled → `done`. A `completed` but unsettled thread changes nothing.
- **The owner wins.** The sync changes an item only when its status was last set by an agent or the sync, or by the owner before the latest T3 activity of its threads. It never moves an item out of `done` or `not_relevant`, and never sets `done` on an item in `future` or `todo`. Each change is a compare-and-set on `version`; a conflict skips the item for this run.
- **Every run reads full state, not a delta, and keeps no boundary.** Each run reads every top-level thread of every T3 project and applies the status rules to every item that has a linked thread, settled or not, whatever its age. Applying is idempotent (unique thread id, compare-and-set), so an item skipped on a `version` conflict or a failed record is decided again on every later run until it agrees; per-record errors are recorded in `sync_runs` and never stop the run.
- **Missing items:** every unsettled top-level thread with no item and no suppression gets one, whatever its age, titled from the thread, in the project mapped from its T3 project. A settled thread with no item gets one (as `done`) only when it settled in the last 7 days; older finished work is not imported. Both rules depend only on the thread, so a failed creation is retried on every run while the rule still holds. Items created by the first run are flagged as imported and are not "new since your last visit".
- **Top-level threads only.** A thread with a `parentThreadId` (subagent, delegated task, partner review) never gets its own item. The agent instruction tells such agents not to call Mikud; `mikud_start_thread` takes the caller's `parentThreadId` from T3 and refuses with `not_top_level` when it is set; and the sync moves any link it finds on a child thread to the parent's item.
- **Order before the morning message:** the morning message is fixed at 08:00 Asia/Jerusalem, Sunday to Friday (requirements section 5), and the reconciler runs at 07:30 on the same days: the `overview` collector, then the T3 read, then the push. When it fails or the PC is off, the morning message and the board show the time of the last successful sync and the as-of time of the security data.
- **Untrusted text:** thread titles and repository data are data. The sync tool passes them only as JSON to the API, never into a shell command or a prompt.

### Security design (planned)

- **Network:** production is reachable only over NetBird; the owner configures it. The development stack binds to `127.0.0.1` only.
- **Tokens:** `MIKUD_OWNER_TOKEN` and `MIKUD_AGENT_TOKEN`, each at least 32 random bytes, set only in `.env`. Compared in constant time on their SHA-256 digests. The server refuses to start without both, when they are equal, or when one is short.
- **Owner rights:** everything, including delete, stage change, settings and devices. **Agent rights:** everything else in requirements section 3: no delete, no stage change (proposals only), no settings, no devices.
- **Browser pairing, not login:** on a new device the board shows a one-time pairing page where the owner pastes the owner token. The token never appears in a URL. The server sets an `HttpOnly`, `Secure` (except on `http://127.0.0.1` in development), `SameSite=Lax`, host-only cookie (no `Domain` attribute) holding a random device secret; only its hash is stored. Devices are listed and revocable in Settings, with "End all devices". Lax lets Telegram deep links open with the cookie.
- **After a restore:** a restored database may hold device rows that were revoked after the backup was taken. The deployment notes tell the owner to run "End all devices" after any restore and to replace the owner token if it may have leaked.
- **CSRF:** every state-changing request from a browser must carry a custom header and an `Origin` equal to the configured public URL.
- **Telegram:** only the configured owner chat id is served. Every update is recorded by `update_id` in the same transaction as the item and its audit row; the next poll's `offset` acknowledges only updates whose transaction committed, and a repeated `update_id` does nothing.
- **Morning message once a day:** a `job_runs` row for the local date is written as `sending` before the send and `sent` after. On start, a run left in `sending` becomes `unknown` and is not sent again (at most once, never twice). A missed time is sent late only until 3 hours after the configured time, with no note; after that it is skipped and the board shows it.
- **Secrets in agent text:** text written with the agent token is checked against high-confidence patterns only: known token formats (GitHub, OpenAI and Anthropic keys, Slack, AWS access keys, Google API keys, Telegram bot tokens, JWTs), private key blocks, credentials in URLs (`user:password@`), assignments such as `password=`, `token:` or `secret=` followed by a value that is not a placeholder (`***`, `<...>`, `[redacted]`), IPv4 addresses outside documentation ranges and loopback, and host names under the private domains listed in the server's `MIKUD_PRIVATE_DOMAINS`. Commit SHAs and checksums pass. A refusal returns `secret_suspected` with the rule name, never the matched text. Text from the sync tool (thread titles) is not refused: matches are replaced with `[redacted]`, so one record cannot stop a run. This is a safety net, not a promise that every secret is caught.
- **Untrusted text:** thread titles, comments and item text are data. The UI escapes everything; the morning message escapes Telegram HTML.
- **Logs:** no tokens, cookies or message text in logs.

## Planned repository root

| Root file | Git tracking policy | Why this exact root location is required | Status |
|---|---|---|---|
| `README.md` | Tracked | GitHub repository landing page | Exists |
| `AGENTS.md` | Tracked | Agent discovery convention | Exists |
| `LICENSE` | Tracked | GitHub license detection | Exists |
| `.gitignore` | Tracked | Git reads it from the root | Exists |
| `.gitattributes` | Tracked | Git reads it from the root; forces LF for scripts | Exists |
| `CHANGELOG.md` | Tracked | Release workflow and readers expect it at the root | Planned |
| `package.json` | Tracked | pnpm and Node resolve it from the root | Planned |
| `pnpm-lock.yaml` | Tracked | pnpm requires it next to `package.json` | Planned |
| `biome.json` | Tracked | Biome 2 must find its configuration at the root (nested configs fail) | Planned |
| `tsconfig.json` | Tracked | Editors and `tsc` find it at the root; extends `config/` | Planned |
| `docker-compose.yml` | Tracked | Production deployment file, run from the deploy directory | Planned |
| `docker-compose-dev.yml` | Ignored, never committed | Machine-local development stack used only by `scripts/local.sh` | Planned |
| `.env.example` | Tracked | Compose `env_file` contract next to `docker-compose.yml` | Planned |
| `.env` | Ignored | Real values on the server only | Planned |

Directories: `src/` (code), `scripts/` (workflow scripts), `docker/` (Dockerfiles, development Compose template, development env), `config/` (movable tool configuration), `docs/` (documentation), `prompts/` (T3 task prompts), `.github/` (CI, Dependabot, templates), `e2e/` (Playwright specs).

## Docker decisions (planned)

| Container | Runtime user | Health check | Persistent state | Host directory | Named volume | Backup lifecycle |
|---|---|---|---|---|---|---|
| `mikud` | `node` (UID 1000), no capabilities, read-only root file system | `GET /healthz` from inside the container: the database answers a trivial query | None | None | None | Not applicable |
| `postgres` (development and verification only) | `postgres` | `pg_isready` | Development database | `~/.local/share/mikud-dev/postgres` on the WSL file system | None | Disposable; `nuke` deletes it after confirmation |

- `docker-compose.yml` runs only the `mikud` service with the published image and no `build:`, following the owner's other production Compose files (external `traefik` network, no published port, hardening). `DATABASE_URL` in `.env` points at the owner's PostgreSQL. Compose interpolation is limited to `VERSION` and `DOMAIN`. The owner adapts the network to his NetBird setup; `docs/deployment.md` says how.
- `docker-compose-dev.yml` is created from `docker/docker-compose-dev.example.yml`, uses image `mikud:dev` and a `postgres` container, and is used only through `scripts/local.sh`.
- Logs go to stdout and stderr. A guard fails on `build:` in either Compose file.

## Foundation implementation plan

| Order | Deliverable | Status | Acceptance criteria | Required verification |
|---|---|---|---|---|
| 1 | Repository baseline | Planned | Git repository, public GitHub repository, docs, license, ignore rules, `.gitattributes` | `git status` clean; GitHub settings read back |
| 2 | Toolchain and package | Planned | `package.json`, lockfile, Biome, TypeScript, Vitest; toolchain image with Node, pnpm, shellcheck, shfmt | Guards and a type check pass in the container |
| 3 | Guards | Planned | Hebrew outside the locale file, IPv4 literals, `build:` in Compose, local deny list, locale key parity, no external assets | Each guard fails on a planted violation |
| 4 | Schema, services, audit | Planned | Every rule in requirements section 3 enforced by actor; audit row per change; concurrency by `version` | Tests per rule, including refused agent delete and stage change and a stale `version` |
| 5 | HTTP API and pairing | Planned | Token and cookie auth, CSRF checks, stable error codes | HTTP tests: missing and wrong token, agent on owner route, bad Origin, revoked device |
| 6 | MCP server | Planned | Tools listed in `docs/agent-instruction.md`, same rules as the API | MCP client test over HTTP; one real connection each from Claude Code and Codex in the dry run |
| 7 | Web UI | Planned | All screens, Hebrew and English, RTL and LTR, light and dark, phone; `v3-ui-style` checklist and guard tests | Playwright against the container; screenshots at 1440, 1000 and 390 px in both themes |
| 8 | Telegram and morning job | Planned | Morning message once per day, quick add, owner-only, `update_id` dedup | Tests against a stand-in Bot API, including a crash between send and record and a repeated update; one real message in the dry run |
| 9 | Sync tool and reconciler prompt | Planned | Rules in "Agent and sync rules" | Tests with recorded `t3` and snapshot fixtures: owner edit between read and apply, two linked threads, deleted item, stale security source, failed record; one real run in the dry run |
| 10 | Container and Compose | Planned | Non-root runtime, health check, production and development Compose files | Health and UID checks in `verify.sh` |
| 11 | Workflow scripts | Planned | `local.sh`, `verify.sh`, `try-pr.sh`, `release.sh` per the contracts below | Each command exercised; refusals tested |
| 12 | CI and Dependabot | Planned | Path-filtered CI, summary job, weekly grouped updates | Green run on a pull request and on `main` |
| 13 | Agent instruction and deployment notes | Planned | `docs/agent-instruction.md`; `docs/deployment.md` including the one-time move from the dry run to production: stop the local stack (the only bot consumer) first, move the approved data with `pg_dump` and `pg_restore` (which carries `job_runs` and `telegram_updates`), start production, point the reconciler at it | Cross-provider review |
| 14 | Dry run | Planned | On the development stack: seeded drafts (stage as proposals), one real morning message, morning view at desktop and phone sizes, the launch evidence below | Owner's review |

### Launch evidence for the dry run

- Agent permission checks through both API and MCP: delete, stage change and settings refused for the agent token; proposals accepted.
- A real MCP connection from a Claude Code thread and from a Codex thread, each running the start-of-thread call.
- Pairing a browser, then a Telegram deep link opening the right item with the cookie.
- A sync while the owner edits an item; a sync run twice; a sync with stale security data.
- One real morning message and one quick add from the phone.
- Imported threads do not flood "new since your last visit"; a visit on one device does not hide updates on another before they were shown.

## Required workflow contracts

All four scripts are Bash with `#!/usr/bin/env bash`, LF line endings and the executable bit, run inside WSL, resolve the repository root from their own location, and run Node, pnpm, shellcheck and shfmt inside the toolchain container. Development and test data live on the Linux file system, not under `/mnt/c`.

- `scripts/local.sh build|up|start|down|status|logs|nuke`: builds `mikud:dev` explicitly, runs `docker-compose-dev.yml` (fails with a clear message when it is missing), checks health and that the application process is not UID 0. `down` keeps the database directory; `nuke` asks for confirmation and deletes only the validated development database directory.
- `scripts/verify.sh [--changed [BASE]] [--guards-only] [--skip-e2e]`: the one verification entry point used locally and in CI: guards, Biome, types, unit tests, HTTP and MCP tests against a disposable PostgreSQL, builds, the container with health and UID checks, then Playwright. Cleans up its stack.
- `scripts/try-pr.sh <number>|status|restore`: builds the pull request in a disposable worktree and runs it as a separate Compose project with its own disposable PostgreSQL seeded with invented fixtures, its own generated tokens and a stand-in Telegram API. It never touches the development stack, its database or its `.env`, which hold real data and the real bot token after the dry run. `restore` removes the PR stack. Never pushes, merges or touches the user's checkout.
- `scripts/release.sh`: run by the Release workflow on `main`: preflight (clean, synchronized, full verify), version bump chosen by the operator, changelog section closed, release commit and immutable tag, image pushed to GHCR, GitHub Release. Has a dry run. Never deploys.

## CI and GitHub

- One CI workflow: a change-detection job, area jobs gated by it, and a final `summary` job that passes when skipped areas were not affected. Pull request runs cancel superseded runs; `main` runs are not cancelled. Manual full run and a weekly scheduled full run. Least-privilege permissions; actions pinned to commit SHAs.
- Release workflow: manual, on `main`, runs the full CI first.
- Dependabot weekly for npm, GitHub Actions and Docker; minor and patch grouped; majors separate; no auto-merge.
- Repository settings like the owner's other public repositories: default branch `main`, secret scanning with push protection, Dependabot alerts and security updates, Actions default token read-only, no rulesets. Pull requests are squash-merged only when every check is green, and the merged branch is then deleted locally and on GitHub.

## Known unknowns and blockers

| Question or blocker | Why it matters | Evidence or decision needed | Owner |
|---|---|---|---|
| Telegram bot token and owner chat id | Needed for the morning message and quick add in the dry run | Owner creates the bot in BotFather; token entered through a private secret prompt; chat id read from the first message he sends the bot | Owner |
| Production network details | Decide the final Compose network | Owner's own deployment; `docs/deployment.md` lists what he needs to set | Owner |

## Ready-for-implementation criteria

- This plan and `requirements.md` pass a cross-provider plan review with no open material finding.
- The owner has authorized the public repository, pull requests and merges (2026-11-01).
- The bot token and the launch review wait for the owner and do not block building and verifying locally.

## Handoff to foundation implementation

Build in the order of the implementation table, one pull request per coherent slice, each green in CI before merge. When the product is complete and verified locally, ask the owner for the bot token, run the dry run on the development stack, and bring it to the owner for the launch review in one message. Do not deploy, enable schedules, change the shared agent configuration or retire `overview` before the owner approves the launch; production deployment is the owner's.
