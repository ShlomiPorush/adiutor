import { and, asc, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm"
import { CLOSED_STATUSES, type ItemStatus, type ItemType } from "../../shared/enums.ts"
import {
  audit,
  comments,
  goals,
  items,
  itemThreads,
  projects,
  securitySources,
  stageProposals,
  syncRuns,
} from "../db/schema.ts"
import { invalid, notFound } from "../errors.ts"
import { getSettings, previousVisit } from "./admin.ts"
import type { Ctx } from "./context.ts"
import type { ItemRow } from "./items.ts"
import type { ProjectRow } from "./projects.ts"

const DAY_MS = 24 * 60 * 60 * 1000
/** Sync and security data older than this is stale: the reconciler runs once a day. */
export const STALE_AFTER_MS = 26 * 60 * 60 * 1000
/** Families whose counts add up to a project's alerts. */
const ALERT_FAMILIES = ["dependabot", "code_scanning", "secret_scanning"] as const
const AGENT_KINDS = ["agent", "sync"] as const

const isOpen = (item: Pick<ItemRow, "status">) => !(CLOSED_STATUSES as readonly ItemStatus[]).includes(item.status)

export type ItemSummary = {
  id: string
  projectId: string | null
  projectName: string | null
  type: ItemType
  status: ItemStatus
  title: string
  severity: ItemRow["severity"]
  goalId: string | null
  version: number
  statusSetBy: ItemRow["statusSetBy"]
  createdAt: Date
  updatedAt: Date
  closedAt: Date | null
}

function summary(item: ItemRow, names: ReadonlyMap<string, string>): ItemSummary {
  return {
    id: item.id,
    projectId: item.projectId,
    projectName: item.projectId ? (names.get(item.projectId) ?? null) : null,
    type: item.type,
    status: item.status,
    title: item.title,
    severity: item.severity,
    goalId: item.goalId,
    version: item.version,
    statusSetBy: item.statusSetBy,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    closedAt: item.closedAt,
  }
}

async function projectNames(ctx: Ctx): Promise<Map<string, string>> {
  const rows = await ctx.db.select({ id: projects.id, name: projects.name }).from(projects)
  return new Map(rows.map((r) => [r.id, r.name]))
}

export type GoalProgress = { id: string; text: string; createdAt: Date; done: number; total: number }

/** Current goals with progress: done items linked to the goal out of all items linked to it. */
async function currentGoals(ctx: Ctx, projectIds?: string[]): Promise<Map<string, GoalProgress>> {
  const where = projectIds ? and(isNull(goals.closedAt), inArray(goals.projectId, projectIds)) : isNull(goals.closedAt)
  const rows = await ctx.db
    .select({
      id: goals.id,
      projectId: goals.projectId,
      text: goals.text,
      createdAt: goals.createdAt,
      total: sql<number>`count(${items.id})::int`,
      done: sql<number>`count(${items.id}) filter (where ${items.status} = 'done')::int`,
    })
    .from(goals)
    .leftJoin(items, eq(items.goalId, goals.id))
    .where(where)
    .groupBy(goals.id)
  return new Map(
    rows.map((r) => [r.projectId, { id: r.id, text: r.text, createdAt: r.createdAt, done: r.done, total: r.total }]),
  )
}

async function lastSuccess(ctx: Ctx, kind: string): Promise<Date | null> {
  const [row] = await ctx.db
    .select({ at: syncRuns.finishedAt })
    .from(syncRuns)
    .where(and(eq(syncRuns.kind, kind), inArray(syncRuns.outcome, ["succeeded", "partial"])))
    .orderBy(desc(syncRuns.finishedAt))
    .limit(1)
  return row?.at ?? null
}

export async function syncStatus(ctx: Ctx) {
  const now = ctx.clock().getTime()
  const [t3, security] = await Promise.all([lastSuccess(ctx, "t3"), lastSuccess(ctx, "security")])
  return {
    lastSuccessAt: t3,
    stale: !t3 || now - t3.getTime() > STALE_AFTER_MS,
    securityLastSuccessAt: security,
  }
}

export type SecurityLine = {
  projectId: string
  projectName: string
  stage: ProjectRow["stage"]
  /** Counted in every project. */
  critical: number
  /** Counted only at stage production; 0 elsewhere. */
  high: number
  alerts: { critical: number; high: number }
  items: { critical: number; high: number }
  /** The oldest as-of time of the project's enabled alert sources; null when it has none. */
  asOf: Date | null
  stale: boolean
}

/**
 * One line per project with something to say: critical findings in every project, high ones only at
 * stage production. Counts come from enabled alert sources and open items of type security.
 */
export async function securityLines(ctx: Ctx, allProjects: ProjectRow[]): Promise<SecurityLine[]> {
  const now = ctx.clock().getTime()
  const sources = await ctx.db
    .select()
    .from(securitySources)
    .where(and(eq(securitySources.coverage, "enabled"), inArray(securitySources.family, ALERT_FAMILIES)))
  const securityItems = await ctx.db
    .select({ projectId: items.projectId, severity: items.severity })
    .from(items)
    .where(and(eq(items.type, "security"), isNull(items.closedAt), isNotNull(items.projectId)))
  const lines: SecurityLine[] = []
  for (const p of allProjects) {
    const own = sources.filter((s) => s.projectId === p.id)
    const alerts = {
      critical: own.reduce((n, s) => n + s.critical, 0),
      high: own.reduce((n, s) => n + s.high, 0),
    }
    const mine = securityItems.filter((i) => i.projectId === p.id)
    const fromItems = {
      critical: mine.filter((i) => i.severity === "critical").length,
      high: mine.filter((i) => i.severity === "high").length,
    }
    const critical = alerts.critical + fromItems.critical
    const high = p.stage === "production" ? alerts.high + fromItems.high : 0
    if (critical === 0 && high === 0) continue
    const times = own.map((s) => s.asOf?.getTime() ?? Number.NEGATIVE_INFINITY)
    const oldest = times.length > 0 ? Math.min(...times) : null
    lines.push({
      projectId: p.id,
      projectName: p.name,
      stage: p.stage,
      critical,
      high,
      alerts,
      items: fromItems,
      asOf: oldest !== null && Number.isFinite(oldest) ? new Date(oldest) : null,
      stale: oldest !== null && (!Number.isFinite(oldest) || now - oldest > STALE_AFTER_MS),
    })
  }
  return lines.sort((a, b) => b.critical - a.critical || b.high - a.high || a.projectName.localeCompare(b.projectName))
}

type AgentUpdate =
  | {
      kind: "comment"
      at: Date
      itemId: string
      itemTitle: string
      actorKind: string
      actorLabel: string | null
      text: string
    }
  | {
      kind: "status"
      at: Date
      itemId: string
      itemTitle: string
      actorKind: string
      actorLabel: string | null
      from: string | null
      to: string | null
    }

const MAX_UPDATES = 300

/** Comments and status changes by agents and the sync since `since`, grouped by project, newest first. */
async function agentUpdates(ctx: Ctx, since: Date, names: ReadonlyMap<string, string>) {
  const commentRows = await ctx.db
    .select({ comment: comments, title: items.title, projectId: items.projectId })
    .from(comments)
    .innerJoin(items, eq(items.id, comments.itemId))
    .where(and(gt(comments.createdAt, since), inArray(comments.authorKind, AGENT_KINDS)))
    .orderBy(desc(comments.createdAt))
    .limit(MAX_UPDATES)
  const statusRows = await ctx.db
    .select({ entry: audit, title: items.title, projectId: items.projectId })
    .from(audit)
    .innerJoin(items, sql`${items.id}::text = ${audit.entityId}`)
    .where(
      and(
        gt(audit.at, since),
        eq(audit.action, "item.update"),
        inArray(audit.actorKind, AGENT_KINDS),
        sql`${audit.before}->>'status' is distinct from ${audit.after}->>'status'`,
      ),
    )
    .orderBy(desc(audit.at))
    .limit(MAX_UPDATES)

  const groups = new Map<string, { projectId: string | null; projectName: string | null; updates: AgentUpdate[] }>()
  const add = (projectId: string | null, update: AgentUpdate) => {
    const key = projectId ?? ""
    const group = groups.get(key) ?? {
      projectId,
      projectName: projectId ? (names.get(projectId) ?? null) : null,
      updates: [],
    }
    group.updates.push(update)
    groups.set(key, group)
  }
  for (const r of commentRows)
    add(r.projectId, {
      kind: "comment",
      at: r.comment.createdAt,
      itemId: r.comment.itemId,
      itemTitle: r.title,
      actorKind: r.comment.authorKind,
      actorLabel: r.comment.authorLabel,
      text: r.comment.text,
    })
  for (const r of statusRows) {
    const before = r.entry.before as { status?: string } | null
    const after = r.entry.after as { status?: string } | null
    add(r.projectId, {
      kind: "status",
      at: r.entry.at,
      itemId: r.entry.entityId ?? "",
      itemTitle: r.title,
      actorKind: r.entry.actorKind,
      actorLabel: r.entry.actorLabel,
      from: before?.status ?? null,
      to: after?.status ?? null,
    })
  }
  const list = [...groups.values()]
  for (const g of list) g.updates.sort((a, b) => b.at.getTime() - a.at.getTime())
  return list.sort((a, b) => (b.updates[0]?.at.getTime() ?? 0) - (a.updates[0]?.at.getTime() ?? 0))
}

/** Items the morning view shows: open ones, and closed ones from the last `closedItemDays` days. */
async function visibleItems(ctx: Ctx, closedItemDays: number): Promise<ItemRow[]> {
  const cutoff = new Date(ctx.clock().getTime() - closedItemDays * DAY_MS)
  return ctx.db
    .select()
    .from(items)
    .where(or(isNull(items.closedAt), gte(items.closedAt, cutoff)))
}

/** The home screen. `since` is this device's previous visit, or 24 hours ago on its first visit. */
export async function morning(ctx: Ctx, options: { deviceId?: string | null } = {}) {
  const settingsRow = await getSettings(ctx.db)
  const since = await previousVisit(ctx, options.deviceId)
  const allProjects = await ctx.db.select().from(projects).orderBy(asc(projects.name))
  const names = new Map(allProjects.map((p) => [p.id, p.name]))
  const visible = await visibleItems(ctx, settingsRow.closedItemDays)
  const proposals = await ctx.db
    .select()
    .from(stageProposals)
    .where(eq(stageProposals.state, "open"))
    .orderBy(desc(stageProposals.createdAt))

  const waiting = [
    ...visible
      .filter((i) => i.status === "waiting_on_you")
      .map((i) => ({ kind: "item" as const, at: i.statusSetAt, item: summary(i, names) })),
    ...proposals.map((p) => ({
      kind: "stage_proposal" as const,
      at: p.createdAt,
      proposal: {
        id: p.id,
        projectId: p.projectId,
        projectName: names.get(p.projectId) ?? null,
        currentStage: allProjects.find((x) => x.id === p.projectId)?.stage ?? null,
        proposedStage: p.proposedStage,
        reason: p.reason,
        authorKind: p.authorKind,
        authorLabel: p.authorLabel,
        createdAt: p.createdAt,
      },
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime())

  const fresh = visible
    .flatMap((i): { change: "created" | "updated"; item: ItemSummary }[] => {
      if (i.createdAt > since && !i.imported) return [{ change: "created" as const, item: summary(i, names) }]
      if (i.updatedAt > since && i.updatedAt > i.createdAt)
        return [{ change: "updated" as const, item: summary(i, names) }]
      return []
    })
    .sort((a, b) => b.item.updatedAt.getTime() - a.item.updatedAt.getTime())

  const open = visible.filter(isOpen)
  const openByProject = new Map<string, number>()
  for (const i of open) if (i.projectId) openByProject.set(i.projectId, (openByProject.get(i.projectId) ?? 0) + 1)
  const goalsByProject = await currentGoals(ctx)
  const projectLines = allProjects
    .filter((p) => openByProject.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      stage: p.stage,
      goal: goalsByProject.get(p.id) ?? null,
      whereWeAre: p.whereWeAre,
      openItems: openByProject.get(p.id) ?? 0,
      openIssues: p.openIssuesCount,
      openIssuesAsOf: p.openIssuesAsOf,
      repo: p.githubRepo,
    }))

  return {
    now: ctx.clock(),
    since,
    waiting,
    new: fresh,
    security: await securityLines(ctx, allProjects),
    agentUpdates: await agentUpdates(ctx, since, names),
    projects: projectLines,
    inboxCount: open.filter((i) => !i.projectId).length,
    sync: await syncStatus(ctx),
  }
}

/** Every project with its current goal, stage and counts. */
export async function listProjects(ctx: Ctx) {
  const rows = await ctx.db.select().from(projects).orderBy(asc(projects.name))
  const counts = await ctx.db
    .select({ projectId: items.projectId, open: sql<number>`count(*)::int` })
    .from(items)
    .where(and(isNull(items.closedAt), isNotNull(items.projectId)))
    .groupBy(items.projectId)
  const proposals = await ctx.db
    .select({ projectId: stageProposals.projectId, open: sql<number>`count(*)::int` })
    .from(stageProposals)
    .where(eq(stageProposals.state, "open"))
    .groupBy(stageProposals.projectId)
  const goalsByProject = await currentGoals(ctx)
  return rows.map((p) => ({
    ...p,
    goal: goalsByProject.get(p.id) ?? null,
    openItems: counts.find((c) => c.projectId === p.id)?.open ?? 0,
    openProposals: proposals.find((c) => c.projectId === p.id)?.open ?? 0,
  }))
}

export async function projectDetail(ctx: Ctx, id: string) {
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, id))
  if (!project) throw notFound("The project")
  const settingsRow = await getSettings(ctx.db)
  const cutoff = new Date(ctx.clock().getTime() - settingsRow.closedItemDays * DAY_MS)
  const projectItems = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.projectId, id), or(isNull(items.closedAt), gte(items.closedAt, cutoff))))
    .orderBy(desc(items.updatedAt))
  const names = new Map([[project.id, project.name]])
  const pastGoals = await ctx.db
    .select()
    .from(goals)
    .where(and(eq(goals.projectId, id), isNotNull(goals.closedAt)))
    .orderBy(desc(goals.closedAt))
    .limit(10)
  const proposals = await ctx.db
    .select()
    .from(stageProposals)
    .where(eq(stageProposals.projectId, id))
    .orderBy(desc(stageProposals.createdAt))
    .limit(20)
  const sources = await ctx.db.select().from(securitySources).where(eq(securitySources.projectId, id))
  const [line] = await securityLines(ctx, [project])
  return {
    project,
    goal: (await currentGoals(ctx, [id])).get(id) ?? null,
    pastGoals,
    items: projectItems.map((i) => summary(i, names)),
    proposals,
    securitySources: sources,
    security: line ?? null,
  }
}

