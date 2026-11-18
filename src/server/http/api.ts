import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import {
  auditFilterSchema,
  captureBody,
  commentBody,
  createItemBody,
  createNoteBody,
  createProjectBody,
  decideProposalBody,
  LIMITS,
  linkThreadBody,
  morningQuery,
  proposeStageBody,
  restoreNoteBody,
  settingsBody,
  startThreadBody,
  syncCheckinBody,
  t3SnapshotBody,
  updateItemBody,
  updateNoteBody,
  updateProjectBody,
  uuidSchema,
  visitBody,
} from "../../shared/api.ts"
import { actorKindSchema, itemStatusSchema, itemTypeSchema } from "../../shared/enums.ts"
import { forbidden, invalid, notFound } from "../errors.ts"
import { sendTestMorningMessage } from "../jobs/morning.ts"
import {
  getSettings,
  listSuppressions,
  previousVisit,
  recordVisit,
  removeSuppression,
  type SettingsEnv,
  type SettingsRow,
  settingsView,
  updateSettings,
} from "../services/admin.ts"
import type { Ctx } from "../services/context.ts"
import { addComment, captureItem, createItem, deleteItem, linkThread, updateItem } from "../services/items.ts"
import {
  createNote,
  deleteNote,
  findNotes,
  getNoteVersion,
  listNoteVersions,
  NOTE_ORDERS,
  NOTE_SORTS,
  noteDetail,
  restoreNote,
  updateNote,
} from "../services/notes.ts"
import { createProject, decideProposal, deleteProject, proposeStage, updateProject } from "../services/projects.ts"
import {
  archive,
  auditLog,
  findItems,
  inbox,
  itemDetail,
  listProjects,
  morning,
  projectDetail,
} from "../services/reads.ts"
import { applyT3Snapshot, recentSyncRuns } from "../services/sync.ts"
import { cancelSyncRequest, checkIn, requestSync, syncRequestsView } from "../services/sync-requests.ts"
import { startThread } from "../services/threads.ts"
import { TELEGRAM_OFF, type TelegramRuntime, telegramStatus } from "../telegram/status.ts"
import { type AuthDeps, authenticate, byOf, type Env, requireOwnerAuth } from "./auth.ts"
import { type GitHubHandle, githubRoutes } from "./github.ts"

/** The settings that hold secrets or may be set by the environment, and how a save takes effect without a restart. */
export type SettingsHandle = { env: SettingsEnv; apply(row: SettingsRow): Promise<void> }

/** Parses and validates a JSON body; anything else is `validation_failed` with the issues. */
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw invalid("The request body must be JSON.")
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success)
    throw invalid("The request body is not valid.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    })
  return parsed.data
}

function query<T>(c: Context, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(flatQuery(c))
  if (!parsed.success)
    throw invalid("The query is not valid.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    })
  return parsed.data
}

/** Single query values as strings; `status` may repeat or be comma-separated. */
function flatQuery(c: Context): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, values] of Object.entries(c.req.queries())) {
    out[key] = key === "status" ? values.flatMap((v) => v.split(",")).filter(Boolean) : (values[0] ?? "")
  }
  return out
}

/** A path id that is not a UUID cannot name anything: `not_found`. In lower case, as the database writes it. */
function idParam(c: Context, name = "id"): string {
  const parsed = uuidSchema.safeParse(c.req.param(name) ?? "")
  if (!parsed.success) throw notFound("The resource")
  return parsed.data
}

const bool = z.enum(["true", "false"]).transform((v) => v === "true")
const limit = z.coerce.number().int().min(1).max(200).optional()

const findItemsQuery = z.object({
  q: z.string().max(200).optional(),
  projectId: uuidSchema.optional(),
  inbox: bool.optional(),
  status: z.array(itemStatusSchema).optional(),
  type: itemTypeSchema.optional(),
  threadId: z.string().max(200).optional(),
  includeClosed: bool.optional(),
  limit,
})
const archiveQuery = z.object({ projectId: uuidSchema.optional(), cursor: z.string().max(500).optional(), limit })
/** The activity filters (shared with the page's address) and the entity filters that came before them. */
const auditQuery = auditFilterSchema.extend({
  cursor: z.string().max(500).optional(),
  limit,
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(200).optional(),
})
const versionQuery = z.object({ version: z.coerce.number().int().min(1).optional() })
const findNotesQuery = z.object({
  q: z.string().max(200).optional(),
  projectId: uuidSchema.optional(),
  general: bool.optional(),
  createdBy: actorKindSchema.optional(),
  sort: z.enum(NOTE_SORTS).optional(),
  order: z.enum(NOTE_ORDERS).optional(),
  cursor: z.string().max(LIMITS.noteCursor).optional(),
  limit,
})
const pageQuery = z.object({ cursor: z.string().max(500).optional(), limit })
/** Deleting a note needs the version the owner saw: an edit he did not see is never deleted with it. */
const requiredVersionQuery = z.object({ version: z.coerce.number().int().min(1) })

