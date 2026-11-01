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

- `src/server/`: Hono server. `index.ts` starts it (and the bot and the morning job when Telegram is configured), `config.ts` reads and checks the environment, `app.ts` mounts `/healthz`, `/api/v1`, `/mcp` and the built UI (`web.ts`: `dist/web` with a page fallback and the Content-Security-Policy) and maps errors, `healthcheck.ts` is the container health check, `errors.ts` holds the stable error codes, `db/` the Drizzle schema and client.
  - `services/`: every write and read model. `context.ts` (actor, audit row, agent secret check), `items.ts`, `projects.ts`, `threads.ts` (start of thread), `sync.ts` and `sync-rules.ts` (T3 and security snapshots), `reads.ts` (morning, project, item, archive, inbox, audit), `admin.ts` (settings, suppressions, devices, visits), `secrets.ts`.
  - `http/`: `auth.ts` (bearer token, device cookie, CSRF check, rate limit) and `api.ts` (the `/api/v1` routes). `mcp/server.ts`: the MCP tools.
  - `telegram/`: `api.ts` (Bot API client; a failure is `answer`, `not_sent`, `uncertain` or `aborted`), `html.ts` (Telegram HTML that escapes every value), `bot.ts` (long polling, one transaction per update), `texts.ts` (locale texts), `status.ts` (the status route's read).
  - `jobs/`: `morning.ts` (the 08:00 schedule and its durable runs in `job_runs`), `morning-message.ts` (the message, a pure function), `time.ts` (Asia/Jerusalem wall clock and number formats).
  - `testing/db.ts`: a migrated database per integration test file, and a movable clock. `testing/bot-api.ts`: a stand-in Telegram Bot API on `127.0.0.1` for tests (getUpdates with Telegram's offset rules, sendMessage recorded, failures on demand).
- `src/shared/`: enum codes as `const` arrays with zod schemas (`enums.ts`), the API request schemas (`api.ts`), the Date Format and Time Format settings that the UI and the morning message share (`datetime-formats.ts`), the UI paths that messages link to (`routes.ts`) and the locale files `locales/en.json` and `locales/he.json`.
- `drizzle/`: generated SQL migrations and their snapshots. Never edit by hand.
- `config/`: TypeScript base config, Vitest configs, Drizzle Kit config, `vite.config.ts` (the UI build) and `playwright.config.ts` (end-to-end tests).
- `docker/`: toolchain and application Dockerfiles, the development Compose template and `dev.env` (fake development values).
- `scripts/`: `local.sh`, `verify.sh`, `try-pr.sh`, `release.sh` and its tests `test-release.sh`; `lib/common.sh` (shared helpers), `lib/guards.sh` (repository guards) and `lib/try-pr-seed.mjs` (invented fixtures for `try-pr.sh`).
- `src/sync/`: the sync tool that runs on the owner's PC, bundled to `dist/sync/mikud-sync.js` (Node stdlib only at runtime; no imports from `src/server/`). `main.ts` is the entry, `run.ts` one run, `fixtures/` invented T3 and `overview` data for its tests. See `docs/sync.md`.
- `prompts/`: `reconcile.md`, the instructions of the T3 scheduled task that runs the sync tool.
- `docs/api.md`: the HTTP API and MCP contract. Change it together with the routes.
- `docs/deployment.md`: the owner's deployment notes. `.github/workflows/`: `ci.yml` and `release.yml`.
- `src/web/`: the web UI (React 19, Vite, React Router, TanStack Query), built to `dist/web`. Its own `tsconfig.json` (DOM, JSX).
  - `api/`: `types.ts` (every shape of `docs/api.md`), `endpoints.ts` (every route and the query keys), `client.ts` (the one fetch client: CSRF header, `{error}` to `ApiError`, 401 to pairing). `mock/`: invented data behind the same routes, loaded only with `VITE_MIKUD_MOCK=1`.
  - `ui/`: the shared builders and parts: `Dialog.tsx` (every dialog; a sheet on phones), `Toast.tsx`, `confirm.tsx`, `layers.ts` (Escape, Back, focus, inert), `unsaved.tsx` (save bar guard), `refresh.ts` (`usePageQuery`, the paces), states, tags, time, copy.
  - `shell/`: the frame (sidebar, rail, phone bars, More sheet), the bell, quick add, item actions with Undo, theme, the session gate. `pages/`: one file per page and the item dialog. `format/`: the only date, time and number helpers. `i18n/`: locale lookup with plurals. `styles/ui.css`: the one stylesheet of `--ui-*` tokens and `ui-` components.
  - `guards.test.ts`: the v3 guards (popups only from the builders, every page refreshes, dates through the helpers, locale keys used exist).
- `e2e/`: Playwright specs against a running Mikud (pairing, morning, an item status change with Undo, quick add), desktop and phone.

## Commands

Run every script inside WSL from the repository. Node, pnpm, shellcheck and shfmt run in the toolchain container; the host needs Docker only.

- `scripts/verify.sh`: guards, Biome, types, unit tests, build, schema-versus-migration check, database tests against a disposable PostgreSQL (`mikud-verify`), then the image with health, UID and hardening checks, then the end-to-end tests in the Playwright image against that container. After the build it checks `dist/web` for external assets and the mock (`scripts/lib/web-dist-check.sh`). `--guards-only` for the guards alone; `--changed [BASE]` runs guards only when every change is documentation; `--skip-e2e` skips the end-to-end tests.
- `scripts/local.sh build|up|start|down|status|logs|nuke`: the development stack (`mikud-dev`) from the ignored `docker-compose-dev.yml`. Create it once with `cp docker/docker-compose-dev.example.yml docker-compose-dev.yml`. Serves `http://127.0.0.1:8090`; `MIKUD_PORT` changes the port.
- `scripts/try-pr.sh <number>|status|restore`: runs a pull request's head as the separate Compose project `mikud-pr` (own PostgreSQL, generated tokens in a 0600 file under `~/.cache/mikud/try-pr`, Telegram off, invented fixtures) on `http://127.0.0.1:8091`; `MIKUD_PR_PORT` changes the port. Never touches `mikud-dev`. `restore` removes the stack, its data, image and worktree.
- `scripts/release.sh --target ghcr --bump <patch|minor|major> [--dry-run]`: run by the manual Release workflow on `main`; never by agents except `--dry-run`. `scripts/test-release.sh` tests it offline and runs with the guards.
- A single tool in the toolchain: `source scripts/lib/common.sh && build_toolchain && in_toolchain "pnpm test"`.
- UI development: `in_toolchain "VITE_MIKUD_MOCK=1 pnpm dev:web"` serves the UI on the mock API (port 5173 in the container); without the flag `pnpm dev:web` proxies `/api` to the development stack.
- End-to-end tests against the development stack: `docker run --rm --ipc=host --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/repo" -w /repo mcr.microsoft.com/playwright:v1.64.1-noble npx playwright test --config config/playwright.config.ts` (from a WSL clone; the tests create invented records and set the language to Hebrew).
- New migration after a schema change: `in_toolchain "pnpm db:generate --name <change>"`. `verify.sh` fails when the schema and the migrations disagree.

## Traps

- pnpm 12 reads its settings only from `pnpm-workspace.yaml` (not from `package.json`), and refuses to install when a dependency's build script is not allowed there. The file holds settings only; it lists no packages.
- `grep -P` with `\x{...}` code points needs a UTF-8 locale; `scripts/lib/guards.sh` sets `LC_ALL=C.UTF-8` and stops on any grep error, so a broken pattern cannot pass silently.
- Tests named `*.integration.test.ts` run only from `verify.sh`, which passes `MIKUD_TEST_DATABASE_URL`. `pnpm test` skips them.
- Node refuses to start a `.cmd` file (the T3 CLI on Windows) without a shell. `src/sync/exec.ts` runs it through `cmd.exe /d /v:off /s /c` with every part quoted and refuses `"`, `%` and line breaks; never build a shell string anywhere else.
- `ON DELETE RESTRICT` (items of a project) fails with SQLSTATE `23001`, not `23503`.
- Codes are text columns with database checks generated from `src/shared/enums.ts`: adding a code needs a new migration.
- Services take their time from `ctx.clock()`, never `now()` in SQL or `new Date()`, so tests can move time; integration tests use `createTestDatabase` from `src/server/testing/db.ts`.
- Exported service functions are `async`: a refusal must be a rejected promise, not a synchronous throw.
- Fake secrets in tests are assembled at run time (`${"gh"}p_...`) and private IPv4 addresses with `[10, 1, 2, 3].join(".")`: the guards and GitHub push protection scan the literal text.
- Telegram is off unless `MIKUD_TELEGRAM_BOT_TOKEN` and `MIKUD_TELEGRAM_CHAT_ID` are both set. Tests never reach the real Bot API: they start `StandInBotApi` (`src/server/testing/bot-api.ts`) and give its URL to `BotApi`. `TELEGRAM_API_URL` exists for the same purpose and stays empty in production. The token is part of every Bot API path: never log a URL, a fetch error's message or message text; log `TelegramError.code`.
- The morning message goes out at most once a day: its `job_runs` row is taken as `sending` before the send. Only a definite failure (`answer`, `not_sent`) becomes `failed` and is retried; anything else becomes `unknown` and is never resent. Do not add a resend path for `unknown`.
- Bot text goes through the same secret check as agent text: `checkAgentText` covers actor kinds `agent` and `bot`.
- Write bidirectional control characters in source as escapes (backslash, `u`, four hex digits), never as literal characters. Some editing tools turn the escapes into the characters; check new files before committing.
- UI text keys may not contain dots inside one segment: the lookup splits keys on `.`, so audit actions are keyed `item_update`, not `item.update`. Hebrew is allowed only in `he.json`: a language's name written in that language comes from `Intl.DisplayNames`, not from `en.json`.
- The production UI build defines `__MIKUD_MOCK__` as `false`, which drops `src/web/api/mock`; `web-dist-check.sh` fails when the mock's storage key `mikud.mock.` is in `dist/web`. Never import the mock any other way.
- `@playwright/test` in `package.json` and `PLAYWRIGHT_IMAGE` in `scripts/lib/common.sh` must name the same version; `verify.sh` refuses a mismatch.
- The verification stack's `MIKUD_PUBLIC_URL` is `http://127.0.0.1:8090`; the server refuses a browser change whose `Origin` differs. `e2e/global-setup.ts` forwards that address to the container (`E2E_TARGET`), so do not point the tests at `http://mikud:8080` directly.
- The UI formats dates only through `src/web/format/datetime.ts` (app time zone Asia/Jerusalem, the Date and Time Format settings); `guards.test.ts` fails on `toLocaleDateString`, `Intl.DateTimeFormat` and the like anywhere else. Every layer comes from `ui/Dialog.tsx` or a builder listed there with its reason.
- The guards scan tracked files and new files that are not ignored. The deny list `docs/private/deny-list.txt` exists only on the owner's machine; in CI the guard is skipped, and its output never repeats a matched line.

## Docker

- One image, `docker/mikud.Dockerfile`: esbuild bundle and migrations on `node:24.21.0-bookworm-slim`, `USER node`, no `node_modules`, health check `node dist/server/healthcheck.js` (calls `/healthz`, which runs `select 1`). State lives only in PostgreSQL; the container has no volume and runs with a read-only root file system, no capabilities and `no-new-privileges`.
- `docker-compose.yml` (production) runs only `mikud` from `ghcr.io/shlomiporush/mikud:${VERSION}` behind Traefik on the external `traefik` network, with no published port and no database; `DATABASE_URL` in `.env` points at the owner's PostgreSQL. Interpolation is limited to `VERSION` and `DOMAIN`.
- `docker/docker-compose-dev.example.yml` adds a `postgres` service with data in `${MIKUD_DATA_DIR}/postgres` (default `~/.local/share/mikud-dev`, on the WSL file system; the scripts refuse a path under `/mnt`). `mikud` binds to `127.0.0.1` only. `mikud` reads `docker/dev.env`, then the optional, ignored `.env.dev` at the repository root (Compose `env_file` with `required: false`), where a developer puts real tokens and the Telegram settings for a dry run. `scripts/verify.sh` sets `MIKUD_LOCAL_ENV_FILE=/dev/null` so it never reads `.env.dev`, and try-pr writes its own Compose file. Never read, copy or commit `.env.dev`. An existing `docker-compose-dev.yml` is a copy: copy the template again to get the change.
- Images are built only by the scripts; a guard fails on `build:` in a Compose file. Never stop or remove containers, networks or volumes of other projects.

## Repository policies

- The repository is public. Everything tracked is in English, except the Hebrew locale file `src/shared/locales/he.json`. Tests read Hebrew text from that file.
- Never commit environment-specific details: hostnames, IP addresses, bucket names, network details, tokens, real project names or real project data. They belong in the ignored `docs/private/` or in the server's `.env`. Fixtures and screenshots use invented projects.
- Store statuses, stages, types and severities as English codes; user-visible labels come from the locale files only.
- Keep the repository root minimal. Every root file is listed and justified in the foundation plan.
- Never commit `docs/private/`, `.env` or `docker-compose-dev.yml`. `docker/dev.env` holds only fake development values.
- Kanzo (AGPL) inspired the idea. Never copy its code.
- Commit email is the GitHub noreply address.

## Product rules that code must enforce

- Agents may not delete items or projects and may not change a stage (they propose one). Only the owner, in the UI, does that.
- Every write goes through the services layer and writes an audit row in the same transaction.
- Text written by agents and the Telegram bot is checked for secrets and refused with `secret_suspected`.
- The bot serves only the configured owner chat and never answers another chat.
- The server never calls T3 or GitHub. Their data arrives through the sync tool on the owner's PC.
- The sync never overrides the owner: see "Agent and sync rules" in the foundation plan.

## Out of scope for agents

- Production deployment is the owner's. Agents have no access to the production server; run Mikud only on the local development stack.
- No backup feature: the owner backs up the database with his own tools.