export async function itemDetail(ctx: Ctx, id: string) {
  const [item] = await ctx.db.select().from(items).where(eq(items.id, id))
  if (!item) throw notFound("The item")
  const [project] = item.projectId
    ? await ctx.db
        .select({ id: projects.id, name: projects.name, slug: projects.slug, stage: projects.stage })
        .from(projects)
        .where(eq(projects.id, item.projectId))
    : []
  const [goal] = item.goalId ? await ctx.db.select().from(goals).where(eq(goals.id, item.goalId)) : []
  const threads = await ctx.db
    .select()
    .from(itemThreads)
    .where(eq(itemThreads.itemId, id))
    .orderBy(asc(itemThreads.linkedAt))
  const itemComments = await ctx.db
    .select()
    .from(comments)
    .where(eq(comments.itemId, id))
    .orderBy(asc(comments.createdAt))
  const history = await ctx.db
    .select()
    .from(audit)
    .where(and(eq(audit.entityType, "item"), eq(audit.entityId, id)))
    .orderBy(desc(audit.id))
    .limit(100)
  return {
    item,
    project: project ?? null,
    goal: goal ?? null,
    threads,
    comments: itemComments,
    audit: history,
  }
}

export type FindItemsFilter = {
  q?: string
  projectId?: string | null
  /** true: only inbox items. */
  inbox?: boolean
  status?: ItemStatus[]
  type?: ItemType
  threadId?: string
  includeClosed?: boolean
  limit?: number
}

