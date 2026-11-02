# AGENTS.md

## Project

Mikud is a personal, single-user project-focus system: a morning board, a Telegram morning message and an MCP server that AI agents use to keep work items current. One application container with PostgreSQL, reachable only over the owner's private network.

**Stage: foundation.** Read these before any change:

- Product requirements: `docs/requirements.md`
- Foundation plan, decisions and status: `docs/project-foundation.md`

The foundation plan is the desired state. Items marked planned do not exist yet. Check the repository before assuming a file, command or feature exists.

UI follows the `v3-ui-style` skill.

## Layout

One pnpm package (no workspace apps).

- `src/server/`: Hono server. `index.ts` starts it and applies the owner's settings (the bot and the morning job when Telegram is on), `config.ts` reads and checks the environment (keys, wiring, the per-field overrides of owner settings; refuses `BETTER_AUTH_*`), `cli.ts` is the recovery command (`reset-password`), `app.ts` mounts `/healthz`, Better Auth's own handler at `/api/auth`, `/api/setup`, `/api/v1`, `/mcp` and the built UI (`web.ts`: `dist/web` with a page fallback and the Content-Security-Policy) and maps errors, `healthcheck.ts` is the container health check, `errors.ts` holds the stable error codes, `db/` the Drizzle schema and client.
  - `auth/`: `auth.ts` (Better Auth 1.7.15 as it documents itself: the username, twoFactor and `@better-auth/api-key` plugins, one `hooks.before` with the route allow-list and the refusals, one `hooks.after` for sign-out, `databaseHooks` for the audit, and `AuthHolder`, which rebuilds the instance when a setting it reads changes), `recovery.ts` (the CLI's documented password reset).
  - `services/`: every write and read model. `context.ts` (actor, audit row, agent secret check, the link lock), `account.ts` (whether the owner exists, the browser identity), `items.ts`, `projects.ts`, `threads.ts` (start of thread), `sync.ts` and `sync-rules.ts` (T3 and security snapshots), `reads.ts` (morning, project, item, archive, inbox, audit), `admin.ts` (settings with their environment locks, suppressions, visits), `secrets.ts` (the secret check, reloadable private domains).
  - `settings/`: `crypto.ts` (secrets stored in Settings, encrypted with `MIKUD_SETTINGS_KEYS`), `effective.ts` (each owner setting from the environment, the database or its default, and whether it is locked), `runtime.ts` (applies a save to the Better Auth instance, the bot and the secret check without a restart).
  - `http/`: `auth.ts` (an agent key through `verifyApiKey`, or a Better Auth session of an account with two-factor on; the CSRF check, the failed-key limit, the `mikud_browser` cookie), `setup.ts` (`GET /api/setup/status`) and `api.ts` (the `/api/v1` routes). `mcp/server.ts`: the MCP tools.
  - `telegram/`: `api.ts` (Bot API client; a failure is `answer`, `not_sent`, `uncertain` or `aborted`), `html.ts` (Telegram HTML that escapes every value), `bot.ts` (long polling, one transaction per update), `runtime.ts` (owns the bot and the morning job; `reload` restarts them with the pair in effect, and sends sign-in codes), `texts.ts` (locale texts), `status.ts` (the status route's read).
  - `jobs/`: `morning.ts` (the 08:00 schedule and its durable runs in `job_runs`), `morning-message.ts` (the message, a pure function), `time.ts` (Asia/Jerusalem wall clock and number formats).
  - `testing/db.ts`: a migrated database per integration test file, and a movable clock. `testing/app.ts` (the app's core with Better Auth, the settings runtime and an idle Telegram service; agent keys and a signed-in owner for tests), `testing/browser.ts` (a cookie-jar browser with sign-up, enrolment and sign-in on Better Auth's routes), `testing/totp.ts` (a self-written RFC 6238 TOTP). `testing/bot-api.ts`: a stand-in Telegram Bot API on `127.0.0.1` for tests (getUpdates with Telegram's offset rules, sendMessage recorded, failures on demand).
- `src/shared/`: enum codes as `const` arrays with zod schemas (`enums.ts`), the API request schemas (`api.ts`), the username and password rules and the session clock limits (`auth.ts`), the Date Format and Time Format settings that the UI and the morning message share (`datetime-formats.ts`), the UI paths that messages link to (`routes.ts`) and the locale files `locales/en.json` and `locales/he.json`.
- `drizzle/`: generated SQL migrations and their snapshots. Never edit by hand. The one exception is a data-only change: `pnpm db:generate --custom --name <change>` (documented by drizzle-kit) makes an empty migration whose SQL is written by hand (`0005_end-sessions`). No other hand-written SQL is allowed.
- `config/`: TypeScript base config, Vitest configs, Drizzle Kit config, `vite.config.ts` (the UI build) and `playwright.config.ts` (end-to-end tests).
- `docker/`: toolchain and application Dockerfiles, the development Compose template and `dev.env` (fake development values).
- `scripts/`: `local.sh`, `verify.sh`, `try-pr.sh`, `release.sh` and its tests `test-release.sh`, `ci-result.sh` (the CI run a release reuses) and its tests `test-ci-result.sh`, `test-release-workflow.sh` (the Release workflow's wiring); `lib/common.sh` (shared helpers), `lib/guards.sh` (repository guards) and `lib/try-pr-seed.mjs` (the owner, an agent key and invented fixtures for `try-pr.sh`).
- `src/sync/`: the sync tool that runs on the owner's PC, bundled to `dist/sync/mikud-sync.js` (Node stdlib only at runtime; no imports from `src/server/`). `main.ts` is the entry, `run.ts` one run, `fixtures/` invented T3 and `overview` data for its tests. See `docs/sync.md`.
- `prompts/`: `reconcile.md`, the instructions of the T3 scheduled task that runs the sync tool.
- `docs/api.md`: the HTTP API and MCP contract. Change it together with the routes.
- `docs/deployment.md`: the owner's deployment notes. `.github/workflows/`: `ci.yml` and `release.yml`.
- `src/web/`: the web UI (React 19, Vite, React Router, TanStack Query), built to `dist/web`. Its own `tsconfig.json` (DOM, JSX).
  - `api/`: `types.ts` (every shape of `docs/api.md`), `endpoints.ts` (every `/api/v1` route and the query keys), `client.ts` (the one fetch client: CSRF header, `{error}` to `ApiError`, 401 and `totp_required` to the app), `auth.ts` (Better Auth's React client with the twoFactor, username and api-key plugins, and its failures). `mock/`: invented data behind the same routes (`mock/auth.ts` answers Better Auth's), loaded only with `VITE_MIKUD_MOCK=1`.
  - `ui/`: the shared builders and parts: `Dialog.tsx` (every dialog; a sheet on phones), `Toast.tsx`, `confirm.tsx`, `layers.ts` (Escape, Back, focus, inert), `unsaved.tsx` (save bar guard), `refresh.ts` (`usePageQuery`, the paces), states, tags, time, copy.
  - `shell/`: the frame (sidebar, rail, phone bars, More sheet), the bell, quick add, item actions with Undo, theme, the session gate with Better Auth's `useSession` (`Root.tsx`). `pages/`: one file per page and the item dialog; `pages/auth/` the sign-in and setup pages outside the gate (with the backup codes); `pages/settings/` the Account and Agent access panels and the settings rows. `format/`: the only date, time and number helpers. `i18n/`: locale lookup with plurals. `styles/ui.css`: the one stylesheet of `--ui-*` tokens and `ui-` components.
  - `guards.test.ts`: the v3 guards (popups only from the builders, every page refreshes, dates through the helpers, locale keys used exist).
- `e2e/`: Playwright specs against a running Mikud, desktop then phone (each with its own `X-Forwarded-For`): `auth.spec.ts` (first-run setup with TOTP and backup codes, a wrong password, sign-in, sign-out, a backup-code sign-in) runs first and stores each project's signed-in browser; `session.spec.ts` (Better Auth's client extends the session when the tab comes back, through the transport fix, and Mikud's polling alone does not; needs `E2E_DATABASE_URL`, which `verify.sh` sets), `settings.spec.ts` (an agent key, the password, the Telegram fields) and `ui.spec.ts` (morning, an item status change with Undo, quick add, sign-out) reuse it. `helpers.ts` and `totp.ts` hold the shared state and the codes.

## Commands

Run every script inside WSL from the repository. Node, pnpm, shellcheck and shfmt run in the toolchain container; the host needs Docker only.

- `scripts/verify.sh`: guards, Biome, types, unit tests, build, schema-versus-migration check, database tests against a disposable PostgreSQL (`mikud-verify`), then the image with health, UID and hardening checks, then the end-to-end tests in the Playwright image against that container. After the build it checks `dist/web` for external assets and the mock (`scripts/lib/web-dist-check.sh`). `--guards-only` for the guards alone; `--changed [BASE]` runs guards only when every change is documentation; `--skip-e2e` skips the end-to-end tests.
- `scripts/local.sh build|up|start|down|status|logs|nuke`: the development stack (`mikud-dev`) from the ignored `docker-compose-dev.yml`. Create it once with `cp docker/docker-compose-dev.example.yml docker-compose-dev.yml`. Serves `http://127.0.0.1:8090`; `MIKUD_PORT` changes the port.
- `scripts/try-pr.sh <number>|status|restore`: runs a pull request's head as the separate Compose project `mikud-pr` (own PostgreSQL, generated keys in a 0600 file under `~/.cache/mikud/try-pr`, an owner created through Better Auth's sign-up with a generated password, TOTP secret, backup codes and an agent key in `owner.env` there, also 0600, Telegram off, invented fixtures) on `http://127.0.0.1:8091`; `MIKUD_PR_PORT` changes the port. Never touches `mikud-dev`. `restore` removes the stack, its data, image and worktree.
- Recovery on a running stack: `docker compose exec mikud node dist/server/cli.js reset-password` (production) or `source scripts/lib/common.sh && dev_compose exec mikud node dist/server/cli.js reset-password` (development). It runs Better Auth's documented reset: prints a new password once and ends every session; two-factor stays.
- Releases: the **Release** workflow (Actions → Release → Run workflow on `main`, choose patch, minor or major; `dry_run` checks everything and publishes nothing) reuses the newest CI run of the commit on `main` when its latest attempt succeeded (waiting up to 30 minutes for one that still runs; it never falls back to an older green run) and runs the whole CI on the commit otherwise (`scripts/ci-result.sh` decides, and the workflow checks a reused run again with it right before `release.sh`), then `scripts/release.sh --target ghcr --bump <patch|minor|major> [--dry-run]`: release commit and tag, the image on GHCR (the version, then `:latest`) and the GitHub Release from the CHANGELOG section. A run that stopped halfway is finished by the next run (a new Run workflow, not "Re-run failed jobs"). Agents never release: they run the workflow only with `dry_run`, and `release.sh` only with `--dry-run`. `scripts/test-release.sh` (run by the guards) covers each way a run can stop, `scripts/test-ci-result.sh` which CI run counts, and `scripts/test-release-workflow.sh` which jobs and steps run on both CI paths with and without `dry_run` (both also run by the guards). Never deploys.
- A single tool in the toolchain: `source scripts/lib/common.sh && build_toolchain && in_toolchain "pnpm test"`.
- UI development: `in_toolchain "VITE_MIKUD_MOCK=1 pnpm dev:web"` serves the UI on the mock API (port 5173 in the container); without the flag `pnpm dev:web` proxies `/api` to the development stack.
- End-to-end tests against the development stack: `docker run --rm --ipc=host --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/repo" -w /repo mcr.microsoft.com/playwright:v1.64.1-noble npx playwright test --config config/playwright.config.ts` (from a WSL clone; the tests create invented records and set the language to Hebrew). On a stack whose owner exists, pass `-e E2E_USERNAME -e E2E_PASSWORD -e E2E_TOTP_SECRET` of that owner; on an empty database the first test creates one.
- New migration after a schema change: `in_toolchain "pnpm db:generate --name <change>"`. `verify.sh` fails when the schema and the migrations disagree. A data-only change uses `pnpm db:generate --custom --name <change>` and is the only hand-written SQL.

Verify in proportion to the risk of the change, and report what ran and its result:

- **Documentation only** (`docs/`, `README.md`, `AGENTS.md`, `CHANGELOG.md`, `LICENSE`; nothing under `prompts/`, whose `reconcile.md` instructs the T3 scheduled task): `scripts/verify.sh --changed`, which then runs only the guards.
- **Anything else**: the full `scripts/verify.sh` before opening the pull request.

On a pull request, CI runs the guards, and `scripts/verify.sh --changed origin/main` unless only Markdown files, `docs/` or `LICENSE` changed; then it runs only the guards.

## Traps

- Node 25 and later no longer ship Corepack. Both Dockerfiles install it from npm at a pinned version (`corepack@0.36.0`) before `corepack enable`; the toolchain's `corepack prepare pnpm@...` must name the version of `packageManager`.
- The sync bundle (`build:sync`) targets `node24`, the Node of the owner's PC, while the server targets `node26`. Move the sync target only after the PC runs a newer Node (see `docs/sync.md`).
- pnpm 12 reads its settings only from `pnpm-workspace.yaml` (not from `package.json`), and refuses to install when a dependency's build script is not allowed there. The file holds settings only; it lists no packages.
- `grep -P` with `\x{...}` code points needs a UTF-8 locale; `scripts/lib/guards.sh` sets `LC_ALL=C.UTF-8` and stops on any grep error, so a broken pattern cannot pass silently.
- Tests named `*.integration.test.ts` run only from `verify.sh`, which passes `MIKUD_TEST_DATABASE_URL`. `pnpm test` skips them.
- Node refuses to start a `.cmd` file (the T3 CLI on Windows) without a shell. `src/sync/exec.ts` runs it through `cmd.exe /d /v:off /s /c` with every part quoted and refuses `"`, `%` and line breaks; never build a shell string anywhere else.
- `ON DELETE RESTRICT` (items of a project) fails with SQLSTATE `23001`, not `23503`.
- Codes are text columns with database checks generated from `src/shared/enums.ts`: adding a code needs a new migration.
- Services take their time from `ctx.clock()`, never `now()` in SQL or `new Date()`, so tests can move time; integration tests use `createTestDatabase` from `src/server/testing/db.ts`.
- Exported service functions are `async`: a refusal must be a rejected promise, not a synchronous throw.
- Fake secrets in tests are assembled at run time (`${"gh"}p_...`) and private IPv4 addresses with `[10, 1, 2, 3].join(".")`: the guards and GitHub push protection scan the literal text.
- Telegram is off unless a bot token and a chat id are both in effect (Settings, or `MIKUD_TELEGRAM_BOT_TOKEN` and `MIKUD_TELEGRAM_CHAT_ID`, each overriding its field). Tests never reach the real Bot API: they start `StandInBotApi` (`src/server/testing/bot-api.ts`) and give its URL to `BotApi`. `TELEGRAM_API_URL` exists for the same purpose and stays empty in production. The token is part of every Bot API path: never log a URL, a fetch error's message or message text; log `TelegramError.code`.
- The morning message goes out at most once a day: its `job_runs` row is taken as `sending` before the send. Only a definite failure (`answer`, `not_sent`) becomes `failed` and is retried; anything else becomes `unknown` and is never resent. Do not add a resend path for `unknown`.
- Bot text goes through the same secret check as agent text: `checkAgentText` covers actor kinds `agent` and `bot`.
- Write bidirectional control characters in source as escapes (backslash, `u`, four hex digits), never as literal characters. Some editing tools turn the escapes into the characters; check new files before committing.
- UI text keys may not contain dots inside one segment: the lookup splits keys on `.`, so audit actions are keyed `item_update`, not `item.update`. Hebrew is allowed only in `he.json`: a language's name written in that language comes from `Intl.DisplayNames`, not from `en.json`.
- The production UI build defines `__MIKUD_MOCK__` as `false`, which drops `src/web/api/mock`; `web-dist-check.sh` fails when the mock's storage key `mikud.mock.` is in `dist/web`. Never import the mock any other way.
- `@playwright/test` in `package.json` and `PLAYWRIGHT_IMAGE` in `scripts/lib/common.sh` must name the same version; `verify.sh` refuses a mismatch.
- The verification stack's `MIKUD_PUBLIC_URL` is `http://127.0.0.1:8090`; the server refuses a browser change whose `Origin` differs. `e2e/global-setup.ts` forwards that address to the container (`E2E_TARGET`), so do not point the tests at `http://mikud:8080` directly.
- The UI formats dates only through `src/web/format/datetime.ts` (app time zone Asia/Jerusalem, the Date and Time Format settings); `guards.test.ts` fails on `toLocaleDateString`, `Intl.DateTimeFormat` and the like anywhere else. Every layer comes from `ui/Dialog.tsx` or a builder listed there with its reason.
- The guards scan tracked files and new files that are not ignored. The deny list `docs/private/deny-list.txt` exists only on the owner's machine; in CI the guard is skipped, and its output never repeats a matched line.

- **Better Auth is used only as it documents itself.** Its built-in features, options, official plugins and documented hooks; never a wrapper around its handler, a lock around its requests, Mikud session clocks or proofs, or post-processing of its answers. A requirement those cannot meet is a gap for the owner (see "Security design" in the foundation plan), not code. Put this rule in a reviewer's prompt.
- **The route allow-list lives in `hooks.before` (`ALLOWED_PATHS` in `auth/auth.ts`), matched on `ctx.path` (the route pattern) for HTTP requests only.** A new Better Auth route stays closed until it is listed; `auth/auth.test.ts` fails when a listed path no longer exists. Server calls (`auth.api.*`) have no `ctx.request` and pass.
- **Better Auth cannot require two-factor.** The `/api/v1` middleware and `/api/setup/status` accept a session only while `user.twoFactorEnabled` is true; the setup page calls `revokeOtherSessions` after enrolment. A parallel sign-in during enrolment can keep a session (G6); the test pins the gap. Do not "fix" it with custom session code.
- **`deferSessionRefresh`: only the Better Auth client's own refresh extends a session.** Keep `sessionOptions.refetchInterval` at 0, and never call the client's `getSession` or `useSession().refetch` from background polling: that would keep any open tab signed in for ever.
- **Sign-out audit never throws.** Better Auth swallows a throwing `session.delete.before` on `/sign-out`, answers 200 and leaves the session valid. Sign-out is audited in `hooks.after`, which logs and never throws. Every other audit hook may refuse by throwing.
- **Hook order:** the user's `hooks.after` runs before the plugins' after-hooks, so the sign-in audit lives in `databaseHooks.session.create.before`, keyed on `context.path`. `databaseHooks` do not fire for the api-key plugin's model: key events are audited in `hooks.before`.
- **Audit rows go through Mikud's own connection**, not Better Auth's transaction (its transaction-scoped adapter is not documented). A row can outlive a change that rolled back (G5).
- **The api-key plugin limits each key to 10 requests a day by default.** Mikud sets `rateLimit: { enabled: false }`; keep it, or the sync stops. `enableSessionForAPIKeys` stays false: a key never becomes a session.
- **`trustedProxies` holds only behind Traefik**, with Mikud reachable through Traefik alone and Traefik replacing client forwarding headers (deployment.md). In the dev and verify stacks there is no proxy: tests and e2e projects send their own `X-Forwarded-For` (a valid address, one per browser), or every request shares one bucket.
- **The `/api/auth` mount passes a request without content with a null body (`withoutEmptyBody` in `app.ts`, owner's decision).** Better Auth's client sends its refresh `POST /get-session` without a body, `@hono/node-server` attaches an empty body stream to every POST, and better-call's `getBody` then answers 415 for a missing Content-Type. Only not GET or HEAD, `Content-Length: 0` and no `Transfer-Encoding` qualify; a real body keeps Better Auth's own checks. It normalizes the transport only; never extend it to Better Auth's options or answers. Remove it when upstream sends no body for empty requests (`e2e/session.spec.ts` and `auth-flow.integration.test.ts` cover it).
- **Better Auth skips its origin check under `NODE_ENV=test`**; `auth.ts` sets `advanced.disableOriginCheck: false` so tests see production's behaviour. Keep it.
- **`BETTER_AUTH_*` and `AUTH_SECRET` refuse to start:** Better Auth reads them on its own when an option is missing.
- **Two key families:** `MIKUD_AUTH_SECRETS` (Better Auth: cookies, TOTP and backup codes; `MIKUD_AUTH_SECRET` is its legacy fallback) and `MIKUD_SETTINGS_KEYS` (secrets stored in Settings). Never share a value between them. Rotate by putting a new version first and keeping the old one listed.
- **The CLI reset never touches two-factor.** It runs `requestPasswordReset` with a local `sendResetPassword`, then `resetPassword`, as server calls; both routes stay closed over HTTP.
- **Owner settings:** every setting the owner manages lives in the `settings` row with a default and is edited in the UI. An environment variable may override one field; the API answers `setting_locked` and the UI shows the field locked with the variable. Only the database connection, file paths, deployment wiring and the keys stay in the environment alone.
- **Sign-in is rate limited** (5 per 5 minutes per address and route, also in tests). Integration tests give each browser its own `X-Forwarded-For`; end-to-end specs reuse the session stored by `auth.spec.ts` instead of signing in again, and `freshTotp` never sends a code of an already used 30-second step.

## Docker

- One image, `docker/mikud.Dockerfile`: esbuild bundle and migrations on `node:26.13.0-bookworm-slim`, `USER node`, no `node_modules`, health check `node dist/server/healthcheck.js` (calls `/healthz`, which runs `select 1`). State lives only in PostgreSQL; the container has no volume and runs with a read-only root file system, no capabilities and `no-new-privileges`.
- `docker-compose.yml` (production) runs only `mikud` from `ghcr.io/shlomiporush/mikud:${VERSION}` behind Traefik on the external `traefik` network, with no published port and no database; `DATABASE_URL` in `.env` points at the owner's PostgreSQL. Interpolation is limited to `VERSION` and `DOMAIN`.
- `docker/docker-compose-dev.example.yml` adds a `postgres` service with data in `${MIKUD_DATA_DIR}/postgres` (default `~/.local/share/mikud-dev`, on the WSL file system; the scripts refuse a path under `/mnt`). `mikud` binds to `127.0.0.1` only. `mikud` reads `docker/dev.env`, then the optional, ignored `.env.dev` at the repository root (Compose `env_file` with `required: false`), where a developer puts the real keys for a dry run (Telegram is set in Settings, or there by its variables). `scripts/verify.sh` sets `MIKUD_LOCAL_ENV_FILE=/dev/null` so it never reads `.env.dev`, and try-pr writes its own Compose file. Never read, copy or commit `.env.dev`. An existing `docker-compose-dev.yml` is a copy: copy the template again to get the change.
- Images are built only by the scripts; a guard fails on `build:` in a Compose file. Never stop or remove containers, networks or volumes of other projects.

## Repository policies

- The repository is public. Everything tracked is in English, except the Hebrew locale file `src/shared/locales/he.json`. Tests read Hebrew text from that file.
- Never commit environment-specific details: hostnames, IP addresses, bucket names, network details, tokens, real project names or real project data. They belong in the ignored `docs/private/` or in the server's `.env`. Fixtures and screenshots use invented projects.
- Store statuses, stages, types and severities as English codes; user-visible labels come from the locale files only.
- Keep the repository root minimal. Every root file is listed and justified in the foundation plan.
- Add user-visible or operational changes under `Unreleased` in `CHANGELOG.md`, written for the next release (no Changed or Fixed entries about things that were never released). Do not bump versions in pull requests; the Release workflow does that.
- Never commit `docs/private/`, `.env` or `docker-compose-dev.yml`. `docker/dev.env` holds only fake development values.
- Kanzo (AGPL) inspired the idea. Never copy its code.
- Commit email is the GitHub noreply address.

## Product rules that code must enforce

- Agents may not delete items or projects and may not change a stage (they propose one). Only the owner, in the UI, does that.
- Every write goes through the services layer and writes an audit row in the same transaction. The one exception is the writes Better Auth does itself (sign-in, enrolment, sign-out), which fail closed instead (see Traps).
- The browser signs in with Better Auth and TOTP, which is mandatory. Agents and the sync use agent keys only (Settings, Agent access); a session never stands in for a key, and a key never becomes a session.
- Text written by agents and the Telegram bot is checked for secrets and refused with `secret_suspected`.
- The bot serves only the configured owner chat and never answers another chat.
- The server never calls T3 or GitHub. Their data arrives through the sync tool on the owner's PC.
- The sync never overrides the owner: see "Agent and sync rules" in the foundation plan.

## Out of scope for agents

- Production deployment is the owner's. Agents have no access to the production server; run Mikud only on the local development stack.
- No backup feature: the owner backs up the database with his own tools.
