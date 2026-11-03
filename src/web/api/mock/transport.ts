// The mock API: the routes of docs/api.md over the invented data in fixtures.ts, held in memory.
// Loaded only when VITE_MIKUD_MOCK=1 (development and screenshots); the production build drops it.
// The mock is always signed in with two-factor; the sign-in pages need the real server. Better Auth's routes
// are answered by mock/auth.ts over the same state. Ending the other sessions is kept in sessionStorage.

import { auditCodesMatching } from "../../../shared/audit-search.ts"
import { ACTOR_KINDS, type ActorKind, type ItemStatus, type Language, type Stage } from "../../../shared/enums.ts"
import type { TransportRequest, TransportResponse } from "../client.ts"
import type { AuditCounts, AuditEntry, Item, ItemSummary, Morning, ProjectListEntry, SecurityLine } from "../types.ts"
import { ago, createState, type MockState, uuid } from "./fixtures.ts"

const state: MockState = createState()
/** The same state for mock/auth.ts. */
export const mockState = state
export const ENDED_OTHERS_KEY = "mikud.mock.endedOthers"
const DELAY_MS = 120
const STALE_MS = 26 * 3_600_000

export function endedOthers(): boolean {
  try {
    return state.endedOthers || sessionStorage.getItem(ENDED_OTHERS_KEY) === "1"
  } catch {
    return state.endedOthers
  }
}

const ok = (data: unknown, status = 200): TransportResponse => ({ status, body: { data } })
const fail = (status: number, code: string, message: string): TransportResponse => ({
  status,
  body: { error: { code, message } },
})
const projectName = (id: string | null) => state.projects.find((project) => project.id === id)?.name ?? null
const isClosed = (status: ItemStatus) => status === "done" || status === "not_relevant"

