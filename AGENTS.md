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

- `src/server/`: Hono server. `index.ts` starts it, `config.ts` reads and checks the environment, `app.ts` mounts `/healthz`, `/api/v1` and `/mcp` and maps errors, `healthcheck.ts` is the container health check, `errors.ts` holds the stable error codes, `db/` the Drizzle schema and client.
  - `services/`: every write and read model. `context.ts` (actor, audit row, agent secret check), `items.ts`, `projects.ts`, `threads.ts` (start of thread), `sync.ts` and `sync-rules.ts` (T3 and security snapshots), `reads.ts` (morning, project, item, archive, inbox, audit), `admin.ts` (settings, suppressions, devices, visits), `secrets.ts`.
  - `http/`: `auth.ts` (bearer token, device cookie, CSRF check, rate limit) and `api.ts` (the `/api/v1` routes). `mcp/server.ts`: the MCP tools.
  - `testing/db.ts`: a migrated database per integration test file, and a movable clock.
- `src/shared/`: enum codes as `const` arrays with zod schemas (`enums.ts`), the API request schemas (`api.ts`) and the locale files `locales/en.json` and `locales/he.json`.
- `drizzle/`: generated SQL migrations and their snapshots. Never edit by hand.
- `config/`: TypeScript base config, Vitest configs, Drizzle Kit config.
- `docker/`: toolchain and application Dockerfiles, the development Compose template and `dev.env` (fake development values).
- `scripts/`: `local.sh`, `verify.sh`, `try-pr.sh`, `release.sh` and its tests `test-release.sh`; `lib/common.sh` (shared helpers), `lib/guards.sh` (repository guards) and `lib/try-pr-seed.mjs` (invented fixtures for `try-pr.sh`).
- `src/sync/`: the sync tool that runs on the owner's PC, bundled to `dist/sync/mikud-sync.js` (Node stdlib only at runtime; no imports from `src/server/`). `main.ts` is the entry, `run.ts` one run, `fixtures/` invented T3 and `overview` data for its tests. See `docs/sync.md`.
- `prompts/`: `reconcile.md`, the instructions of the T3 scheduled task that runs the sync tool.
- `docs/api.md`: the HTTP API and MCP contract. Change it together with the routes.
- `docs/deployment.md`: the owner's deployment notes. `.github/workflows/`: `ci.yml` and `release.yml`.
- `src/web/`, `e2e/`: planned, not created yet.

## Commands

Run every script inside WSL from the repository. Node, pnpm, shellcheck and shfmt run in the toolchain container; the host needs Docker only.

- `scripts/verify.sh`: guards, Biome, types, unit tests, build, schema-versus-migration check, database tests against a disposable PostgreSQL (`mikud-verify`), then the image with health, UID and hardening checks. `--guards-only` for the guards alone; `--changed [BASE]` runs guards only when every change is documentation; `--skip-e2e` is accepted (no end-to-end tests yet).
- `scripts/local.sh build|up|start|down|status|logs|nuke`: the development stack (`mikud-dev`) from the ignored `docker-compose-dev.yml`. Create it once with `cp docker/docker-compose-dev.example.yml docker-compose-dev.yml`. Serves `http://127.0.0.1:8090`; `MIKUD_PORT` changes the port.
- `scripts/try-pr.sh <number>|status|restore`: runs a pull request's head as the separate Compose project `mikud-pr` (own PostgreSQL, generated tokens in a 0600 file under `~/.cache/mikud/try-pr`, Telegram off, invented fixtures) on `http://127.0.0.1:8091`; `MIKUD_PR_PORT` changes the port. Never touches `mikud-dev`. `restore` removes the stack, its data, image and worktree.
- `scripts/release.sh --target ghcr --bump <patch|minor|major> [--dry-run]`: run by the manual Release workflow on `main`; never by agents except `--dry-run`. `scripts/test-release.sh` tests it offline and runs with the guards.
- A single tool in the toolchain: `source scripts/lib/common.sh && build_toolchain && in_toolchain "pnpm test"`.
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
- The guards scan tracked files and new files that are not ignored. The deny list `docs/private/deny-list.txt` exists only on the owner's machine; in CI the guard is skipped, and its output never repeats a matched line.

## Docker

- One image, `docker/mikud.Dockerfile`: esbuild bundle and migrations on `node:24.21.0-bookworm-slim`, `USER node`, no `node_modules`, health check `node dist/server/healthcheck.js` (calls `/healthz`, which runs `select 1`). State lives only in PostgreSQL; the container has no volume and runs with a read-only root file system, no capabilities and `no-new-privileges`.
- `docker-compose.yml` (production) runs only `mikud` from `ghcr.io/shlomiporush/mikud:${VERSION}` behind Traefik on the external `traefik` network, with no published port and no database; `DATABASE_URL` in `.env` points at the owner's PostgreSQL. Interpolation is limited to `VERSION` and `DOMAIN`.
- `docker/docker-compose-dev.example.yml` adds a `postgres` service with data in `${MIKUD_DATA_DIR}/postgres` (default `~/.local/share/mikud-dev`, on the WSL file system; the scripts refuse a path under `/mnt`). `mikud` binds to `127.0.0.1` only.
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
- Text written by agents is checked for secrets and refused with `secret_suspected`.
- The server never calls T3 or GitHub. Their data arrives through the sync tool on the owner's PC.
- The sync never overrides the owner: see "Agent and sync rules" in the foundation plan.

## Out of scope for agents

- Production deployment is the owner's. Agents have no access to the production server; run Mikud only on the local development stack.
- No backup feature: the owner backs up the database with his own tools.
