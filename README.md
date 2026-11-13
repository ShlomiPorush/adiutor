# Adiutor

Adiutor (Hebrew for "focus") is a planned personal system that shows one person what needs him across all of his projects: an overview board, a Telegram morning message, and an MCP server that AI agents use to keep work items up to date.

**Status: foundation.** The repository has the server (API, MCP tools, Telegram bot and morning message), the web board, the sync tool, the container image, the workflow scripts and CI. None of it has run in production yet; the first launch starts production with a new database (requirements section 9).

- Requirements: [docs/requirements.md](docs/requirements.md)
- Foundation plan and status: [docs/project-foundation.md](docs/project-foundation.md)
- The agent skill, which agents load to keep Adiutor current: [skill/adiutor/SKILL.md](skill/adiutor/SKILL.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)

## Development

Run inside WSL with Docker; the host needs nothing else.

```bash
cp docker/docker-compose-dev.example.yml docker-compose-dev.yml
scripts/local.sh start    # http://127.0.0.1:8090/healthz; generates its password and keys once
scripts/verify.sh         # everything CI runs
```

## License

MIT. See [LICENSE](LICENSE).