function summary(item: Item): ItemSummary {
  return {
    id: item.id,
    projectId: item.projectId,
    projectName: projectName(item.projectId),
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

function goalProgress(projectId: string) {
  const goal = state.goals.find((entry) => entry.projectId === projectId && !entry.closedAt)
  if (!goal) return null
  const linked = state.items.filter((item) => item.goalId === goal.id)
  return {
    id: goal.id,
    text: goal.text,
    createdAt: goal.createdAt,
    done: linked.filter((item) => item.status === "done").length,
    total: linked.length,
  }
}

function listEntry(projectId: string): ProjectListEntry | null {
  const project = state.projects.find((entry) => entry.id === projectId)
  if (!project) return null
  return {
    ...project,
    goal: goalProgress(project.id),
    openItems: state.items.filter((item) => item.projectId === project.id && !isClosed(item.status)).length,
    openProposals: state.proposals.filter((proposal) => proposal.projectId === project.id && proposal.state === "open")
      .length,
  }
}

function securityLine(projectId: string): SecurityLine | null {
  const project = state.projects.find((entry) => entry.id === projectId)
  if (!project) return null
  const sources = state.sources.filter(
    (source) => source.projectId === projectId && source.coverage === "enabled" && source.family !== "overview",
  )
  const items = state.items.filter(
    (item) => item.projectId === projectId && item.type === "security" && !isClosed(item.status),
  )
  const alerts = {
    critical: sources.reduce((n, s) => n + s.critical, 0),
    high: sources.reduce((n, s) => n + s.high, 0),
  }
  const itemCounts = {
    critical: items.filter((i) => i.severity === "critical").length,
    high: items.filter((i) => i.severity === "high").length,
  }
  const production = project.stage === "production"
  const critical = alerts.critical + itemCounts.critical
  const high = production ? alerts.high + itemCounts.high : 0
  if (!critical && !high) return null
  const times = sources.map((s) => s.asOf).filter((t): t is string => !!t)
  const asOf = times.length ? (times.sort()[0] ?? null) : null
  return {
    projectId,
    projectName: project.name,
    stage: project.stage,
    critical,
    high,
    alerts,
    items: itemCounts,
    asOf,
    stale: !asOf || Date.now() - new Date(asOf).getTime() > STALE_MS,
  }
}

function morning(): Morning {
  const since = state.previousVisit
  const open = state.items.filter((item) => !isClosed(item.status))
  const waitingItems = open
    .filter((item) => item.status === "waiting_on_you")
    .map((item) => ({ kind: "item" as const, at: item.updatedAt, item: summary(item) }))
  const waitingProposals = state.proposals
    .filter((proposal) => proposal.state === "open")
    .map((proposal) => ({
      kind: "stage_proposal" as const,
      at: proposal.createdAt,
      proposal: {
        id: proposal.id,
        projectId: proposal.projectId,
        projectName: projectName(proposal.projectId) ?? "",
        currentStage: state.projects.find((p) => p.id === proposal.projectId)?.stage ?? null,
        proposedStage: proposal.proposedStage,
        reason: proposal.reason,
        authorKind: proposal.authorKind,
        authorLabel: proposal.authorLabel,
        createdAt: proposal.createdAt,
      },
    }))
  const fresh = state.items
    .filter((item) => item.updatedAt > since)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((item) => ({
      change: item.createdAt > since ? ("created" as const) : ("updated" as const),
      item: summary(item),
    }))
  const groups = new Map<string | null, Morning["agentUpdates"][number]>()
  const push = (projectId: string | null, update: Morning["agentUpdates"][number]["updates"][number]) => {
    const group = groups.get(projectId) ?? { projectId, projectName: projectName(projectId), updates: [] }
    group.updates.push(update)
    groups.set(projectId, group)
  }
  for (const comment of state.comments) {
    if (comment.createdAt <= since || comment.authorKind === "owner") continue
    const item = state.items.find((entry) => entry.id === comment.itemId)
    if (item)
      push(item.projectId, {
        kind: "comment",
        at: comment.createdAt,
        itemId: item.id,
        itemTitle: item.title,
        actorKind: comment.authorKind,
        actorLabel: comment.authorLabel,
        text: comment.text,
      })
  }
  for (const entry of state.audit) {
    if (entry.at <= since || entry.action !== "item.update" || entry.actorKind === "owner") continue
    const item = state.items.find((candidate) => candidate.id === entry.entityId)
    const to = entry.after?.status as ItemStatus | undefined
    if (item && to)
      push(item.projectId, {
        kind: "status",
        at: entry.at,
        itemId: item.id,
        itemTitle: item.title,
        actorKind: entry.actorKind,
        actorLabel: entry.actorLabel,
        from: (entry.before?.status as ItemStatus) ?? null,
        to,
      })
  }
  return {
    now: new Date().toISOString(),
    since,
    waiting: [...waitingProposals, ...waitingItems].sort((a, b) => b.at.localeCompare(a.at)),
    new: fresh,
    security: state.projects.map((project) => securityLine(project.id)).filter((line): line is SecurityLine => !!line),
    agentUpdates: [...groups.values()],
    projects: state.projects
      .map((project) => listEntry(project.id))
      .filter((entry): entry is ProjectListEntry => !!entry && entry.openItems > 0)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        slug: entry.slug,
        stage: entry.stage,
        goal: entry.goal,
        whereWeAre: entry.whereWeAre,
        openItems: entry.openItems,
        openIssues: entry.openIssuesCount,
        openIssuesAsOf: entry.openIssuesAsOf,
        repo: entry.githubRepo,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    inboxCount: open.filter((item) => item.projectId === null).length,
    sync: { lastSuccessAt: ago(27), stale: true, lastPartialAt: ago(3), securityLastSuccessAt: ago(9) },
  }
}

function record(
  action: string,
  entityType: string,
  entityId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
) {
  const entry: AuditEntry = {
    id: (state.audit[0]?.id ?? 0) + 1,
    at: new Date().toISOString(),
    actorKind: "owner",
    actorLabel: "owner",
    action,
    entityType,
    entityId,
    before,
    after,
    source: "ui",
  }
  state.audit.unshift(entry)
}

function page<T>(rows: T[], cursor: string | null, limit: number) {
  const start = cursor ? Number(cursor) : 0
  const slice = rows.slice(start, start + limit)
  return { status: 200, body: { data: slice, nextCursor: start + limit < rows.length ? String(start + limit) : null } }
}

type AuditFacet = "actorKind" | "agent" | "action" | "projectId"

/** The project an audit row belongs to: its own, or its item's project now (docs/api.md, Audit filters). */
function auditProject(entry: AuditEntry): string | null {
  if (entry.entityType === "project") return entry.entityId
  if (entry.entityType === "item") return state.items.find((item) => item.id === entry.entityId)?.projectId ?? null
  return null
}

/** The name the row shows: an item's title, a project's name, a key's label. */
function auditName(entry: AuditEntry): string {
  for (const side of [entry.after, entry.before])
    for (const field of ["title", "name", "label"]) {
      const value = side?.[field]
      if (typeof value === "string") return value
    }
  return ""
}

/**
 * The server's audit filter over the mock's rows: the list, the total and every facet use it, each facet leaving
 * out the filters its own choice replaces (a kind choice clears the agent).
 */
export function mockAuditMatches(params: URLSearchParams, omit: readonly AuditFacet[] = []) {
  const get = (key: string) => params.get(key)?.trim() || undefined
  const use = (facet: AuditFacet) => !omit.includes(facet)
  const q = get("q")?.toLocaleLowerCase()
  const language = get("lang") as Language | undefined
  const codes = q && language ? auditCodesMatching(language, q) : { actions: [], entityTypes: [] }
  return (entry: AuditEntry) => {
    const kind = get("actorKind")
    if (kind && use("actorKind") && entry.actorKind !== kind) return false
    const agent = get("agent")
    if (agent && use("agent") && !(entry.actorKind === "agent" && entry.actorLabel === agent)) return false
    const action = get("action")
    if (action && use("action") && entry.action !== action) return false
    const projectId = get("projectId")
    if (projectId && use("projectId") && auditProject(entry) !== projectId) return false
    const itemId = get("itemId")
    if (itemId && !(entry.entityType === "item" && entry.entityId === itemId)) return false
    if (q) {
      const fields = [entry.action, entry.entityType, entry.actorLabel, auditName(entry)]
      const found =
        fields.some((field) => field.toLocaleLowerCase().includes(q)) ||
        codes.actions.includes(entry.action) ||
        codes.entityTypes.includes(entry.entityType)
      if (!found) return false
    }
    return true
  }
}

function auditAnswer(params: URLSearchParams): TransportResponse {
  const rows = state.audit.filter(mockAuditMatches(params))
  const cursor = params.get("cursor")
  const listed = page(rows, cursor, Number(params.get("limit") ?? 50))
  if (cursor) return listed
  const tally = <K extends string>(facet: AuditFacet[], key: (entry: AuditEntry) => K | null) => {
    const counts = new Map<K, number>()
    for (const entry of state.audit.filter(mockAuditMatches(params, facet))) {
      const value = key(entry)
      if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
  }
  const actorKind = Object.fromEntries(ACTOR_KINDS.map((kind) => [kind, 0])) as Record<ActorKind, number>
  for (const [kind, count] of tally(["actorKind", "agent"], (entry) => entry.actorKind)) actorKind[kind] = count
  const counts: AuditCounts = {
    actorKind,
    agents: tally(["agent"], (entry) => (entry.actorKind === "agent" ? entry.actorLabel : null)).map(
      ([label, count]) => ({ label, count }),
    ),
    actions: tally(["action"], (entry) => entry.action).map(([action, count]) => ({ action, count })),
    projects: tally(["projectId"], auditProject).map(([projectId, count]) => ({ projectId, count })),
  }
  return { status: 200, body: { ...(listed.body as object), total: rows.length, counts } }
}

function route(method: string, path: string, body: Record<string, unknown>): TransportResponse {
  const url = new URL(path, "http://mock.invalid")
  const parts = url.pathname.split("/").filter(Boolean)
  const [head, id, sub] = parts

  if (url.pathname === "/api/setup/status") return ok({ hasUser: true, session: "active" })
  if (head === "session" && method === "GET")
    return ok({
      actor: { kind: "owner", label: "owner" },
      via: "session",
      browserId: state.browserId,
      expiresAt: state.sessions[0]?.expiresAt ?? null,
    })
  if (head === "morning") return ok(morning())
  if (head === "visits") return ok({ at: new Date().toISOString(), previous: state.previousVisit }, 201)

  if (head === "projects" && !id && method === "GET")
    return ok(state.projects.map((p) => listEntry(p.id)).sort((a, b) => (a?.name ?? "").localeCompare(b?.name ?? "")))
  if (head === "projects" && !id && method === "POST") {
    const project = {
      ...state.projects[0],
      id: uuid(),
      name: String(body.name),
      slug: String(body.name).toLowerCase(),
      t3ProjectId: null,
      githubRepo: null,
      stage: null,
      whereWeAre: null,
      openIssuesCount: null,
      openIssuesAsOf: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    state.projects.push(project as MockState["projects"][number])
    record("project.create", "project", project.id, null, { name: project.name })
    return ok(project, 201)
  }
  if (head === "projects" && id) {
    const project = state.projects.find((entry) => entry.id === id)
    if (!project) return fail(404, "not_found", "The project does not exist.")
    if (sub === "stage-proposals") {
      const proposal = {
        id: uuid(),
        projectId: id,
        proposedStage: body.stage as Stage,
        reason: (body.reason as string) ?? null,
        authorKind: "owner" as const,
        authorLabel: "owner",
        state: "open" as const,
        createdAt: new Date().toISOString(),
        decidedAt: null,
      }
      state.proposals.push(proposal)
      return ok(proposal, 201)
    }
    if (method === "GET") {
      const line = securityLine(id)
      return ok({
        project,
        goal: goalProgress(id),
        pastGoals: state.goals.filter((goal) => goal.projectId === id && goal.closedAt),
        items: state.items
          .filter((item) => item.projectId === id)
          .map(summary)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        proposals: state.proposals.filter((proposal) => proposal.projectId === id),
        securitySources: state.sources.filter((source) => source.projectId === id),
        security: line,
      })
    }
    if (method === "PATCH") {
      const before = { name: project.name, stage: project.stage, whereWeAre: project.whereWeAre }
      if ("stage" in body) project.stage = body.stage as Stage | null
      if ("whereWeAre" in body) project.whereWeAre = (body.whereWeAre as string | null) || null
      if ("goal" in body) {
        for (const goal of state.goals)
          if (goal.projectId === id && !goal.closedAt) goal.closedAt = new Date().toISOString()
        if (body.goal)
          state.goals.push({
            id: uuid(),
            projectId: id,
            text: String(body.goal),
            createdAt: new Date().toISOString(),
            closedAt: null,
          })
      }
      project.updatedAt = new Date().toISOString()
      record("project.update", "project", id, before, {
        name: project.name,
        stage: project.stage,
        whereWeAre: project.whereWeAre,
      })
      return ok(project)
    }
    if (method === "DELETE") {
      if (state.items.some((item) => item.projectId === id))
        return fail(409, "conflict", "The project still has items.")
      state.projects = state.projects.filter((entry) => entry.id !== id)
      record("project.delete", "project", id, { name: project.name }, null)
      return { status: 204, body: null }
    }
  }
  if (head === "stage-proposals" && sub === "decision") {
    const proposal = state.proposals.find((entry) => entry.id === id)
    if (!proposal) return fail(404, "not_found", "The proposal does not exist.")
    if (proposal.state !== "open") return fail(409, "conflict", "The proposal was decided already.")
    proposal.state = body.decision === "accept" ? "accepted" : "rejected"
    proposal.decidedAt = new Date().toISOString()
    const project = state.projects.find((entry) => entry.id === proposal.projectId)
    if (project && proposal.state === "accepted") project.stage = proposal.proposedStage
    record(`proposal.${proposal.state === "accepted" ? "accept" : "reject"}`, "project", proposal.projectId, null, {
      name: project?.name,
      stage: proposal.proposedStage,
    })
    return ok({ proposal, project })
  }

  if (head === "items" && id) {
    const item = state.items.find((entry) => entry.id === id)
    if (!item) return fail(404, "not_found", "The item does not exist.")
    if (sub === "comments") {
      const comment = {
        id: uuid(),
        itemId: id,
        authorKind: "owner" as const,
        authorLabel: "owner",
        text: String(body.text),
        threadId: null,
        createdAt: new Date().toISOString(),
      }
      state.comments.push(comment)
      record("comment.create", "item", id, null, { title: item.title })
      return ok(comment, 201)
    }
    if (method === "GET") {
      const project = state.projects.find((entry) => entry.id === item.projectId)
      const goal = state.goals.find((entry) => entry.id === item.goalId) ?? null
      return ok({
        item,
        project: project ? { id: project.id, name: project.name, slug: project.slug, stage: project.stage } : null,
        goal,
        threads: state.threads.filter((thread) => thread.itemId === id),
        comments: state.comments.filter((comment) => comment.itemId === id),
        audit: state.audit.filter((entry) => entry.entityId === id).slice(0, 100),
      })
    }
    if (method === "PATCH") {
      if (body.version !== item.version) return fail(409, "version_conflict", "The item changed since you read it.")
      const before = {
        status: item.status,
        type: item.type,
        title: item.title,
        projectName: projectName(item.projectId),
      }
      const patch = { ...body }
      delete patch.version
      Object.assign(item, patch)
      if ("status" in patch) {
        item.statusSetBy = "owner"
        item.statusSetAt = new Date().toISOString()
        item.closedAt = isClosed(item.status) ? new Date().toISOString() : null
      }
      if ("type" in patch && item.type !== "security") item.severity = null
      if ("projectId" in patch && !("goalId" in patch)) item.goalId = null
      item.version++
      item.updatedAt = new Date().toISOString()
      record("item.update", "item", id, before, {
        status: item.status,
        type: item.type,
        title: item.title,
        projectName: projectName(item.projectId),
      })
      return ok(item)
    }
    if (method === "DELETE") {
      state.items = state.items.filter((entry) => entry.id !== id)
      record("item.delete", "item", id, { title: item.title }, null)
      return { status: 204, body: null }
    }
  }
  if (head === "capture") {
    const text = String(body.text ?? "")
    const [first, ...rest] = text.split("\n")
    const item: Item = {
      id: uuid(),
      projectId: (body.projectId as string | null) ?? null,
      type: "idea",
      status: "future",
      title: (first ?? "").slice(0, 300),
      body: rest.length ? text : null,
      severity: null,
      goalId: null,
      version: 1,
      statusSetBy: "owner",
      statusSetAt: new Date().toISOString(),
      createdBy: "owner",
      imported: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
    }
    state.items.unshift(item)
    record("item.create", "item", item.id, null, { title: item.title })
    return ok(item, 201)
  }
  if (head === "inbox") return ok(state.items.filter((item) => !item.projectId && !isClosed(item.status)).map(summary))
  if (head === "archive") {
    const closed = state.items
      .filter((item) => isClosed(item.status))
      .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
    return page(closed.map(summary), url.searchParams.get("cursor"), Number(url.searchParams.get("limit") ?? 50))
  }
  if (head === "audit") return auditAnswer(url.searchParams)
  if (head === "sync" && id === "runs")
    return ok([
      {
        id: uuid(),
        kind: "t3",
        startedAt: ago(27.1),
        finishedAt: ago(27),
        outcome: "partial",
        counts: { itemsUpdated: 4 },
        errors: [{ record: "thread:thr_x", code: "conflict" }],
      },
    ])
  if (head === "settings" && method === "GET") return ok(state.settings)
  if (head === "settings" && method === "PATCH") {
    const before = { ...state.settings }
    const { telegramBotToken, telegramChatId, privateDomains, ...plain } = body
    // A field the environment sets is refused, as the server does (setting_locked names the variable).
    const lockedBy = [
      telegramBotToken !== undefined ? state.settings.telegram.botToken.variable : null,
      telegramChatId !== undefined ? state.settings.telegram.chatId.variable : null,
      privateDomains !== undefined ? state.settings.privateDomains.variable : null,
    ].find((variable) => variable !== null)
    if (lockedBy)
      return {
        status: 409,
        body: {
          error: {
            code: "setting_locked",
            message: `The environment variable ${lockedBy} sets this. Change it there and restart Mikud.`,
            details: { variable: lockedBy },
          },
        },
      }
    Object.assign(state.settings, plain, { updatedAt: new Date().toISOString() })
    const tg = state.settings.telegram
    if (telegramBotToken !== undefined) tg.botToken = { ...tg.botToken, set: telegramBotToken !== null, readable: true }
    if (telegramChatId !== undefined) tg.chatId = { ...tg.chatId, value: (telegramChatId as string | null) ?? null }
    tg.missing = [...(tg.botToken.set ? [] : ["botToken" as const]), ...(tg.chatId.value ? [] : ["chatId" as const])]
    tg.state = tg.missing.length === 0 ? "on" : tg.missing.length === 2 ? "off" : "incomplete"
    if (tg.state === "off") tg.missing = []
    if (privateDomains !== undefined) state.settings.privateDomains.value = privateDomains as string[]
    record("settings.update", "settings", state.settings.id, before, { ...state.settings })
    return ok(state.settings)
  }
  if (head === "telegram" && id === "test-message" && method === "POST") return ok({ sent: true })
  if (head === "telegram")
    return ok({
      configured: true,
      polling: true,
      lastUpdateAt: ago(16),
      lastMorning: { localDate: ago(8).slice(0, 10), state: "sent", at: ago(8) },
    })
  if (head === "suppressions" && !id) return ok(state.suppressions)
  if (head === "suppressions" && method === "DELETE") {
    state.suppressions = state.suppressions.filter((entry) => entry.id !== id)
    return { status: 204, body: null }
  }
  return fail(404, "not_found", "Nothing is here.")
}

export async function mockTransport({ method, path, body }: TransportRequest): Promise<TransportResponse> {
  await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
  return structuredClone(route(method, path, (body ?? {}) as Record<string, unknown>))
}