/** A version number in the path; anything else cannot name a version: `not_found`. */
function versionParam(c: Context): number {
  const value = Number(c.req.param("version"))
  if (!Number.isInteger(value) || value < 1) throw notFound("The version")
  return value
}

/** Sync pushes come from the sync tool with a token, never from a browser. */
function requireToken(c: Context<Env>) {
  if (c.get("auth").via === "session") throw forbidden("Sync data is pushed with an agent key.")
}

/** A route's own code, after its authentication. */
export type RouteHandler = (c: Context<Env>) => Promise<Response>

/**
 * The code of every route open to agents (agents/policy.ts OPEN but `access` and `endpoints`), keyed by method and
 * template. The owner's routes below and the agent channel (agents/channel.ts) register these same functions, so an
 * agent connected by approval runs exactly the code an agent key runs.
 */
export function openRouteHandlers(deps: { ctx: Ctx }): Record<string, RouteHandler> {
  const { ctx } = deps
  return {
    "GET /api/v1/projects": async (c) => c.json({ data: await listProjects(ctx) }),
    "PATCH /api/v1/projects/{id}": async (c) =>
      c.json({ data: await updateProject(ctx, byOf(c), idParam(c), await body(c, updateProjectBody)) }),
    "POST /api/v1/projects/{id}/stage-proposals": async (c) =>
      c.json({ data: await proposeStage(ctx, byOf(c), idParam(c), await body(c, proposeStageBody)) }, 201),
    "GET /api/v1/items": async (c) => c.json({ data: await findItems(ctx, query(c, findItemsQuery)) }),
    "POST /api/v1/items": async (c) =>
      c.json({ data: await createItem(ctx, byOf(c), await body(c, createItemBody)) }, 201),
    "GET /api/v1/items/{id}": async (c) => c.json({ data: await itemDetail(ctx, idParam(c)) }),
    "PATCH /api/v1/items/{id}": async (c) => {
      const { version, ...patch } = await body(c, updateItemBody)
      return c.json({ data: await updateItem(ctx, byOf(c), idParam(c), version, patch) })
    },
    "POST /api/v1/items/{id}/comments": async (c) =>
      c.json({ data: await addComment(ctx, byOf(c), idParam(c), await body(c, commentBody)) }, 201),
    "POST /api/v1/items/{id}/threads": async (c) => {
      const { link, created } = await linkThread(ctx, byOf(c), idParam(c), await body(c, linkThreadBody))
      return c.json({ data: { link, created } }, created ? 201 : 200)
    },
    "POST /api/v1/capture": async (c) =>
      c.json({ data: await captureItem(ctx, byOf(c), await body(c, captureBody)) }, 201),
    "GET /api/v1/notes": async (c) => c.json(await findNotes(ctx, query(c, findNotesQuery))),
    "POST /api/v1/notes": async (c) =>
      c.json({ data: await createNote(ctx, byOf(c), await body(c, createNoteBody)) }, 201),
    "GET /api/v1/notes/{id}": async (c) => c.json({ data: await noteDetail(ctx, idParam(c)) }),
    "PATCH /api/v1/notes/{id}": async (c) => {
      const { version, ...patch } = await body(c, updateNoteBody)
      return c.json({ data: await updateNote(ctx, byOf(c), idParam(c), version, patch) })
    },
    "POST /api/v1/threads/start": async (c) => {
      const result = await startThread(ctx, byOf(c), await body(c, startThreadBody))
      return c.json({ data: result }, result.created ? 201 : 200)
    },
    "POST /api/v1/sync/t3": async (c) => {
      requireToken(c)
      return c.json({ data: await applyT3Snapshot(ctx, await body(c, t3SnapshotBody)) })
    },
    "POST /api/v1/sync/checkin": async (c) => {
      // The client is the agent connection that sends it: only a connection approved for the sync area checks in.
      const auth = c.get("auth")
      if (auth.via !== "agent") throw forbidden("The sync checks in over its connection to Adiutor.")
      return c.json({ data: await checkIn(ctx, auth.connectionId, await body(c, syncCheckinBody)) })
    },
  }
}

