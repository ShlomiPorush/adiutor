# Agent instruction (proposal)

Status: **proposal awaiting the owner.** It is not in the shared agent configuration. The owner adds it after the launch checks (requirements section 9).

Agents use Mikud through the `mikud` skill ([skill/mikud/SKILL.md](../skill/mikud/SKILL.md)): when, how and what to write in Mikud, the rules (top-level T3 threads only, thread start, end of work, quick capture, notes, never secrets, deletes or stage changes) and every call, each MCP tool next to its command. The skill uses the `mikud` MCP tools when a session has them, and otherwise its own `mikud` command, never both for one action. The shared agent configuration installs the skill for Claude Code and Codex from `skill/mikud` (its `skills.manifest.json`).

## The always-on line

A skill does not load by itself when a thread starts, so the shared agent configuration needs one line. It goes into the shared instructions only after the owner approves the launch (requirements section 9, step 4):

```markdown
At the start of every top-level T3 thread, load the `mikud` skill and follow it. If it is not installed, continue and say so once.
```

Installed without this line, the skill runs only when the owner asks for Mikud.

## Connecting to Mikud

Each way of connecting gets an agent key of its own from the owner's approval in the browser (`/connect/device`). A key ends after its days (default 90) or when the owner disconnects it in Settings, Agent access.

**The skill's command.** `mikud connect` (in the skill's `scripts/` folder) prints a link and a code; the owner approves, and `mikud connect --wait --url <address>` saves one key, named `skill:<computer>:<8 hex digits>`, in `~/.mikud/`, readable by the computer user only and shared by every agent install of that user. SKILL.md, "Connecting (once)", has the steps an agent follows.

**The MCP server**, when a client should have the tools itself. Both clients use the MCP Streamable HTTP transport with a key of their own, from `mikud connect` of the sync bundle ([sync.md](sync.md)). Replace the example URL with the owner's Mikud address.

Claude Code: run `node dist/sync/mikud-sync.js connect --url https://mikud.example.com --name claude --for claude` in the Mikud checkout. After the approval it runs this itself, replacing an older `mikud` entry at user scope:

```
claude mcp add --transport http --scope user mikud https://mikud.example.com/mcp --header "Authorization: Bearer <key>"
```

Codex: run `... connect --url https://mikud.example.com --name codex --for codex`. It sets `MIKUD_AGENT_KEY` for the Windows user with `setx` (elsewhere in `~/.config/mikud/codex.env`, with the line to add to the shell profile), then runs `codex mcp add mikud --url https://mikud.example.com/mcp --bearer-token-env-var MIKUD_AGENT_KEY`, which writes these lines to `~/.codex/config.toml`. Restart Codex from a new terminal afterwards.

```toml
[mcp_servers.mikud]
url = "https://mikud.example.com/mcp"
bearer_token_env_var = "MIKUD_AGENT_KEY"
```

When `claude` or `codex` is missing or fails, the command prints the same setup once instead. Each agent gets its own key, which ends after `--days` (default 90) or when the owner disconnects it in Settings, Agent access. A printed command can stay in the shell history.
