# Agent instruction (proposal)

Status: **proposal awaiting the owner.** It is not in the shared agent configuration. The owner adds it after the launch checks (requirements section 9).

Agents use Adiutor through the `adiutor` skill ([skill/adiutor/SKILL.md](../skill/adiutor/SKILL.md)): when, how and what to write in Adiutor, the rules (top-level T3 threads only, thread start, end of work, quick capture, notes, never secrets, deletes or stage changes) and every call, each MCP tool next to its command. The skill uses the `adiutor` MCP tools when a session has them, and otherwise its own `adiutor` command, never both for one action. The shared agent configuration installs the skill for Claude Code and Codex from `skill/adiutor` (its `skills.manifest.json`).

## The always-on line

A skill does not load by itself when a thread starts, so the shared agent configuration needs one line. It goes into the shared instructions only after the owner approves the launch (requirements section 9, step 4):

```markdown
At the start of every top-level T3 thread, load the `adiutor` skill and follow it. If it is not installed, continue and say so once.
```

Installed without this line, the skill runs only when the owner asks for Adiutor.

## Connecting to Adiutor

The skill and the MCP clients connect by agent access by approval: each asks once, the owner approves it in the browser and chooses its areas, and Adiutor keeps the connection until the owner disconnects it in Settings, Agent access, or it goes unused for the idle days ([api.md](api.md), "Agent access by approval"). The clients on `main` work against the agent access release only: an Adiutor before it has no authorization server, and they cannot connect to it.

**The skill's command.** `adiutor connect` (in the skill's `scripts/` folder) prints a link and a code; the owner approves, and `adiutor connect --wait --url "<address>"` keeps the connection in `~/.adiutor/`, one file per Adiutor address, readable by the computer user only and shared by every agent install of that user. It is named `Agents on <computer>` (or `ADIUTOR_AGENT_NAME`) and reads and writes as the owner chose. SKILL.md, "Connecting (once)", has the steps an agent follows. Adiutor also serves the skill at `<address>/agents/skill/` with its address filled in; a copy from Git, as the shared agent configuration installs it, connects with `--url` once and keeps the address.

**The MCP server**, when a client should have the tools itself. Claude Code and Codex use the MCP Streamable HTTP transport at `<address>/mcp` and sign in with OAuth themselves; the owner approves each once. `setup-mcp` of the sync bundle sets them up and replaces a setup with a key that the old `connect --for claude|codex` wrote ([sync.md](sync.md), "Setting up Claude Code and Codex"). Replace the example URL with the owner's Adiutor address.

Claude Code: `node dist/sync/adiutor-sync.js setup-mcp --for claude --url https://adiutor.example.com` in the Adiutor checkout replaces the `adiutor` entry of the user scope with this one, and Claude Code signs in the first time it uses Adiutor (or through `/mcp` in Claude Code):

```
claude mcp add --transport http --scope user adiutor "https://adiutor.example.com/mcp"
```

Codex: `... setup-mcp --for codex --url https://adiutor.example.com` reads `codex mcp list --json` and replaces an old entry with `codex mcp add adiutor --url "https://adiutor.example.com/mcp"`, which signs in at once, or signs in an entry whose sign-in was cancelled with `codex mcp login adiutor`. `~/.codex/config.toml` then holds no key:

```toml
[mcp_servers.adiutor]
url = "https://adiutor.example.com/mcp"
```