/** The body limits of /api/v1: sync snapshots are large, everything else is small. */
export const BODY_LIMITS = { sync: 16 * 1024 * 1024, default: 512 * 1024 } as const

/**
 * The sync's snapshot push, whose answer is a sync run (`data.outcome`), as opposed to its check-in. Security data no
 * longer comes from the sync: the server reads GitHub itself (server/github/).
 */
export const SNAPSHOT_PATHS = ["/api/v1/sync/t3"] as const
export const isSnapshotPath = (path: string) => (SNAPSHOT_PATHS as readonly string[]).includes(path)

export function apiRoutes(
  deps: AuthDeps & {
    version: string
    telegram?: TelegramRuntime
    settings: SettingsHandle
    /** The server's GitHub reading; the GitHub routes exist only with it (index.ts and the test core pass it). */
    github?: GitHubHandle
  },
) {
  const { ctx } = deps
  const api = new Hono<Env>()
  const open = openRouteHandlers(deps)
  const h = (key: string): RouteHandler => {
    const handler = open[key]
    if (!handler) throw new Error(`no handler for ${key}`)
    return handler
  }

  // Credentials first: a request without a valid key or session is refused before the app reads its body.
  // authenticate reads headers only.
  api.use("*", authenticate(deps, { allowSession: true }))

  // Snapshots from the sync tool are large; everything else, its check-in included, is small.
  const syncLimit = bodyLimit({ maxSize: BODY_LIMITS.sync, onError: tooLarge })
  const defaultLimit = bodyLimit({ maxSize: BODY_LIMITS.default, onError: tooLarge })
  api.use("*", (c, next) => (isSnapshotPath(c.req.path) ? syncLimit : defaultLimit)(c, next))

  // --- Session and visits ---
  api.use("/session", noStore)
  api.get("/session", (c) => {
    const auth = c.get("auth")
    return c.json({
      data: {
        actor: auth.actor,
        via: auth.via,
        expiresAt: auth.via === "session" ? auth.expiresAt : null,
      },
    })
  })
  api.get("/morning", async (c) => {
    const { since } = query(c, morningQuery)
    return c.json({ data: await morning(ctx, { since }) })
  })
  api.post("/visits", async (c) => {
    const auth = c.get("auth")
    if (auth.via !== "session") throw forbidden("Visits are recorded for signed-in browsers only.")
    // An empty body records the visit now; the UI sends the time of the read it showed.
    const { at } = (await c.req.text()).trim() ? await body(c, visitBody) : {}
    const previous = await previousVisit(ctx)
    return c.json({ data: { at: await recordVisit(ctx, at), previous } }, 201)
  })

  // --- Projects ---
  api.get("/projects", h("GET /api/v1/projects"))
  api.post("/projects", async (c) =>
    c.json({ data: await createProject(ctx, byOf(c), await body(c, createProjectBody)) }, 201),
  )
  api.get("/projects/:id", async (c) => c.json({ data: await projectDetail(ctx, idParam(c)) }))
  api.patch("/projects/:id", h("PATCH /api/v1/projects/{id}"))
  api.delete("/projects/:id", async (c) => {
    await deleteProject(ctx, byOf(c), idParam(c))
    return c.body(null, 204)
  })
  api.post("/projects/:id/stage-proposals", h("POST /api/v1/projects/{id}/stage-proposals"))
  api.post("/stage-proposals/:id/decision", async (c) => {
    const { decision } = await body(c, decideProposalBody)
    return c.json({ data: await decideProposal(ctx, byOf(c), idParam(c), decision) })
  })

  // --- Items ---
  api.get("/items", h("GET /api/v1/items"))
  api.post("/items", h("POST /api/v1/items"))
  api.get("/items/:id", h("GET /api/v1/items/{id}"))
  api.patch("/items/:id", h("PATCH /api/v1/items/{id}"))
  api.delete("/items/:id", async (c) => {
    await deleteItem(ctx, byOf(c), idParam(c), query(c, versionQuery).version)
    return c.body(null, 204)
  })
  api.post("/items/:id/comments", h("POST /api/v1/items/{id}/comments"))
  api.post("/items/:id/threads", h("POST /api/v1/items/{id}/threads"))
  api.post("/capture", h("POST /api/v1/capture"))
  api.get("/inbox", async (c) => c.json({ data: await inbox(ctx) }))
  api.get("/archive", async (c) => c.json(await archive(ctx, query(c, archiveQuery))))
  api.get("/audit", async (c) => c.json(await auditLog(ctx, byOf(c), query(c, auditQuery))))

  // --- Notes ---
  api.get("/notes", h("GET /api/v1/notes"))
  api.post("/notes", h("POST /api/v1/notes"))
  api.get("/notes/:id", h("GET /api/v1/notes/{id}"))
  api.patch("/notes/:id", h("PATCH /api/v1/notes/{id}"))
  api.delete("/notes/:id", async (c) => {
    await deleteNote(ctx, byOf(c), idParam(c), query(c, requiredVersionQuery).version)
    return c.body(null, 204)
  })
  api.get("/notes/:id/versions", async (c) => c.json(await listNoteVersions(ctx, idParam(c), query(c, pageQuery))))
  api.get("/notes/:id/versions/:version", async (c) =>
    c.json({ data: await getNoteVersion(ctx, idParam(c), versionParam(c)) }),
  )
  api.post("/notes/:id/restore", async (c) =>
    c.json({ data: await restoreNote(ctx, byOf(c), idParam(c), await body(c, restoreNoteBody)) }),
  )

  // --- T3 ---
  api.post("/threads/start", h("POST /api/v1/threads/start"))
  api.post("/sync/t3", h("POST /api/v1/sync/t3"))
  api.post("/sync/checkin", h("POST /api/v1/sync/checkin"))
  api.get("/sync/runs", async (c) => {
    const { limit: count, kind } = query(c, z.object({ limit, kind: z.enum(["t3", "security", "github"]).optional() }))
    return c.json({ data: await recentSyncRuns(ctx, count ?? 20, kind) })
  })
  // "Sync now": the owner asks the sync on the computer for a run; it takes the request at its next check-in.
  api.use("/sync/requests", noStore)
  api.get("/sync/requests", requireOwnerAuth, async (c) => c.json({ data: await syncRequestsView(ctx) }))
  api.post("/sync/requests", requireOwnerAuth, async (c) => {
    const { request, created } = await requestSync(ctx, byOf(c))
    return c.json({ data: { request, created } }, created ? 201 : 200)
  })
  api.delete("/sync/requests/:id", requireOwnerAuth, async (c) =>
    c.json({ data: await cancelSyncRequest(ctx, byOf(c), idParam(c)) }),
  )

  // --- Owner only: settings, suppressions ---
  api.use("/settings", noStore)
  api.get("/settings", requireOwnerAuth, async (c) =>
    c.json({ data: settingsView(await getSettings(ctx.db), deps.settings.env) }),
  )
  api.patch("/settings", async (c) => {
    const row = await updateSettings(ctx, byOf(c), await body(c, settingsBody), deps.settings.env)
    // After the commit: the Better Auth instance, the bot and the secret check pick up what changed.
    await deps.settings.apply(row)
    return c.json({ data: settingsView(row, deps.settings.env) })
  })
  api.get("/suppressions", async (c) => c.json({ data: await listSuppressions(ctx, byOf(c)) }))
  api.delete("/suppressions/:id", async (c) => {
    await removeSuppression(ctx, byOf(c), idParam(c))
    return c.body(null, 204)
  })
  api.get("/telegram/status", requireOwnerAuth, async (c) =>
    c.json({ data: await telegramStatus(ctx, deps.telegram ?? TELEGRAM_OFF) }),
  )
  api.post("/telegram/test-message", requireOwnerAuth, async (c) => {
    const send = deps.telegram?.configured ? deps.telegram.send?.bind(deps.telegram) : undefined
    return c.json({ data: await sendTestMorningMessage(ctx, byOf(c), deps.config.publicUrl, send) })
  })
  // --- Owner only: the server's GitHub reading ---
  if (deps.github)
    githubRoutes(api, { ctx, env: deps.settings.env, github: deps.github, publicUrl: deps.config.publicUrl })
  return api
}

function tooLarge(c: Context) {
  return c.json({ error: { code: "validation_failed", message: "The request body is too large." } }, 413)
}

async function noStore(c: Context, next: () => Promise<void>) {
  await next()
  c.header("Cache-Control", "no-store")
}
