# Mikud

Mikud (Hebrew for "focus") is a planned personal system that shows one person what needs him across all of his projects: a morning board, a Telegram morning message, and an MCP server that AI agents use to keep work items up to date.

**Status: foundation.** The repository has the server skeleton, the database schema, the container image, the workflow scripts and CI. The product features (API, MCP tools, board, Telegram) are not built yet.

- Requirements: [docs/requirements.md](docs/requirements.md)
- Foundation plan and status: [docs/project-foundation.md](docs/project-foundation.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)

## Development

Run inside WSL with Docker; the host needs nothing else.

```bash
cp docker/docker-compose-dev.example.yml docker-compose-dev.yml
scripts/local.sh start    # http://127.0.0.1:8090/healthz
scripts/verify.sh         # everything CI runs
```

## License

MIT. See [LICENSE](LICENSE).
