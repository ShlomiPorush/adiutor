# AGENTS.md

## Project

Mikud is a personal, single-user project-focus system: a morning board, a Telegram morning message and an MCP server that AI agents use to keep work items current. One application container with PostgreSQL, reachable only over the owner's private network.

**Stage: preparation.** Read these before any change:

- Product requirements: `docs/requirements.md`
- Foundation plan, decisions and status: `docs/project-foundation.md`

The foundation plan is the desired state. Items marked planned do not exist yet. Check the repository before assuming a file, command or feature exists.

UI follows the `v3-ui-style` skill.

## Repository policies

- The repository is public. Everything tracked is in English, except the Hebrew locale file `src/shared/locales/he.json`. Tests read Hebrew text from that file.
- Never commit environment-specific details: hostnames, IP addresses, bucket names, network details, tokens, real project names or real project data. They belong in the ignored `docs/private/` or in the server's `.env`. Fixtures and screenshots use invented projects.
- Store statuses, stages, types and severities as English codes; user-visible labels come from the locale files only.
- Keep the repository root minimal. Every root file is listed and justified in the foundation plan.
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
