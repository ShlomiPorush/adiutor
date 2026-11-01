# Mikud project foundation

Status: Foundation in progress. Nothing below is implemented unless its status says so.

This document separates the repository's current state from the approved desired state. Product behavior is in [requirements.md](requirements.md). A planned file, command or feature does not exist until its status and verification evidence say otherwise.

## Current truth

- The foundation slice exists: implementation rows 1 to 3, the database schema of row 4, and the skeleton of rows 10 to 12. On `main`: the server core (rows 4 to 6), the sync tool (row 9), `try-pr.sh`, `release.sh` with the Release workflow and `docs/deployment.md` (rows 11 to 13), the Telegram bot and the morning job (row 8, #8) and the web UI (row 7, #9).
  - One pnpm package with `pnpm-lock.yaml`, Biome 2, TypeScript 7, Vitest 5, esbuild, Drizzle ORM with postgres.js, Hono and zod. Versions match n8n-ops where they overlap.
  - `src/server/`: configuration that refuses to start without `DATABASE_URL`, `MIKUD_PUBLIC_URL`, two different tokens of at least 32 characters and `MIKUD_AUTH_SECRET` of at least 32 bytes (optional `MIKUD_PRIVATE_DOMAINS`); migrations applied on start from `MIGRATIONS_DIR`; `GET /healthz` runs `select 1`. Services, the HTTP API under `/api/v1` and the MCP server at `/mcp` as documented in [api.md](api.md). The Telegram bot (long polling, owner-only quick add) and the morning job, both off until `MIKUD_TELEGRAM_BOT_TOKEN` and `MIKUD_TELEGRAM_CHAT_ID` are set. The built web UI is served from `dist/web`.
  - `src/server/db/schema.ts` and the generated migration `drizzle/0000_initial.sql`: every table of the data model below, with codes checked by the database.
  - `src/shared/`: enum codes with zod schemas; `locales/en.json` and `locales/he.json` label every stage, item status, item type and severity, and the inbox.
  - `docker/`: toolchain image, application image, development Compose template and `dev.env`. Root `docker-compose.yml` and `.env.example` for production.
  - `scripts/local.sh`, `scripts/verify.sh`, `scripts/lib/common.sh`, `scripts/lib/guards.sh`.
  - `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.github/pull_request_template.md`, `CHANGELOG.md`.
- The sync side of row 9 and the draft of row 13 exist: `src/sync/` (bundled to `dist/sync/mikud-sync.js`, described in [sync.md](sync.md)), `prompts/reconcile.md` and the proposal [agent-instruction.md](agent-instruction.md). No run has sent anything to a real server yet.
- Server core verified on the owner's PC on 2026-11-01 with `scripts/verify.sh` (full) in a fresh WSL clone of `feature/core`: guards; Biome; types; 94 unit tests (secret check, sync rules, token comparison, rate limit, cookie flags, configuration); build; the schema matches its migrations; 81 database tests against a disposable PostgreSQL 18 (services and permissions per actor, start of thread including a six-way race, every sync rule, read models, HTTP authentication, pairing and CSRF, MCP over HTTP with the SDK client); the image healthy, UID and hardening checks as below. The bundled server was also started by hand: `/healthz`, MCP `initialize` and `tools/list` (11 tools) and `/api/v1/morning` answered. Not yet run in GitHub Actions.
- Telegram and the morning job verified on the owner's PC on 2026-11-01 with `scripts/verify.sh` (full) in a fresh WSL clone of `feature/telegram`: 170 unit tests (among them the message builder in English and Hebrew with hostile titles, an empty day and a stale sync; the schedule at 07:59, 08:00, Saturday, 10:59, 11:00 and 11:01 in winter and summer time; Bot API failure classes; update classification; configuration) and 99 database tests, 18 of them new, against a stand-in Bot API started by the test (owner text filed with its audit row and a linked reply; a repeated `update_id`; a crash between commit and offset, simulated by redelivery; a failed transaction fetched again; a stranger ignored; a secret refused without echo; commands; poll errors and an unreachable API; the status route; no token or text in logs; the morning run sent once, before time, Saturday, late and skipped, `sending` at start-up becomes `unknown`, a refused send retried, a dropped connection never resent, three processes racing). The bundled server was also run by hand against a stand-in: it filed a message, replied in Hebrew with the item link, reported its status and stopped cleanly on `SIGTERM`. No real Bot API call has been made; the first one is in the dry run. Not yet run in GitHub Actions.
- The web UI (row 7) is on `main` (#9): `src/web/` (React 19, Vite, React Router, TanStack Query; one stylesheet after the `v3-ui-style` skill), built to `dist/web` and served by the server with a page fallback and a Content-Security-Policy; `e2e/` holds the Playwright specs. Verified on the owner's PC on 2026-11-01 with `scripts/verify.sh` (full) in a fresh WSL clone of `feature/ui` at `15ddcb8` (rebased on `main` with the Telegram bot): guards; Biome; types (server, UI, e2e); 205 unit tests, among them the UI's date, time and number helpers, the API client, locale keys and the v3 guards (popups only from the shared builders, every page refreshes, dates through the helpers), each guard also catching planted bypasses; the UI build checked for external assets and the development mock (`scripts/lib/web-dist-check.sh`, which failed on the mock build and on a planted external font and stylesheet); 99 database tests; the image healthy and hardened; 8 Playwright tests against the container (pairing with a wrong and the right token, the morning view and its bell, an item status change with Undo, quick add; desktop and phone). Screenshots of every screen in Hebrew and English, light and dark, at 1440, 1000 and 390 px were taken against the mock API and inspected; the UI was also driven against the development stack seeded with invented data through the real API. Not yet run in GitHub Actions.
- Browser sign-in with Better Auth (owner's decision, 2026-11-01; replaces pairing) verified on the owner's PC on 2026-11-01 with `scripts/verify.sh` (full, with the local deny list) in a WSL clone of `feat/better-auth`: 233 unit tests; 156 database tests, among them 29 new ones for sign-in (setup, its race and its validation; enrolment, a wrong code with and without a session, the no-replacement path; sign-in by password and code; the route allow-list; CSRF before the body; the rate limits with a forged forwarding header; both session clocks and the sweep; sign-out, the session list and its ends, the password change; the recovery CLI with a pending challenge; the auth lock in both race orders, a waiting pool and `busy`; failing closed at sign-in, enrolment and a password-only sign-in) and the upgrade from the schema before sign-in; 19 Playwright tests (setup with TOTP, a wrong password, sign-in returning to the page asked for, the stored session reused, sign-out, desktop and phone); the recovery command run in the image. The setup, sign-in and Account screens were inspected in Hebrew and English, light and dark, at 1440 and 390 px on a stack with invented data. Not yet run in GitHub Actions.
- Verified on the owner's PC (WSL, Docker 29.8.2) on 2026-11-01. Not yet run in GitHub Actions.
  - `scripts/verify.sh` (full) passed: guards; Biome; types; 17 unit tests; build; the schema matches its migrations; 5 database tests against a disposable PostgreSQL 18 (migrations apply twice, every table exists, the unique keys and code checks refuse bad rows); the image healthy with `/healthz` reporting the database, `mikud` as UID 1000 and `postgres` as UID 999, no capabilities, read-only root, no new privileges; the stack removed afterwards.
  - Each guard failed on a planted violation and passed again once it was removed (see row 3 of the implementation plan).
  - `scripts/local.sh`: `build`, `start` (healthy on `127.0.0.1:8090`), `status`, `down` (database kept), `start` again (a row written before `down` was still there), and `nuke` refusing without confirmation, with a wrong answer, and for the home directory, a name not starting with `mikud-dev`, or a path under `/mnt`.
- GitHub repository settings read back on 2026-11-01: public, default branch `main`, MIT detected, secret scanning with push protection, Dependabot security updates, Actions default token read-only. Merge commits and rebase merges are still allowed, and merged branches are not deleted automatically.
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
- **Non-goals:** multiple users or roles, passkeys, OAuth for agents, backup codes (recovery is a command on the server), importing or syncing GitHub Issues, writing to T3 or to GitHub, a backup feature (the owner backs up the database with his own tools), public internet exposure, an offline mobile app, generic Kanban features (swimlanes, free drag and drop, due dates, assignees).

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
| Access control | Provisional | Network: NetBird only (owner's deployment). Application: owner token and agent token for the API, MCP and the sync; browsers sign in with Better Auth | Tokens on every call from agents and scripts. See "Security design". |
| Browser sign-in | Approved | Better Auth 1.7.10 as in n8n-ops: one account (username and password), mandatory TOTP, session clocks in Settings (30 days by default, idle sign-out off by default), recovery by a CLI command on the server. Replaces the paste-a-token pairing | Owner's decision (2026-11-01), replacing "There is no login screen". Plan reviewed in five rounds with a cross-provider partner. |
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
| Schema and migrations | Tables below; Drizzle migrations run on start | `src/server/db/`, `drizzle/` | Exists: schema and first migration, tested against PostgreSQL | None |
| Services | Every write: validation, permission by actor, optimistic concurrency, audit row in the same transaction, secret check for agent text | `src/server/services/` | Exists: writes, start of thread, sync apply, read models; tested against PostgreSQL | Schema |
| HTTP API | `/api/v1` for the UI and the sync tool; `/healthz`; static UI | `src/server/http/` | Exists: `/healthz`, `/api/v1` ([api.md](api.md)) and the built UI from `dist/web` (`src/server/web.ts`) | Services |
| MCP server | Tools for agents over Streamable HTTP at `/mcp` | `src/server/mcp/` | Exists: eleven tools, tested with the SDK client over HTTP | Services |
| Jobs | Morning message at 08:00 Asia/Jerusalem, Sunday to Friday, with durable run state | `src/server/jobs/` | Exists (row 8): tested against a stand-in Bot API | Services, Telegram |
| Telegram | Long-polling bot: owner-only quick add, morning message | `src/server/telegram/` | Exists (row 8): tested against a stand-in; no real bot yet | Bot token from the owner |
| Web UI | Morning view, projects, project, item, inbox, archive, audit log, settings; Hebrew and English; light and dark; phone | `src/web/` | Exists (see Current truth); Settings shows the Telegram status from `GET /api/v1/telegram/status` and sends a test morning message | API |
| Shared | Enum codes, request and response schemas (zod), locale files | `src/shared/` | Partial: enum codes, their zod schemas and labels; request schemas in `api.ts`; the date and time format settings in `datetime-formats.ts`; response shapes are documented in [api.md](api.md), not yet as schemas | None |
| Sync tool | Runs on the PC: runs the `overview` collector, reads T3 threads, calls the API | `src/sync/` | Exists: reads T3 and `overview`, sends both; tested against fixtures and a stub server | API, agent token |
| Reconciler prompt | Instructions for the T3 scheduled task | `prompts/reconcile.md` | Exists, not yet scheduled | Sync tool |
| Agent instruction | Proposed text for the owner's shared agent configuration | `docs/agent-instruction.md` | Draft: proposal awaiting the owner | MCP tools |
| Deployment notes | What the owner needs to deploy: image, Compose, `.env`, database, network | `docs/deployment.md` | Exists, not yet followed on a server | Container |

Load-bearing relationships:

- Every write goes through the services layer, which knows the actor (`owner`, `agent`, `bot`, `sync`, `system`) and enforces the rules in requirements section 3. HTTP, MCP and Telegram are thin adapters.
- The server never reaches T3 or GitHub. T3 data and security counts arrive only through the sync tool on the PC, which pushes them to the API with the agent token.
- Statuses, stages, types and severities are stored and sent as English codes. Labels come from the locale files only.

### Data model

Status: the schema exists in `src/server/db/schema.ts` (migration `drizzle/0000_initial.sql`); the services in `src/server/services/` write it. Choices made in the schema: codes are text columns with database checks; a project's current goal is its one goal that is not closed (a partial unique index), not a column on `projects`; the items of a project block its deletion (`ON DELETE RESTRICT`) until the services move them; thread links, comments, goals, proposals and security sources go with their parent; `closed_at` is set exactly when the status is `done` or `not_relevant`; `severity` is only on `security` items; `settings` is a single row; `visits` carry the browser (a `devices` row). Migration `0003_better-auth` adds the Better Auth tables and the session clock settings, and drops the device secret.

- `projects`: name, slug, T3 project id (unique, optional), GitHub repository `owner/name` (optional), stage (nullable until the owner sets one), current goal, where-we-are line, open Issues count with its as-of time.
- `goals`: project, text, created and closed time. Progress is the count of `done` items linked to the current goal out of all items linked to it.
- `items`: project (null for the inbox), type, status, title, body, severity (security only), goal, `version` (optimistic concurrency), status set by (actor kind) and when, created by, created, updated and closed time.
- `item_threads`: item, T3 thread id (unique), T3 project id, title, last T3 status and settled flag, last T3 activity time, linked time.
- `suppressions`: T3 thread ids and T3 project ids whose item or project the owner deleted; the sync never recreates them. Every transaction that creates, moves, links or deletes thread links, creates items or projects from the sync, deletes items or projects, or writes or removes suppressions takes one global transaction-level advisory lock as its first statement, so these run one at a time and never deadlock. The sync checks a suppression inside such a transaction, so a delete that commits during a run still wins. The owner can remove a suppression in the UI.
- `comments`: item, author, text, thread id, time.
- `stage_proposals`: project, proposed stage, reason, author, state (`open`, `accepted`, `rejected`).
- `security_sources`: project, family (`dependabot`, `code_scanning`, `secret_scanning`, `overview`), coverage (`enabled`, `not_enabled`, `no_access`, `error`, `unknown`), counts by severity, data as-of time (the source's last success, not the sync time).
- `sync_runs`: kind, start and end, outcome, counts, per-record errors.
- `job_runs`: job, local date, state (`sending`, `sent`, `failed`, `unknown`, `skipped`), time, detail (an error code), and for a sent morning message the time its "new since" ran to (`covers_until`: the start of its read minus the one-minute safety margin), where the next message starts counting. Unique on job and local date.
- `telegram_updates`: `update_id` (primary key), outcome (`item_created`, `ignored`, `refused`), time.
- `visits`: one row per owner visit, for "new since your last visit".
- `settings`: closed-item days in the morning view (default 7), date and time format, language, and the session clocks (maximum days, default 30; idle sign-out, off by default, with its minutes). The morning time and days are fixed (plan review P19): they must stay after the reconciler's fixed T3 schedule.
- `devices`: browser identities for "new since your last visit", named by the `mikud_browser` cookie (label, created, last seen; `revoked` only on browsers ended before sign-in existed). Never a credential.
- `auth_user`, `auth_account`, `auth_session`, `auth_verification`, `auth_two_factor`: Better Auth's tables (its field names). `auth_session` adds the clocks (`authenticated_at`, `active_at`), the TOTP proof (`two_factor_at`) and the end (`ended_reason`, `ended_at`).
- `audit`: time, actor kind and label, action, entity, before and after (JSON), source (`ui`, `api`, `mcp`, `telegram`, `sync`).

### Agent and sync rules

Status: implemented server-side in `src/server/services/threads.ts`, `sync.ts` and `sync-rules.ts`, with a test per rule. The sync tool on the PC that collects the snapshots is implemented in `src/sync/` (row 9).

- **Start of thread, one call.** MCP `mikud_start_thread(threadId, parentThreadId, projectId?, title, itemId?)` finds the item linked to the thread, or links the given item, or creates one, and sets `in_progress`, in one transaction. The unique thread id makes a retry or a race return the existing item instead of creating a second one.
- **Status from T3, decided per item over all its linked threads:** any linked thread `running` (or `starting`, `queued`, `preparing`) → `in_progress`; otherwise any `waiting` → `waiting_on_you`; otherwise all linked threads settled → `done`. A `completed` but unsettled thread changes nothing.
- **The owner wins.** The sync changes an item only when its status was last set by an agent or the sync, or by the owner before the latest T3 activity of its threads. It never moves an item out of `done` or `not_relevant`, and never sets `done` on an item in `future` or `todo`. Each change is a compare-and-set on `version`; a conflict skips the item for this run.
- **Every run reads full state, not a delta, and keeps no boundary.** Each run reads every top-level thread of every T3 project and applies the status rules to every item that has a linked thread, settled or not, whatever its age. Applying is idempotent (unique thread id, compare-and-set), so an item skipped on a `version` conflict or a failed record is decided again on every later run until it agrees; per-record errors are recorded in `sync_runs` and never stop the run.
- **Snapshots out of order never roll back.** A thread record whose `updatedAt` is not newer than the stored last activity of its link is ignored (equal is nothing new). A security family, or the open Issues count, whose as-of time is older than the stored one keeps the stored values.
- **Missing items:** every unsettled top-level thread with no item and no suppression gets one, whatever its age, titled from the thread, in the project mapped from its T3 project. A settled thread with no item gets one (as `done`) only when it settled in the last 7 days; older finished work is not imported. Both rules depend only on the thread, so a failed creation is retried on every run while the rule still holds. Items created by the first run are flagged as imported and are not "new since your last visit".
- **Top-level threads only.** A thread with a `parentThreadId` (subagent, delegated task, partner review) never gets its own item. The agent instruction tells such agents not to call Mikud; `mikud_start_thread` takes the caller's `parentThreadId` from T3 and refuses with `not_top_level` when it is set; and the sync moves any link it finds on a child thread to the parent's item.
- **Order before the morning message:** the morning message is fixed at 08:00 Asia/Jerusalem, Sunday to Friday (requirements section 5), and the reconciler runs at 07:30 on the same days: the `overview` collector, then the T3 read, then the push. When it fails or the PC is off, the morning message and the board show the time of the last successful sync and the as-of time of the security data.
- **Untrusted text:** thread titles and repository data are data. The sync tool passes them only as JSON to the API, never into a shell command or a prompt.

### Security design

Status: tokens, owner and agent rights, the CSRF check and the secret check are implemented (rows 4 and 5); browser sign-in with Better Auth replaced pairing (owner's decision, 2026-11-01). The Telegram and morning-message rules are implemented (row 8). The deployment notes, including "after a restore", exist in [deployment.md](deployment.md) (row 13).

- **Network:** production is reachable only over NetBird; the owner configures it. The development stack binds to `127.0.0.1` only.
- **Tokens:** `MIKUD_OWNER_TOKEN` and `MIKUD_AGENT_TOKEN`, each at least 32 random bytes, set only in `.env`. Compared in constant time on their SHA-256 digests. The server refuses to start without both, when they are equal, or when one is short.
- **Owner rights:** everything, including delete, stage change, settings and the account. **Agent rights:** everything else in requirements section 3: no delete, no stage change (proposals only), no settings, no account or session routes.
- **Browser sign-in (Better Auth):** one account; a username and a password (12 to 128 characters), then a TOTP code, which is mandatory: the API refuses a session until that session proved its code (`two_factor_at`, per session; `twoFactorEnabled` on the user is not proof). The first run (`/api/setup`) creates the owner once under the auth lock and signs him in for enrolment; completing enrolment ends every other session. Cookies are `HttpOnly`, `SameSite=Lax` (Telegram deep links open with them), host-only, `Secure` with an https public URL; `MIKUD_AUTH_SECRET` (at least 32 bytes) signs them and encrypts the TOTP secret.
- **Only Mikud decides:** Better Auth runs without hooks behind Mikud's guard (`src/server/http/auth-guard.ts`), which admits five routes (sign-in by username, sign-out, get-session, TOTP enable during enrolment, TOTP verify) and answers 404 to every other one, checks CSRF on every POST before reading its body, rate-limits sign-in and codes by socket address (never a forwarding header; Better Auth's own limiter is off), applies the session clocks, and holds the auth lock (`AUTH_LOCK_KEY`, a session-level advisory lock on a connection of its own, 10 s, then `busy`) for the whole request. Success is read from the final response; the TOTP proof, the end of other sessions after enrolment and the audit row are written in one transaction under that lock.
- **Audit of the writes Better Auth owns (the exception):** every Mikud write records its audit row in the same transaction. Better Auth's own writes (the session at sign-in and enrolment, TOTP enable, sign-out) cannot share it, so they fail closed: when the audit transaction after a sign-in or enrolment fails, the new session and the challenge rows the request created are deleted and the answer is 500 with the cookie cleared, so a sign-in never succeeds without its audit row; a sign-out whose audit fails still succeeds and is logged by code, because the session is gone already. TOTP enable is audited when verification completes it.
- **Session clocks:** a session ends `sessionMaxDays` (1 to 90, default 30) after sign-in, and after `sessionIdleMinutes` without reported input when the idle limit is on (off by default). Polling never counts as input. Better Auth keeps sessions 91 days without refresh, so the clocks decide; the check locks the session row; an ended session answers `session_ended` with its reason until the hourly sweep removes it a day later. A replacement session keeps its clocks.
- **Account in Settings:** the signed-in browsers, change password (a Mikud service under the auth lock: re-reads the session, checks the current password, ends the other sessions, keeps this one), sign out, sign out the others, sign out everywhere, and the recovery command.
- **Recovery:** `node dist/server/cli.js reset-password` in the container sets a random password and prints it once, removes TOTP, ends every session and pending challenge, and writes the audit row (actor `system`, label `cli`), in one transaction under the auth lock. No recovery over the network.
- **Tokens and browsers:** the owner token stays for scripts and tests and is never used by a browser; a session never stands in for a token (sync routes and `/mcp` refuse it). The `mikud_browser` cookie only names the browser for "new since your last visit".
- **After a restore:** a restored database may hold sessions ended after the backup was taken. The deployment notes tell the owner to sign out everywhere after any restore (or run the recovery command), and to replace `MIKUD_AUTH_SECRET` and the tokens if they may have leaked.
- **CSRF:** every state-changing request from a browser must carry a custom header and an `Origin` equal to the configured public URL.
- **Telegram:** only the configured owner chat id is served. Every update is recorded by `update_id` in the same transaction as the item and its audit row; the next poll's `offset` acknowledges only updates whose transaction committed, and a repeated `update_id` does nothing.
- **Morning message once a day:** a `job_runs` row for the local date is written as `sending` before the send and `sent` after. On start, a run left in `sending` becomes `unknown` and is not sent again (at most once, never twice). A send that may have reached Telegram (timeout, dropped connection, a 5xx or an answer that is not Telegram's JSON, such as a gateway's error page) also becomes `unknown`; only a definite failure (Telegram's own JSON answer with `ok: false` and a 4xx code, or no connection at all) becomes `failed` with its code and is retried on the next 30-second tick. A missed time is sent late only until 3 hours after the configured time (11:00), with no note; after that the day is `skipped` and the status route shows it.
- **Bot text:** the bot's captures pass the same secret check as agent text; a refusal is answered without repeating the text.
- **Secrets in agent text:** text written with the agent token is checked against high-confidence patterns only: known token formats (GitHub, OpenAI and Anthropic keys, Slack, AWS access keys, Google API keys, Telegram bot tokens, JWTs), private key blocks (redacted whole, BEGIN through END or to the end of the text when END is missing), credentials in URLs (`user:password@`), assignments such as `password=`, `token:` or `secret=` followed by a value that is not a placeholder (`***`, `<...>`, `[redacted]`), environment-style assignments whose name ends in TOKEN, SECRET, PASSWORD, PASSWD, KEY or APIKEY (`MIKUD_OWNER_TOKEN=...`, `DB_PASSWORD: ...`) with any value of 8 or more characters that is not a placeholder (lower-case words and hex included), IPv4 addresses outside documentation ranges and loopback, and host names under the private domains listed in the server's `MIKUD_PRIVATE_DOMAINS`. Commit SHAs and checksums pass. A refusal returns `secret_suspected` with the rule name, never the matched text. Text from the sync tool (thread titles) is not refused: matches are replaced with `[redacted]`, so one record cannot stop a run. This is a safety net, not a promise that every secret is caught.
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
| `CHANGELOG.md` | Tracked | Release workflow and readers expect it at the root | Exists |
| `package.json` | Tracked | pnpm and Node resolve it from the root | Exists |
| `pnpm-lock.yaml` | Tracked | pnpm requires it next to `package.json` | Exists |
| `pnpm-workspace.yaml` | Tracked | pnpm 12 reads its settings only from this file (it ignores the `pnpm` field of `package.json`) and refuses to install while esbuild's build script is not allowed there. Holds settings only, no packages | Exists |
| `biome.json` | Tracked | Biome 2 must find its configuration at the root (nested configs fail) | Exists |
| `tsconfig.json` | Tracked | Editors and `tsc` find it at the root; extends `config/` | Exists |
| `docker-compose.yml` | Tracked | Production deployment file, run from the deploy directory | Exists |
| `docker-compose-dev.yml` | Ignored, never committed | Machine-local development stack used only by `scripts/local.sh` | Template exists: `docker/docker-compose-dev.example.yml` |
| `.env.example` | Tracked | Compose `env_file` contract next to `docker-compose.yml` | Exists |
| `.env` | Ignored | Real values on the server only | Ignored; never created in the repository |

Directories: `drizzle/` (generated migrations; the Drizzle migrator and drizzle-kit read and write them there), `src/` (code), `scripts/` (workflow scripts), `docker/` (Dockerfiles, development Compose template, development env), `config/` (movable tool configuration), `docs/` (documentation), `prompts/` (T3 task prompts), `.github/` (CI, Dependabot, templates), `e2e/` (Playwright specs).

## Docker decisions

Status: implemented and verified locally as described here. The production file has not been run; the owner deploys.

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
| 1 | Repository baseline | Done: settings read back on 2026-11-01 (see Current truth) | Git repository, public GitHub repository, docs, license, ignore rules, `.gitattributes` | `git status` clean; GitHub settings read back |
| 2 | Toolchain and package | Done locally; CI not run yet | `package.json`, lockfile, Biome, TypeScript, Vitest; toolchain image with Node, pnpm, shellcheck, shfmt | Guards and a type check pass in the container |
| 3 | Guards | Done locally; "no external assets" came with the UI (row 7) as `scripts/lib/web-dist-check.sh`, run by `verify.sh` on the built `dist/web`. Planted violations, each failing and then passing once removed: Hebrew in a new source file and in `he.json.bak`; a private IPv4 address (allowed forms and version strings such as `1.2.3.4.5` pass); `build:` in `docker-compose.yml` and in the ignored copy; a deny-list term, also in upper case (inside a longer word it passes; CI output shows only file and line); a key only in `en.json`; a shellcheck finding; an shfmt difference; a script without the executable bit | Hebrew outside the locale file, IPv4 literals, `build:` in Compose, local deny list, locale key parity, no external assets | Each guard fails on a planted violation |
| 4 | Schema, services, audit | Done locally on `main` (2026-11-01, `verify.sh`): 18 service tests (refused agent, bot and sync delete; refused agent stage change; stale `version`; `closed_at`; audit row rolled back with its change; suppressions; goals and progress; proposals), 9 start-of-thread tests, 15 sync tests, 11 read-model tests, 54 secret-check tests | Every rule in requirements section 3 enforced by actor; audit row per change; concurrency by `version` | Tests per rule, including refused agent delete and stage change and a stale `version` |
| 5 | HTTP API and sign-in | Done locally on `main` (2026-11-01, `verify.sh`): 17 HTTP tests (tokens, CSRF, rate limit, error codes). Pairing replaced by Better Auth sign-in (owner's decision, 2026-11-01): HTTP tests of setup and its race, enrolment, sign-in with TOTP, the route allow-list, CSRF, the rate limits with a forged forwarding header, the clocks, the account routes, the recovery CLI, the auth lock in both race orders, failing closed, and the upgrade from the schema before sign-in; end-to-end setup, sign-in with a self-computed code, a wrong password and sign-out | Token and session auth, mandatory TOTP, CSRF checks, stable error codes | HTTP tests: missing and wrong token, agent on owner route, bad Origin, TOTP required, ended session |
| 6 | MCP server | Partial: done locally on `main` (2026-11-01): 6 tests with the SDK client over HTTP (tool list without a delete tool and with a stage only in the proposal tool; start of thread twice returns the same item; `not_top_level`; stage unchanged; secret refused; `version_conflict`; bearer required). The real Claude Code and Codex connections wait for the dry run; the tools are listed in [api.md](api.md) | Tools listed in `docs/agent-instruction.md`, same rules as the API | MCP client test over HTTP; one real connection each from Claude Code and Codex in the dry run |
| 7 | Web UI | Done on `main` (#9), verified locally on 2026-11-01 (see Current truth); CI not run yet | All screens, Hebrew and English, RTL and LTR, light and dark, phone; `v3-ui-style` checklist and guard tests | Playwright against the container; screenshots at 1440, 1000 and 390 px in both themes |
| 8 | Telegram and morning job | Partial: on `main` (#8), verified locally on 2026-11-01 with `verify.sh`: 10 bot tests and 8 morning-job tests against a stand-in Bot API, including a repeated update, a crash between commit and offset simulated by redelivery, and a crash during the send (`sending` at start-up becomes `unknown`), plus unit tests of the message in both languages and of the schedule; the bundled server run by hand against a stand-in. The real message waits for the bot token and the dry run | Morning message once per day, quick add, owner-only, `update_id` dedup | Tests against a stand-in Bot API, including a crash between send and record and a repeated update; one real message in the dry run |
| 9 | Sync tool and reconciler prompt | Partial: the sync side is done and verified on 2026-11-01; the server side of the rules (applying, owner wins, suppressions) is done with its rule tests (row 4). `scripts/verify.sh` passed with 49 sync unit tests (a 50th, for the Windows `.cmd` path, runs only on Windows): snapshot mapping (enabled counts by severity, not enabled, no access, error, a stale family and a stale repository keep the time of their last success, a missing family is unknown), thread mapping with child threads, repository resolution by identity, folder and worktree, the `.cmd` command line, env files, sends in order against a local stub server, and the token absent from every output. Run by hand on Windows: a fake `t3.cmd` in a folder with spaces and parentheses received `& | < > ^ ! ( ) ; $( )` intact, `%` was refused, the token did not reach the child. A real `--dry-run --no-collect` on the owner's PC read every project through the real T3 CLI with no failure, Hebrew titles intact; counts are in the pull request, not here | Rules in "Agent and sync rules" | Tests with recorded `t3` and snapshot fixtures: owner edit between read and apply, two linked threads, deleted item, stale security source, failed record; one real run in the dry run |
| 10 | Container and Compose | Done locally (health, UID and hardening checks in `verify.sh`); the production file has not been run | Non-root runtime, health check, production and development Compose files | Health and UID checks in `verify.sh` |
| 11 | Workflow scripts | Done locally  (2026-11-01): `local.sh` and `verify.sh` as above. `try-pr.sh 6` built PR #6 as `mikud:pr-6`, ran `mikud-pr` healthy on `127.0.0.1:8091` (UID, hardening, `/healthz` with the database), seeded 3 projects, items in all six statuses, 2 stage proposals, security sources (one stale) and an inbox item with the agent token; `status`, a second start (refused) and `restore` (stack, data, image, tokens, worktree and ref gone) were exercised, as were refusals of a bad number, the development port, a bad port and a PR that cannot be fetched; `mikud-dev`, its data and image were untouched. `release.sh`: `scripts/test-release.sh` 78 checks against a local remote (a release and the next, every refusal, the dry run changing nothing, and each stop-halfway path finished by the next run), and three planted defects each failed it; a real `--dry-run` refused a branch other than `main` and, on a sandbox `main`, stopped at the unauthenticated GHCR read before changing anything. Full `scripts/verify.sh` passed in a fresh WSL clone at `f32d440`. No real release has run | `local.sh`, `verify.sh`, `try-pr.sh`, `release.sh` per the contracts below | Each command exercised; refusals tested |
| 12 | CI and Dependabot | Partial: CI, Dependabot and the Release workflow (manual, `dry_run` input, CI called first) exist; no run on GitHub yet | Path-filtered CI, summary job, weekly grouped updates | Green run on a pull request and on `main` |
| 13 | Agent instruction and deployment notes | Partial: `docs/agent-instruction.md` drafted (proposal awaiting the owner, not reviewed yet); `docs/deployment.md` written (2026-11-01), not yet reviewed or followed on a server | `docs/agent-instruction.md`; `docs/deployment.md` including the one-time move from the dry run to production: stop the local stack (the only bot consumer) first, move the approved data with `pg_dump` and `pg_restore` (which carries `job_runs` and `telegram_updates`), start production, point the reconciler at it | Cross-provider review |
| 14 | Dry run | Planned | On the development stack: seeded drafts (stage as proposals), one real morning message, morning view at desktop and phone sizes, the launch evidence below | Owner's review |

### Launch evidence for the dry run

- Agent permission checks through both API and MCP: delete, stage change and settings refused for the agent token; proposals accepted.
- A real MCP connection from a Claude Code thread and from a Codex thread, each running the start-of-thread call.
- Signing in on desktop and phone with TOTP, then a Telegram deep link opening the right item (through sign-in when the browser is not signed in).
- A sync while the owner edits an item; a sync run twice; a sync with stale security data.
- One real morning message and one quick add from the phone.
- Imported threads do not flood "new since your last visit"; a visit in one browser does not hide updates in another before they were shown.

## Required workflow contracts

All four scripts are Bash with `#!/usr/bin/env bash`, LF line endings and the executable bit, run inside WSL, resolve the repository root from their own location, and run Node, pnpm, shellcheck and shfmt inside the toolchain container. Development and test data live on the Linux file system, not under `/mnt/c`.

- `scripts/local.sh build|up|start|down|status|logs|nuke`: builds `mikud:dev` explicitly, runs `docker-compose-dev.yml` (fails with a clear message when it is missing), checks health and that the application process is not UID 0. `down` keeps the database directory; `nuke` asks for confirmation and deletes only the validated development database directory.
- `scripts/verify.sh [--changed [BASE]] [--guards-only] [--skip-e2e]`: the one verification entry point used locally and in CI: guards, Biome, types, unit tests, HTTP and MCP tests against a disposable PostgreSQL, builds, the container with health and UID checks, then Playwright. Cleans up its stack.
- `scripts/try-pr.sh <number>|status|restore`: builds the pull request in a disposable worktree and runs it as a separate Compose project with its own disposable PostgreSQL seeded with invented fixtures, its own generated tokens and Telegram off (no bot settings; a stand-in Telegram API comes with row 8 if the bot needs one to start). It never touches the development stack, its database or its `.env`, which hold real data and the real bot token after the dry run. `restore` removes the PR stack. Never pushes, merges or touches the user's checkout.
- `scripts/release.sh`: run by the Release workflow on `main`: preflight (clean, synchronized, full verify), version bump chosen by the operator, changelog section closed, release commit and immutable tag, image pushed to GHCR, GitHub Release. Has a dry run. Never deploys.

## CI and GitHub

- One CI workflow: a change-detection job, area jobs gated by it, and a final `summary` job that passes when skipped areas were not affected. Pull request runs cancel superseded runs; `main` runs are not cancelled. Manual full run and a weekly scheduled full run. Least-privilege permissions; actions pinned to commit SHAs.
- Release workflow: manual, on `main`, runs the full CI first (CI is callable for this), then `release.sh` with `contents: write` and `packages: write` in the release job only; a `dry_run` input publishes nothing.
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
