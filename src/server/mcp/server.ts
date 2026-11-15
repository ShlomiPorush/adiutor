import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Hono } from "hono"
import { z } from "zod"
import { LIMITS, uuidSchema } from "../../shared/api.ts"
import {
  type AgentArea,
  actorKindSchema,
  ITEM_STATUSES,
  itemStatusSchema,
  itemTypeSchema,
  STAGES,
  severitySchema,
  stageSchema,
} from "../../shared/enums.ts"
import { type AgentChannel, agentErrorBody, REFUSALS, withoutPeoplesCredentials } from "../agents/channel.ts"
import { DATA_SENTENCE, mayCall, NEVER, TOOLS } from "../agents/policy.ts"
import { AppError, errorBody, forbidden } from "../errors.ts"
import { type AuthDeps, agentLabel, authenticate, type Env } from "../http/auth.ts"
import type { By, Ctx } from "../services/context.ts"
import { addComment, captureItem, createItem, linkThread, updateItem } from "../services/items.ts"
import { createNote, findNotes, NOTE_SORTS, noteDetail, updateNote } from "../services/notes.ts"
import { proposeStage, updateProject } from "../services/projects.ts"
import { findItems, itemDetail, listProjects } from "../services/reads.ts"
import { startThread } from "../services/threads.ts"

export { DATA_SENTENCE }

/** Read by MCP clients once; the tool descriptions carry the details. */
const INSTRUCTIONS = `Adiutor is the owner's project-focus board. Keep the item of your T3 thread current.
At thread start call adiutor_start_thread once. At the end leave one short summary with adiutor_comment and set the status with adiutor_update_item.
Statuses: ${ITEM_STATUSES.join(", ")}. Use waiting_on_you only when the owner must act (a decision, a manual test, a merge approval).
Never write secrets or server details: no tokens, passwords, keys, host names or IP addresses. Such text is refused with secret_suspected.
You cannot delete items or projects, and you cannot change a stage: propose one with adiutor_propose_stage.
Notes keep knowledge worth finding again (decisions, explanations, findings, how things work): find one with adiutor_find_notes before you write, and update it rather than writing a second one. Work to do is an item, not a note. You cannot delete notes.
Subagent and review threads (those with a parent thread) must not call Adiutor.
${DATA_SENTENCE}`

/** The instructions for an agent connected by approval (the agent-access standard, "The MCP channel"). */
export const AGENT_INSTRUCTIONS = `Adiutor is the owner's project-focus board: projects with their stage, current goal and where the work stands; items (tasks, bugs, decisions, security findings, ideas) with their status, comments and linked T3 threads; and notes that keep knowledge worth finding again.
This connection acts for the owner, within the areas the owner granted it. Call get_access first: it says what this connection may do and when it ends.
Keep the item of your T3 thread current: at thread start call adiutor_start_thread once; at the end leave one short summary with adiutor_comment and set the status with adiutor_update_item. Statuses: ${ITEM_STATUSES.join(", ")}. Use waiting_on_you only when the owner must act (a decision, a manual test, a merge approval).
Notes keep knowledge worth finding again: find one with adiutor_find_notes before you write, and update it rather than writing a second one. Work to do is an item, not a note.
Subagent and review threads (those with a parent thread) must not call Adiutor.
Agents never: ${NEVER.join(" ")}
${DATA_SENTENCE}
When an action's outcome is unknown, read its result before trying again.`

const id = uuidSchema
const threadId = z.string().trim().min(1).max(200)

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

function json(value: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }
}

/** Runs one tool call of an agent connected by approval under the policy core and the limits (agents/channel.ts). */
export type ToolGuard = (tool: string, run: () => Promise<ToolResult>) => Promise<ToolResult>

/**
 * An agent connected by approval: only the tools of its areas are listed and registered (TOOLS in agents/policy.ts),
 * each runs through `guard`, errors take the agent contract's flat shape, and `get_access` says what it may do.
 */
export type AgentMode = { areas: readonly AgentArea[]; guard: ToolGuard; getAccess: () => Promise<unknown> }

