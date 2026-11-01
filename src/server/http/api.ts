import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import {
  captureBody,
  commentBody,
  createItemBody,
  createProjectBody,
  decideProposalBody,
  linkThreadBody,
  morningQuery,
  proposeStageBody,
  securitySnapshotBody,
  settingsBody,
  startThreadBody,
  t3SnapshotBody,
  updateItemBody,
  updateProjectBody,
  visitBody,
} from "../../shared/api.ts"
import { changePasswordBody } from "../../shared/auth.ts"
import { itemStatusSchema, itemTypeSchema } from "../../shared/enums.ts"
import { passwordHasher } from "../auth/auth.ts"
import { cookieNames } from "../auth/cookies.ts"
import { AppError, forbidden, invalid, notFound } from "../errors.ts"
import { sendTestMorningMessage } from "../jobs/morning.ts"
import { changePassword, endAllSessions, endOtherSessions, listSessions } from "../services/account.ts"
import {
  getSettings,
  listSuppressions,
  previousVisit,
  recordVisit,
  removeSuppression,
  updateSettings,
} from "../services/admin.ts"
import { addComment, captureItem, createItem, deleteItem, linkThread, updateItem } from "../services/items.ts"
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
import { checkSession } from "../services/session-policy.ts"
import { applySecuritySnapshot, applyT3Snapshot, recentSyncRuns } from "../services/sync.ts"
import { startThread } from "../services/threads.ts"
import { TELEGRAM_OFF, type TelegramRuntime, telegramStatus } from "../telegram/status.ts"
import { type Auth, type AuthDeps, authenticate, byOf, type Env, type RateLimiter, requireOwnerAuth } from "./auth.ts"

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

const uuid = z.uuid()
/** A path id that is not a UUID cannot name anything: `not_found`. */
function idParam(c: Context, name = "id"): string {
  const value = c.req.param(name) ?? ""
  if (!uuid.safeParse(value).success) throw notFound("The resource")
  return value
}

const bool = z.enum(["true", "false"]).transform((v) => v === "true")
const limit = z.coerce.number().int().min(1).max(200).optional()

const findItemsQuery = z.object({
  q: z.string().max(200).optional(),
  projectId: z.uuid().optional(),
  inbox: bool.optional(),
  status: z.array(itemStatusSchema).optional(),
  type: itemTypeSchema.optional(),
  threadId: z.string().max(200).optional(),
  includeClosed: bool.optional(),
  limit,
})
const archiveQuery = z.object({ projectId: z.uuid().optional(), cursor: z.string().max(500).optional(), limit })
const auditQuery = z.object({
  cursor: z.string().max(500).optional(),
  limit,
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(200).optional(),
})
const versionQuery = z.object({ version: z.coerce.number().int().min(1).optional() })

/** The owner's signed-in browser session; tokens are refused. */
function requireSession(c: Context<Env>): Extract<Auth, { via: "session" }> {
  const auth = c.get("auth")
  if (auth.via !== "session") throw forbidden("Only a signed-in browser can do this.")
  return auth
}

/** Sync pushes come from the sync tool with a token, never from a browser. */
function requireToken(c: Context<Env>) {
  if (c.get("auth").via !== "token") throw forbidden("Sync data is pushed with a token.")
}

