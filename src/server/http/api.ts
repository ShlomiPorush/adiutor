import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { deleteCookie, setCookie } from "hono/cookie"
import { z } from "zod"
import {
  captureBody,
  commentBody,
  createItemBody,
  createProjectBody,
  decideProposalBody,
  linkThreadBody,
  pairBody,
  proposeStageBody,
  securitySnapshotBody,
  settingsBody,
  startThreadBody,
  t3SnapshotBody,
  updateItemBody,
  updateProjectBody,
} from "../../shared/api.ts"
import { itemStatusSchema, itemTypeSchema } from "../../shared/enums.ts"
import { AppError, forbidden, invalid, notFound } from "../errors.ts"
import {
  getSettings,
  listDevices,
  listSuppressions,
  pairDevice,
  previousVisit,
  publicDevice,
  recordVisit,
  removeSuppression,
  revokeAllDevices,
  revokeDevice,
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
import { applySecuritySnapshot, applyT3Snapshot, recentSyncRuns } from "../services/sync.ts"
import { startThread } from "../services/threads.ts"
import {
  type AuthDeps,
  authenticate,
  byOf,
  checkBrowserRequest,
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE,
  type Env,
  insecureCookieAllowed,
  requireOwnerAuth,
  tokenKind,
} from "./auth.ts"

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

/** Sync pushes come from the sync tool with a token, never from a browser. */
function requireToken(c: Context<Env>) {
  if (c.get("auth").via !== "token") throw forbidden("Sync data is pushed with a token.")
}

export function apiRoutes(deps: AuthDeps & { version: string }) {
  const { ctx, config, limiter } = deps
  const api = new Hono<Env>()

  // Snapshots from the sync tool are large; everything else is small.
  const syncLimit = bodyLimit({ maxSize: 16 * 1024 * 1024, onError: tooLarge })
  const defaultLimit = bodyLimit({ maxSize: 512 * 1024, onError: tooLarge })
  api.use("*", (c, next) => (c.req.path.includes("/sync/") ? syncLimit : defaultLimit)(c, next))

  // Pairing: the owner pastes the owner token once on a new browser; it gets a device cookie.
  api.post("/pair", async (c) => {
    const ip = deps.clientIp(c)
    if (limiter.blocked(ip))
      throw new AppError("rate_limited", "Too many failed attempts. Wait a minute and try again.")
    checkBrowserRequest(c, config.publicUrl)
    const input = await body(c, pairBody)
    const kind = tokenKind(input.token, config)
    if (!kind) {
      limiter.fail(ip)
      throw new AppError("unauthorized", "The token is not valid.")
    }
    if (kind !== "owner") throw forbidden("Pair a browser with the owner token.")
    const { device, secret } = await pairDevice(
      ctx,
      { actor: { kind: "owner", label: "owner" }, source: "ui" },
      input.label ?? "Browser",
    )
    setCookie(c, DEVICE_COOKIE, secret, {
      httpOnly: true,
      sameSite: "Lax",
      secure: !insecureCookieAllowed(config.publicUrl),
      path: "/",
      maxAge: DEVICE_COOKIE_MAX_AGE,
    })
    return c.json({ data: { device: publicDevice(device) } }, 201)
  })

  api.use("*", authenticate(deps, { allowCookie: true }))

  // --- Session and visits ---
  api.get("/session", (c) => {
    const auth = c.get("auth")
    return c.json({ data: { actor: auth.actor, via: auth.via, deviceId: auth.deviceId ?? null } })
  })
  api.delete("/session", async (c) => {
    const auth = c.get("auth")
    if (!auth.deviceId) throw forbidden("Only a paired browser can end its own session.")
    await revokeDevice(ctx, byOf(c), auth.deviceId)
    deleteCookie(c, DEVICE_COOKIE, { path: "/" })
    return c.body(null, 204)
  })
  api.get("/morning", async (c) => c.json({ data: await morning(ctx, { deviceId: c.get("auth").deviceId }) }))
  api.post("/visits", async (c) => {
    const deviceId = c.get("auth").deviceId
    if (!deviceId) throw forbidden("Visits are recorded for paired browsers only.")
    const previous = await previousVisit(ctx, deviceId)
    return c.json({ data: { at: await recordVisit(ctx, deviceId), previous } }, 201)
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

  // --- Owner only: settings, suppressions, devices ---
  api.get("/settings", requireOwnerAuth, async (c) => c.json({ data: await getSettings(ctx.db) }))
  api.patch("/settings", async (c) => c.json({ data: await updateSettings(ctx, byOf(c), await body(c, settingsBody)) }))
  api.get("/suppressions", async (c) => c.json({ data: await listSuppressions(ctx, byOf(c)) }))
  api.delete("/suppressions/:id", async (c) => {
    await removeSuppression(ctx, byOf(c), idParam(c))
    return c.body(null, 204)
  })
  api.get("/devices", async (c) => c.json({ data: await listDevices(ctx, byOf(c)) }))
  api.delete("/devices/:id", async (c) => {
    await revokeDevice(ctx, byOf(c), idParam(c))
    return c.body(null, 204)
  })
  api.post("/devices/end-all", async (c) => {
    const ended = await revokeAllDevices(ctx, byOf(c))
    if (c.get("auth").via === "cookie") deleteCookie(c, DEVICE_COOKIE, { path: "/" })
    return c.json({ data: { ended } })
  })

  return api
}

function tooLarge(c: Context) {
  return c.json({ error: { code: "validation_failed", message: "The request body is too large." } }, 413)
}