export async function findItems(ctx: Ctx, filter: FindItemsFilter): Promise<ItemSummary[]> {
  const where: SQL[] = []
  if (filter.q) {
    const pattern = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const match = or(ilike(items.title, pattern), ilike(items.body, pattern))
    if (match) where.push(match)
  }
  if (filter.projectId) where.push(eq(items.projectId, filter.projectId))
  if (filter.inbox) where.push(isNull(items.projectId))
  if (filter.status?.length) where.push(inArray(items.status, filter.status))
  else if (!filter.includeClosed) where.push(isNull(items.closedAt))
  if (filter.type) where.push(eq(items.type, filter.type))
  if (filter.threadId)
    where.push(
      inArray(
        items.id,
        ctx.db.select({ id: itemThreads.itemId }).from(itemThreads).where(eq(itemThreads.threadId, filter.threadId)),
      ),
    )
  const rows = await ctx.db
    .select()
    .from(items)
    .where(and(...where))
    .orderBy(desc(items.updatedAt))
    .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200))
  const names = await projectNames(ctx)
  return rows.map((i) => summary(i, names))
}

/** The unsorted inbox: open items without a project, newest first. */
export async function inbox(ctx: Ctx): Promise<ItemSummary[]> {
  const rows = await ctx.db
    .select()
    .from(items)
    .where(and(isNull(items.projectId), isNull(items.closedAt)))
    .orderBy(desc(items.createdAt))
  return rows.map((i) => summary(i, new Map()))
}