/** One stateless MCP server per request, acting as `by`; with `agent`, for an agent connected by approval. */
export function buildMcpServer(ctx: Ctx, by: By, version: string, agent?: AgentMode): McpServer {
  const server = new McpServer(
    { name: "adiutor", version },
    { instructions: agent ? AGENT_INSTRUCTIONS : INSTRUCTIONS },
  )
  // Arguments are validated by the SDK against inputSchema before run() is called.
  // biome-ignore lint/suspicious/noExplicitAny: tool arguments are typed by each tool's zod schema
  type Args = Record<string, any>
  const tool = (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    readOnly: boolean,
    run: (args: Args) => Promise<unknown>,
  ) => {
    const rule = TOOLS[name]
    // A tool of an area the connection was not granted is neither listed nor callable; one not in TOOLS is closed.
    if (agent && !(rule && mayCall(agent.areas, rule.area))) return
    const once = async (args: Args): Promise<ToolResult> => {
      try {
        return json({ data: await run(args) })
      } catch (error) {
        if (error instanceof AppError)
          return { ...json(agent ? agentErrorBody(error) : errorBody(error)), isError: true }
        throw error
      }
    }
    server.registerTool(
      name,
      {
        description: `${description} ${DATA_SENTENCE}`,
        inputSchema,
        annotations: {
          readOnlyHint: agent && rule ? rule.kind === "read" : readOnly,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      (async (args: Args) => (agent ? agent.guard(name, () => once(args)) : once(args))) as never,
    )
  }

  if (agent)
    server.registerTool(
      "get_access",
      {
        description: `What this connection may do: whose account it acts for, its name, the areas granted and not granted, what agents never do in Adiutor, when the connection ends, and Adiutor's version. Call it first. ${DATA_SENTENCE}`,
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      (async () => agent.guard("get_access", async () => json(await agent.getAccess()))) as never,
    )

  tool(
    "adiutor_start_thread",
    "Call once at the start of a top-level T3 thread. Finds the item linked to threadId, or links itemId, or creates a task item, and sets it in_progress. Calling it again returns the same item. parentThreadId: your thread's parent from T3 (null for a top-level thread); when set, the call is refused with not_top_level and you must not call Adiutor again. projectId (Adiutor) or t3ProjectId picks the project; with neither, the item goes to the inbox. Refused with suppressed when the owner deleted this thread's item.",
    {
      threadId,
      parentThreadId: threadId.nullable(),
      title: z.string().max(LIMITS.title).describe("Short title of the work, from the thread"),
      projectId: id.optional(),
      t3ProjectId: threadId.optional(),
      itemId: id.optional().describe("An existing item to link instead of creating one"),
    },
    false,
    (a) => startThread(ctx, by, a as never),
  )
  tool(
    "adiutor_find_items",
    "Search items by text in title and body, project, status, type or linked T3 thread. Open items only unless includeClosed or status is given. Returns summaries with id and version.",
    {
      query: z.string().max(200).optional(),
      projectId: id.optional(),
      inbox: z.boolean().optional().describe("Only items without a project"),
      status: z.array(itemStatusSchema).optional(),
      type: itemTypeSchema.optional(),
      threadId: threadId.optional(),
      includeClosed: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    true,
    (a) => findItems(ctx, { ...a, q: a.query }),
  )
  tool(
    "adiutor_get_item",
    "One item with its project, goal, linked threads, comments and change history. Read it before adiutor_update_item: the update needs its current version.",
    { itemId: id },
    true,
    (a) => itemDetail(ctx, a.itemId),
  )
  tool(
    "adiutor_create_item",
    `Create an item. type: bug, decision, security, task or idea. status defaults to todo. severity (critical, high, medium, low) only for type security. Without projectId the item goes to the inbox. goalId must be a goal of the same project.`,
    {
      type: itemTypeSchema,
      title: z.string().max(LIMITS.title),
      body: z.string().max(LIMITS.body).optional(),
      status: itemStatusSchema.optional(),
      severity: severitySchema.optional(),
      projectId: id.optional(),
      goalId: id.optional(),
    },
    false,
    (a) => createItem(ctx, by, a as never),
  )
  tool(
    "adiutor_update_item",
    `Change an item. version is the version you read (adiutor_get_item or adiutor_find_items); a stale one is refused with version_conflict: read again and retry. status: ${ITEM_STATUSES.join(", ")}. Set waiting_on_you only when the owner must act; done or not_relevant closes the item. You cannot delete items.`,
    {
      itemId: id,
      version: z.number().int().min(1),
      title: z.string().max(LIMITS.title).optional(),
      body: z.string().max(LIMITS.body).optional(),
      status: itemStatusSchema.optional(),
      type: itemTypeSchema.optional(),
      severity: severitySchema.nullable().optional(),
      projectId: id.nullable().optional(),
      goalId: id.nullable().optional(),
    },
    false,
    ({ itemId, version, ...patch }) => updateItem(ctx, by, itemId, version, patch),
  )
  tool(
    "adiutor_comment",
    "Add a comment to an item. At the end of a thread leave one short summary: what was done, what is left, what the owner must do. threadId: your T3 thread.",
    { itemId: id, text: z.string().max(LIMITS.comment), threadId: threadId.optional() },
    false,
    (a) => addComment(ctx, by, a.itemId, { text: a.text, threadId: a.threadId }),
  )
  tool(
    "adiutor_capture",
    'Quick capture of an idea for later ("note an idea for project X"): an idea item with status future, in the project or else in the inbox. The first line becomes the title. Knowledge to keep goes in a note (adiutor_create_note), not here.',
    { text: z.string().max(LIMITS.body), projectId: id.optional() },
    false,
    (a) => captureItem(ctx, by, a as never),
  )
  tool(
    "adiutor_find_notes",
    "Search notes by text in title and body, by project (projectId), only notes without a project (general), or by who created them (createdBy: owner, agent, bot). sort: updated (newest change first, the default) or title. Returns summaries with id, version and the start of the body, and nextCursor for the next page (pass it back with the same filters).",
    {
      query: z.string().max(200).optional(),
      projectId: id.optional(),
      general: z.boolean().optional(),
      createdBy: actorKindSchema.optional(),
      sort: z.enum(NOTE_SORTS).optional(),
      cursor: z.string().max(LIMITS.noteCursor).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    true,
    (a) => findNotes(ctx, { ...a, q: a.query }),
  )
  tool(
    "adiutor_get_note",
    "One note with its whole Markdown body, its version and its project. Read it before adiutor_update_note: the update needs its current version.",
    { noteId: id },
    true,
    (a) => noteDetail(ctx, a.noteId),
  )
  tool(
    "adiutor_create_note",
    `Create a note: knowledge worth finding again. body is Markdown (up to ${LIMITS.noteBody} characters). Without projectId it is a general note. Look for an existing note with adiutor_find_notes first.`,
    {
      title: z.string().max(LIMITS.noteTitle),
      body: z.string().max(LIMITS.noteBody).optional(),
      projectId: id.optional(),
    },
    false,
    (a) => createNote(ctx, by, a as never),
  )
  tool(
    "adiutor_update_note",
    "Change a note, the owner's included: send the whole new title or body, not a diff. version is the version you read (adiutor_get_note); a stale one is refused with version_conflict: read again, merge, retry. Every change is kept as a version the owner can restore. projectId moves the note (null: a general note). You cannot delete notes.",
    {
      noteId: id,
      version: z.number().int().min(1),
      title: z.string().max(LIMITS.noteTitle).optional(),
      body: z.string().max(LIMITS.noteBody).optional(),
      projectId: id.nullable().optional(),
    },
    false,
    ({ noteId, version, ...patch }) => updateNote(ctx, by, noteId, version, patch),
  )
  tool(
    "adiutor_link_thread",
    "Link another top-level T3 thread to an item (an item may have several threads). parentThreadId as in adiutor_start_thread: a child thread is refused with not_top_level. A thread linked to another item is refused with conflict.",
    {
      itemId: id,
      threadId,
      parentThreadId: threadId.nullable(),
      t3ProjectId: threadId.optional(),
      title: z.string().max(LIMITS.title).optional(),
    },
    false,
    ({ itemId, ...link }) => linkThread(ctx, by, itemId, link as never),
  )
  tool(
    "adiutor_list_projects",
    `Every project with id, name, t3ProjectId, githubRepo, stage (${STAGES.join(", ")} or null when unset), current goal with progress (done/total), whereWeAre and open item count.`,
    {},
    true,
    () => listProjects(ctx),
  )
  tool(
    "adiutor_update_project",
    "Set a project's whereWeAre (one line: where the work stands) and/or its current goal (the near goal; a new text closes the previous goal, null closes it). Nothing else of a project can be changed by agents; for a stage use adiutor_propose_stage.",
    {
      projectId: id,
      whereWeAre: z.string().max(LIMITS.whereWeAre).nullable().optional(),
      goal: z.string().max(LIMITS.goal).nullable().optional(),
    },
    false,
    (a) => updateProject(ctx, by, a.projectId, { whereWeAre: a.whereWeAre, goal: a.goal }),
  )
  tool(
    "adiutor_propose_stage",
    `Propose a stage for a project (${STAGES.join(", ")}) with a short reason. Only the owner changes a stage; the proposal waits for the owner in the morning view.`,
    { projectId: id, stage: stageSchema, reason: z.string().max(LIMITS.reason) },
    false,
    (a) => proposeStage(ctx, by, a.projectId, { stage: a.stage, reason: a.reason }),
  )
  return server
}

/** The largest JSON-RPC body /mcp reads: the same bound as the REST API's ordinary routes. */
export const MCP_BODY_LIMIT = 512 * 1024

/**
 * MCP over Streamable HTTP at /mcp, stateless, with an agent key as a bearer token; with `agents` (agent access
 * mounted), with an access token for `<issuer>/mcp` instead, through the agent channel's policy core.
 */
export function mcpRoutes(deps: AuthDeps & { version: string }, agents?: AgentChannel) {
  const app = new Hono<Env>()
  // DNS rebinding protection, as the MCP transport specification asks: a browser page on another origin is refused
  // before anything else. A request without Origin (a CLI or desktop client) passes. The SDK's own origin options are
  // deprecated in favour of middleware.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin")
    if (origin !== undefined && origin !== deps.config.publicUrl.origin)
      throw forbidden("Requests to /mcp from another site are refused.")
    await next()
  })
  if (agents) return agentMcpRoutes(app, deps, agents)
  app.use("*", authenticate(deps, { allowSession: false }))
  app.all("/", async (c) => {
    const by: By = { actor: c.get("auth").actor, source: "mcp" }
    const server = buildMcpServer(deps.ctx, by, deps.version)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MCP_BODY_LIMIT,
    })
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  })
  return app
}

type AgentMcpEnv = { Variables: Env["Variables"] & { agentToken: AgentToken } }
type AgentToken = Exclude<Awaited<ReturnType<AgentChannel["authenticate"]>>, { refusal: Response }>

/**
 * /mcp for agents connected by approval. The MCP TypeScript SDK's bearer middleware (`requireBearerAuth`) is written for
 * Express; on Hono the token is checked here with agent access's per-call check, bound to `<issuer>/mcp`, answering 401
 * with the protected resource metadata, and handed to the SDK as its documented `AuthInfo` (`handleRequest`'s
 * `authInfo`). Every request is an agent's: the owner's cookie and any key header are removed before the SDK sees it.
 */
function agentMcpRoutes(app: Hono<Env>, deps: AuthDeps & { version: string }, agents: AgentChannel) {
  const mcp = app as unknown as Hono<AgentMcpEnv>
  // The token first, for every address under /mcp.
  mcp.use("*", async (c, next) => {
    const found = await agents.authenticate(c, "mcp")
    if ("refusal" in found) return found.refusal
    c.set("agentToken", found)
    await next()
  })
  mcp.all("/", async (c) => {
    const found = c.get("agentToken")
    const { connection, areas } = found.check
    const by: By = { actor: { kind: "agent", label: agentLabel(c, connection.name) }, source: "mcp" }
    const server = buildMcpServer(deps.ctx, by, deps.version, {
      areas,
      guard: agents.toolGuard(found, by),
      getAccess: () => agents.accessAnswer(found.check, "mcp"),
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: agents.limits.bodyBytes.default,
    })
    await server.connect(transport)
    return transport.handleRequest(withoutPeoplesCredentials(c.req.raw), {
      authInfo: {
        token: found.token,
        clientId: found.check.clientId,
        scopes: [...areas],
        expiresAt: found.check.expiresAt,
        resource: new URL(`${agents.issuer}/mcp`),
        extra: { connectionId: connection.id },
      },
    })
  })
  // Any other address under /mcp is closed to agents.
  mcp.all("*", (c) => c.json(REFUSALS.closed, 403))
  return app
}
