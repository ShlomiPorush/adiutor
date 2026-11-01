# Agent instruction (proposal)

Status: **proposal awaiting the owner.** It is not in the shared agent configuration. The owner adds it after the dry run (requirements section 9). The tool names match the planned MCP server (implementation row 6); check them against the server's tool list before adopting this text.

The section "Instruction text" is what goes into the shared agent configuration. The section "Connecting to Mikud" is set up once per machine.

## Instruction text

```markdown
## Mikud

Mikud is the owner's board of work items. Keep it current from T3 threads through the `mikud` MCP tools.

**When this applies.** Only in a top-level T3 thread, in any project. A thread that has a parent thread (a subagent, a delegated task or a partner review) does nothing with Mikud. Outside T3, or when you cannot get your thread id, skip Mikud.

**Thread id.** Claude: the `T3CODE_THREAD_ID` environment variable. Other agents: `currentThreadId` from the T3 MCP tool `t3_thread_list`. Take your `parentThreadId` from T3 as well (`orchestrator_capabilities` or your own thread in `t3_thread_list`); when it is set, stop here.

**At thread start**, before other work, call `mikud_start_thread` once with:
- `threadId` and `parentThreadId`;
- `projectId`: the T3 project id of this thread;
- `title`: what the work is, in at most 80 characters, in the conversation's language;
- `itemId`: only when the user names an existing Mikud item (its id or link). Otherwise Mikud finds the item linked to this thread or creates one.

It sets the item to `in_progress`. Remember the item id it returns.

**At the end of the work** (the task is finished, or it now waits on the owner):
1. `mikud_comment` on the item: a summary in 1 to 3 lines, in the conversation's language. What changed and what is left.
2. `mikud_update_item` to the right status:
   - `done`: the work is finished.
   - `waiting_on_you`: only when the owner must act: a decision, a manual test, or approval of a merge.
   - `not_relevant`: the owner dropped the work.
   - Leave `in_progress` when you stopped midway and work will continue.

**Quick capture.** When the user asks to note something for later ("note an idea for X"), call `mikud_capture` with the text and, if named, the project. Without a project it goes to the inbox.

**Never:**
- Write secrets or environment details into Mikud: no tokens, passwords, keys, host names, IP addresses or server details. If Mikud refuses text with `secret_suspected`, rewrite it without the detail.
- Delete anything. There is no tool for it; deleting belongs to the owner.
- Change a project's stage. Propose one with `mikud_propose_stage` and a one-line reason.

**If Mikud is unreachable or fails**, continue the work, mention it once in your reply, and do not retry in a loop.
```

## Connecting to Mikud

Both clients use the MCP Streamable HTTP transport and read the agent token from the `MIKUD_AGENT_TOKEN` environment variable, so the token never appears in a configuration file. Replace the example URL with the owner's Mikud address.

Claude Code (user scope, `~/.claude.json`, or a `.mcp.json`):

```json
{
  "mcpServers": {
    "mikud": {
      "type": "http",
      "url": "https://mikud.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MIKUD_AGENT_TOKEN}" }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.mikud]
url = "https://mikud.example.com/mcp"
bearer_token_env_var = "MIKUD_AGENT_TOKEN"
```

Give agents only the agent token, never the owner token.