type Page<T> = { data: T[]; nextCursor: string | null }

function encodeCursor(parts: unknown[]): string {
  return Buffer.from(JSON.stringify(parts)).toString("base64url")
}

function decodeCursor(cursor: string): unknown[] {
  try {
    const parts = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (Array.isArray(parts)) return parts
  } catch {
    // falls through
  }
  throw invalid("The cursor is not valid.")
}

/** Closed items, most recently closed first, paged by cursor. */
export async function archive(
  ctx: Ctx,
  options: { projectId?: string; cursor?: string; limit?: number } = {},
): Promise<Page<ItemSummary>> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const where: SQL[] = [isNotNull(items.closedAt)]
  if (options.projectId) where.push(eq(items.projectId, options.projectId))
  if (options.cursor) {
    const [at, id] = decodeCursor(options.cursor)
    if (typeof at !== "string" || typeof id !== "string" || Number.isNaN(Date.parse(at)))
      throw invalid("The cursor is not valid.")
    where.push(sql`(${items.closedAt}, ${items.id}) < (${new Date(at).toISOString()}::timestamptz, ${id}::uuid)`)
  }
  const rows = await ctx.db
    .select()
    .from(items)
    .where(and(...where))
    .orderBy(desc(items.closedAt), desc(items.id))
    .limit(limit + 1)
  const names = await projectNames(ctx)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    data: page.map((i) => summary(i, names)),
    nextCursor: rows.length > limit && last?.closedAt ? encodeCursor([last.closedAt.toISOString(), last.id]) : null,
  }
}

/** The audit log, newest first, paged by cursor. */
export async function auditLog(
  ctx: Ctx,
  options: { cursor?: string; limit?: number; entityType?: string; entityId?: string } = {},
): Promise<Page<typeof audit.$inferSelect>> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const where: SQL[] = []
  if (options.entityType) where.push(eq(audit.entityType, options.entityType))
  if (options.entityId) where.push(eq(audit.entityId, options.entityId))
  if (options.cursor) {
    const [id] = decodeCursor(options.cursor)
    if (typeof id !== "number" || !Number.isInteger(id)) throw invalid("The cursor is not valid.")
    where.push(lt(audit.id, id))
  }
  const rows = await ctx.db
    .select()
    .from(audit)
    .where(and(...where))
    .orderBy(desc(audit.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return { data: page, nextCursor: rows.length > limit && last ? encodeCursor([last.id]) : null }
}
