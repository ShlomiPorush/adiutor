# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Repository foundation.** A TypeScript server on Node.js 24 that refuses to start without a database URL, a public URL and two different tokens of at least 32 characters each, applies its database migrations on start, and answers `/healthz` when the database answers.
- **Database schema** for projects, goals, items, linked T3 threads, suppressions, comments, stage proposals, security sources, sync and job runs, Telegram updates, visits, settings, devices and the audit log, with the codes and unique keys the product rules rely on.
- **Hebrew and English labels** for every stage, item status, item type and severity.
- **Container image and Compose files**: the image runs as `node` on a read-only root file system with no capabilities; a development stack with its own PostgreSQL; a production Compose file behind Traefik.
- **Workflow scripts and CI**: `scripts/local.sh` for the development stack, `scripts/verify.sh` with repository guards, lint, types, unit and database tests, and a container check; a CI workflow and weekly Dependabot updates.