export function apiRoutes(deps: AuthDeps & { version: string; telegram?: TelegramRuntime; attempts: RateLimiter }) {
  const { ctx } = deps
  const api = new Hono<Env>()

  // Snapshots from the sync tool are large; everything else is small.
  const syncLimit = bodyLimit({ maxSize: 16 * 1024 * 1024, onError: tooLarge })
  const defaultLimit = bodyLimit({ maxSize: 512 * 1024, onError: tooLarge })
  api.use("*", (c, next) => (c.req.path.includes("/sync/") ? syncLimit : defaultLimit)(c, next))

  api.use("*", authenticate(deps, { allowSession: true }))

  // --- Session, account and visits ---
  api.use("/session/*", noStore)
  api.use("/account/*", noStore)
  api.get("/session", (c) => {
    const auth = c.get("auth")
    return c.json({
      data: {
        actor: auth.actor,
        via: auth.via,
        browserId: auth.via === "session" ? auth.browserId : null,
        clocks: auth.via === "session" ? auth.status : null,
      },
    })
  })
  // Real input on the page (keys, pointer, wheel, touch), sent at most every 30 seconds: restarts the idle clock.
  api.post("/session/activity", async (c) => {
    const auth = requireSession(c)
    const check = await checkSession(ctx, auth.sessionId, "activity")
    if (!check.ok) throw new AppError("session_ended", "Your session ended. Sign in again.", { reason: check.reason })
    return c.json({ data: { clocks: check.session.status } })
  })
  api.get("/account/sessions", async (c) => {
    const auth = requireSession(c)
    return c.json({ data: { username: auth.actor.label, sessions: await listSessions(ctx, auth.sessionId) } })
  })
  api.post("/account/password", async (c) => {
    const auth = requireSession(c)
    const key = `password:${deps.clientIp(c)}`
    if (deps.attempts.blocked(key))
      throw new AppError("rate_limited", "Too many attempts. Wait a few minutes and try again.")
    deps.attempts.fail(key)
    const input = await body(c, changePasswordBody)
    return c.json({ data: await changePassword(ctx, await passwordHasher(deps.auth), auth.sessionId, input) })
  })
  api.post("/account/sessions/end-others", async (c) => {
    const auth = requireSession(c)
    return c.json({ data: { ended: await endOtherSessions(ctx, auth.sessionId) } })
  })
  api.post("/account/sessions/end-all", async (c) => {
    const auth = requireSession(c)
    const ended = await endAllSessions(ctx, auth.sessionId)
    const response = c.json({ data: { ended } })
    for (const cookie of (await cookieNames(deps.auth)).clearing) response.headers.append("set-cookie", cookie)
    return response
  })
  api.get("/morning", async (c) => {
    const { since } = query(c, morningQuery)
    const auth = c.get("auth")
    return c.json({ data: await morning(ctx, { deviceId: auth.via === "session" ? auth.browserId : null, since }) })
  })
  api.post("/visits", async (c) => {
    const auth = c.get("auth")
    if (auth.via !== "session") throw forbidden("Visits are recorded for signed-in browsers only.")
    // An empty body records the visit now; the UI sends the time of the read it showed.
    const { at } = (await c.req.text()).trim() ? await body(c, visitBody) : {}
    const previous = await previousVisit(ctx, auth.browserId)
    return c.json({ data: { at: await recordVisit(ctx, auth.browserId, at), previous } }, 201)
  })

  // --- Projects ---
  api.get("/projects", async (c) => c.json({ data: await listProjects(ctx) }))
  api.post("/projects", async (c) =>
    c.json({ data: await createProject(ctx, byOf(c), await body(c, createProjectBody)) }, 201),
  )
  api.get("/projects/:id", async (c) => c.json({ data: await projectDetail(ctx, idParam(c)) }))
  api.patch("/projects/:id", async (c) =>
    c.json({ data: await updateProject(ctx, byOf(c), idParam(c), await body(c, updateProjectBody)) }),
  )
  api.delete("/projects/:id", async (c) => {
    await deleteProject(ctx, byOf(c), idParam(c))
    return c.body(null, 204)
  })
  api.post("/projects/:id/stage-proposals", async (c) =>
    c.json({ data: await proposeStage(ctx, byOf(c), idParam(c), await body(c, proposeStageBody)) }, 201),
  )
  api.post("/stage-proposals/:id/decision", async (c) => {
    const { decision } = await body(c, decideProposalBody)
    return c.json({ data: await decideProposal(ctx, byOf(c), idParam(c), decision) })
  })

  // --- Items ---
  api.get("/items", async (c) => c.json({ data: await findItems(ctx, query(c, findItemsQuery)) }))
  api.post("/items", async (c) => c.json({ data: await createItem(ctx, byOf(c), await body(c, createItemBody)) }, 201))
  api.get("/items/:id", async (c) => c.json({ data: await itemDetail(ctx, idParam(c)) }))
  api.patch("/items/:id", async (c) => {
    const { version, ...patch } = await body(c, updateItemBody)
    return c.json({ data: await updateItem(ctx, byOf(c), idParam(c), version, patch) })
  })
  api.delete("/items/:id", async (c) => {
    await deleteItem(ctx, byOf(c), idParam(c), query(c, versionQuery).version)
    return c.body(null, 204)
  })
  api.post("/items/:id/comments", async (c) =>
    c.json({ data: await addComment(ctx, byOf(c), idParam(c), await body(c, commentBody)) }, 201),
  )
  api.post("/items/:id/threads", async (c) => {
    const { link, created } = await linkThread(ctx, byOf(c), idParam(c), await body(c, linkThreadBody))
    return c.json({ data: { link, created } }, created ? 201 : 200)
  })
  api.post("/capture", async (c) => c.json({ data: await captureItem(ctx, byOf(c), await body(c, captureBody)) }, 201))
  api.get("/inbox", async (c) => c.json({ data: await inbox(ctx) }))
  api.get("/archive", async (c) => c.json(await archive(ctx, query(c, archiveQuery))))
  api.get("/audit", async (c) => c.json(await auditLog(ctx, query(c, auditQuery))))

  // --- T3 ---
  api.post("/threads/start", async (c) => {
    const result = await startThread(ctx, byOf(c), await body(c, startThreadBody))
    return c.json({ data: result }, result.created ? 201 : 200)
  })
  api.post("/sync/t3", async (c) => {
    requireToken(c)
    return c.json({ data: await applyT3Snapshot(ctx, await body(c, t3SnapshotBody)) })
  })
  api.post("/sync/security", async (c) => {
    requireToken(c)
    return c.json({ data: await applySecuritySnapshot(ctx, await body(c, securitySnapshotBody)) })
  })
  api.get("/sync/runs", async (c) =>
    c.json({ data: await recentSyncRuns(ctx, query(c, z.object({ limit })).limit ?? 20) }),
  )

  // --- Owner only: settings, suppressions ---
  api.get("/settings", requireOwnerAuth, async (c) => c.json({ data: await getSettings(ctx.db) }))
  api.patch("/settings", async (c) => c.json({ data: await updateSettings(ctx, byOf(c), await body(c, settingsBody)) }))
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
  return api
}

function tooLarge(c: Context) {
  return c.json({ error: { code: "validation_failed", message: "The request body is too large." } }, 413)
}

async function noStore(c: Context, next: () => Promise<void>) {
  await next()
  c.header("Cache-Control", "no-store")
}
