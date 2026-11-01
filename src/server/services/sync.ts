import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm"
import type { SecuritySnapshot, T3Snapshot } from "../../shared/api.ts"
import { items, itemThreads, projects, securitySources, suppressions, syncRuns } from "../db/schema.ts"
import { AppError } from "../errors.ts"
import { log } from "../log.ts"
import { type By, type Ctx, inTx, writeAudit } from "./context.ts"
import { createItemTx, type ItemRow, type ThreadLinkRow, updateItemTx } from "./items.ts"
import { createProjectTx } from "./projects.ts"
import { newItemStatus, rootThreadId, syncDecision, wantsItem } from "./sync-rules.ts"

export type SyncRunRow = typeof syncRuns.$inferSelect

export type SyncResult = {
  runId: string
  outcome: "succeeded" | "partial" | "failed"
  counts: Record<string, number>
  errors: { record: string; code: string }[]
}

const SYNC: By = { actor: { kind: "sync", label: "sync" }, source: "sync" }
const SUCCESSFUL = ["succeeded", "partial"] as const

/** Collects per-record results: a failing record is recorded and never stops the run. */
class Run {
  readonly counts: Record<string, number> = {}
  readonly errors: { record: string; code: string }[] = []
  private attempted = 0
  private failed = 0

  constructor(readonly kind: string) {}

  add(name: string, by = 1) {
    this.counts[name] = (this.counts[name] ?? 0) + by
  }

  async record(name: string, work: () => Promise<void>) {
    this.attempted++
    try {
      await work()
    } catch (error) {
      this.failed++
      const code = error instanceof AppError ? error.code : "internal_error"
      this.errors.push({ record: name, code })
      // The record's name is an id; its text (titles) is never logged.
      log.warn("sync record failed", {
        kind: this.kind,
        record: name,
        code,
        error: error instanceof AppError ? undefined : String(error),
      })
    }
  }

  get outcome(): SyncResult["outcome"] {
    if (this.failed === 0) return "succeeded"
    return this.failed === this.attempted ? "failed" : "partial"
  }
}

async function startRun(ctx: Ctx, kind: string): Promise<string> {
  const [row] = await ctx.db.insert(syncRuns).values({ kind, startedAt: ctx.clock() }).returning({ id: syncRuns.id })
  if (!row) throw new Error("insert returned no row")
  return row.id
}

async function finishRun(ctx: Ctx, id: string, run: Run): Promise<SyncResult> {
  const outcome = run.outcome
  await ctx.db
    .update(syncRuns)
    .set({ finishedAt: ctx.clock(), outcome, counts: run.counts, errors: run.errors })
    .where(eq(syncRuns.id, id))
  return { runId: id, outcome, counts: run.counts, errors: run.errors }
}

/** Marks a run that stopped on an unexpected error as failed, then rethrows. */
async function guarded(ctx: Ctx, id: string, run: Run, work: () => Promise<void>): Promise<SyncResult> {
  try {
    await work()
  } catch (error) {
    await ctx.db
      .update(syncRuns)
      .set({
        finishedAt: ctx.clock(),
        outcome: "failed",
        counts: run.counts,
        errors: [...run.errors, { record: "run", code: "internal_error" }],
      })
      .where(eq(syncRuns.id, id))
      .catch(() => {})
    throw error
  }
  return finishRun(ctx, id, run)
}

export type ApplyHooks = {
  /** Test seam: runs after the item states were read and before any change is applied. */
  beforeApply?: () => Promise<void>
}

/**
 * Applies a full T3 snapshot (every top-level thread of every project): projects, missing items, thread
 * links, then the per-item status decision. Idempotent; keeps no boundary between runs.
 */
export async function applyT3Snapshot(ctx: Ctx, snapshot: T3Snapshot, hooks: ApplyHooks = {}): Promise<SyncResult> {
  const runId = await startRun(ctx, "t3")
  const run = new Run("t3")
  return guarded(ctx, runId, run, async () => {
    const [previous] = await ctx.db
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(and(eq(syncRuns.kind, "t3"), inArray(syncRuns.outcome, SUCCESSFUL)))
      .limit(1)
    const firstRun = !previous

    const suppressed = await loadSuppressions(ctx)
    const projectIds = new Map<string, string>()

    // 1. Projects: upsert by T3 project id, except those the owner deleted.
    for (const p of snapshot.projects) {
      await run.record(`project:${p.t3ProjectId}`, async () => {
        if (suppressed.project.has(p.t3ProjectId)) return run.add("projectsSuppressed")
        await inTx(ctx, async (tx) => {
          const [existing] = await tx
            .select()
            .from(projects)
            .where(eq(projects.t3ProjectId, p.t3ProjectId))
            .for("update")
          if (existing) {
            projectIds.set(p.t3ProjectId, existing.id)
            // The owner names projects in Mikud; the sync only fills a missing repository.
            if (p.repo && !existing.githubRepo) {
              const [after] = await tx
                .update(projects)
                .set({ githubRepo: p.repo, updatedAt: ctx.clock() })
                .where(eq(projects.id, existing.id))
                .returning()
              await writeAudit(ctx, tx, SYNC, {
                action: "project.update",
                entityType: "project",
                entityId: existing.id,
                before: existing,
                after,
              })
              run.add("projectsUpdated")
            }
            return
          }
          const name = ctx.secrets.redact(p.title).trim() || p.t3ProjectId
          const created = await createProjectTx(ctx, tx, SYNC, {
            name,
            t3ProjectId: p.t3ProjectId,
            githubRepo: p.repo ?? null,
          })
          projectIds.set(p.t3ProjectId, created.id)
          run.add("projectsCreated")
        })
      })
    }
    for (const row of await ctx.db
      .select({ id: projects.id, t3: projects.t3ProjectId })
      .from(projects)
      .where(isNotNull(projects.t3ProjectId))) {
      if (row.t3 && !projectIds.has(row.t3)) projectIds.set(row.t3, row.id)
    }

    // 2. Threads. A child thread never has its own item: its link folds into the top-level thread.
    const parentOf = new Map(snapshot.threads.map((t) => [t.threadId, t.parentThreadId ?? null]))
    const byId = new Map(snapshot.threads.map((t) => [t.threadId, t]))
    for (const thread of snapshot.threads) {
      if (!thread.parentThreadId) continue
      await run.record(`thread:${thread.threadId}`, async () => {
        const root = rootThreadId(thread.threadId, parentOf)
        if (root) await foldChildLink(ctx, run, thread.threadId, root, byId.get(root))
      })
    }

    for (const thread of snapshot.threads) {
      if (thread.parentThreadId) continue
      await run.record(`thread:${thread.threadId}`, async () => {
        const title = ctx.secrets.redact(thread.title).trim()
        await inTx(ctx, async (tx) => {
          const [link] = await tx
            .select()
            .from(itemThreads)
            .where(eq(itemThreads.threadId, thread.threadId))
            .for("update")
          const fields = {
            t3ProjectId: thread.t3ProjectId,
            title: title || null,
            lastStatus: thread.status,
            settled: thread.settled,
            lastActivityAt: thread.updatedAt,
          }
          if (link) {
            if (!linkChanged(link, fields)) return
            const [after] = await tx.update(itemThreads).set(fields).where(eq(itemThreads.id, link.id)).returning()
            await writeAudit(ctx, tx, SYNC, {
              action: "thread.update",
              entityType: "item",
              entityId: link.itemId,
              before: link,
              after,
            })
            return run.add("threadsUpdated")
          }
          if (suppressed.thread.has(thread.threadId)) return run.add("threadsSuppressed")
          if (thread.t3ProjectId && suppressed.project.has(thread.t3ProjectId)) return run.add("threadsSuppressed")
          if (!wantsItem(thread, snapshot.collectedAt)) return run.add("threadsTooOld")

          const item = await createItemTx(
            ctx,
            tx,
            SYNC,
            {
              projectId: thread.t3ProjectId ? (projectIds.get(thread.t3ProjectId) ?? null) : null,
              type: "task",
              status: newItemStatus(thread),
              title: title || "Untitled T3 thread",
            },
            { imported: firstRun },
          )
          const [inserted] = await tx
            .insert(itemThreads)
            .values({ itemId: item.id, threadId: thread.threadId, linkedAt: ctx.clock(), ...fields })
            .onConflictDoNothing({ target: itemThreads.threadId })
            .returning()
          // An agent linked the thread at the same moment: roll this item back; the next run sees the link.
          if (!inserted) throw new AppError("conflict", "The thread was linked at the same time.")
          await writeAudit(ctx, tx, SYNC, {
            action: "thread.link",
            entityType: "item",
            entityId: item.id,
            after: inserted,
          })
          run.add("itemsCreated")
        })
      })
    }

    // 3. Read every item with a linked thread, and decide its status over all of its threads.
    const rows = await ctx.db
      .select({ item: items, link: itemThreads })
      .from(items)
      .innerJoin(itemThreads, eq(itemThreads.itemId, items.id))
    const grouped = new Map<string, { item: ItemRow; links: ThreadLinkRow[] }>()
    for (const { item, link } of rows) {
      const entry = grouped.get(item.id) ?? { item, links: [] }
      entry.links.push(link)
      grouped.set(item.id, entry)
    }
    const decisions = [...grouped.values()]
      .map(({ item, links }) => ({ item, target: syncDecision(item, links) }))
      .filter((d) => d.target !== null)

    await hooks.beforeApply?.()

    // 4. Apply each decision as a compare-and-set on the version read in step 3.
    for (const { item, target } of decisions) {
      if (!target) continue
      await run.record(`item:${item.id}`, async () => {
        try {
          await inTx(ctx, (tx) => updateItemTx(ctx, tx, SYNC, item.id, item.version, { status: target }))
          run.add("itemsUpdated")
        } catch (error) {
          // Changed since the read (the owner, an agent) or deleted: decided again on the next run.
          if (error instanceof AppError && (error.code === "version_conflict" || error.code === "not_found"))
            return run.add("itemsSkipped")
          throw error
        }
      })
    }
  })
}

function linkChanged(link: ThreadLinkRow, next: Partial<ThreadLinkRow>): boolean {
  return (
    link.t3ProjectId !== next.t3ProjectId ||
    link.title !== next.title ||
    link.lastStatus !== next.lastStatus ||
    link.settled !== next.settled ||
    link.lastActivityAt?.getTime() !== next.lastActivityAt?.getTime()
  )
}

/**
 * A link on a child thread moves to the top-level thread: when the root has its own link, the child's
 * link goes; otherwise the link is re-pointed at the root thread.
 */
async function foldChildLink(
  ctx: Ctx,
  run: Run,
  childId: string,
  rootId: string,
  root: T3Snapshot["threads"][number] | undefined,
) {
  await inTx(ctx, async (tx) => {
    const [child] = await tx.select().from(itemThreads).where(eq(itemThreads.threadId, childId)).for("update")
    if (!child) return
    const [rootLink] = await tx.select().from(itemThreads).where(eq(itemThreads.threadId, rootId))
    if (rootLink) {
      await tx.delete(itemThreads).where(eq(itemThreads.id, child.id))
      await writeAudit(ctx, tx, SYNC, {
        action: "thread.unlink",
        entityType: "item",
        entityId: child.itemId,
        before: child,
        after: { foldedInto: rootId, itemId: rootLink.itemId },
      })
    } else {
      const [after] = await tx
        .update(itemThreads)
        .set({
          threadId: rootId,
          ...(root && {
            t3ProjectId: root.t3ProjectId,
            title: ctx.secrets.redact(root.title).trim() || null,
            lastStatus: root.status,
            settled: root.settled,
            lastActivityAt: root.updatedAt,
          }),
        })
        .where(eq(itemThreads.id, child.id))
        .returning()
      await writeAudit(ctx, tx, SYNC, {
        action: "thread.move",
        entityType: "item",
        entityId: child.itemId,
        before: child,
        after,
      })
    }
    run.add("childLinksFolded")
  })
}

async function loadSuppressions(ctx: Ctx) {
  const rows = await ctx.db.select().from(suppressions)
  return {
    thread: new Set(rows.filter((r) => r.kind === "thread").map((r) => r.externalId)),
    project: new Set(rows.filter((r) => r.kind === "project").map((r) => r.externalId)),
  }
}

/**
 * Applies the security and Issues counts the overview collector gathered, per GitHub repository, to every
 * project linked to that repository. Families missing from the snapshot keep their last values.
 */
export async function applySecuritySnapshot(ctx: Ctx, snapshot: SecuritySnapshot): Promise<SyncResult> {
  const runId = await startRun(ctx, "security")
  const run = new Run("security")
  return guarded(ctx, runId, run, async () => {
    for (const repo of snapshot.repos) {
      await run.record(`repo:${repo.repo}`, async () => {
        const matches = await ctx.db
          .select({ id: projects.id })
          .from(projects)
          .where(sql`lower(${projects.githubRepo}) = ${repo.repo.toLowerCase()}`)
        if (matches.length === 0) return run.add("reposUnmatched")
        for (const { id } of matches) {
          await inTx(ctx, async (tx) => {
            const [project] = await tx.select().from(projects).where(eq(projects.id, id)).for("update")
            if (!project) return
            const sourcesBefore = await tx.select().from(securitySources).where(eq(securitySources.projectId, id))
            const now = ctx.clock()
            let changed = false
            if (
              project.openIssuesCount !== repo.openIssues ||
              project.openIssuesAsOf?.getTime() !== repo.issuesAsOf?.getTime()
            ) {
              await tx
                .update(projects)
                .set({ openIssuesCount: repo.openIssues, openIssuesAsOf: repo.issuesAsOf, updatedAt: now })
                .where(eq(projects.id, id))
              changed = true
            }
            for (const f of repo.families) {
              const old = sourcesBefore.find((s) => s.family === f.family)
              const values = { coverage: f.coverage, ...f.counts, asOf: f.asOf }
              if (
                old &&
                old.coverage === values.coverage &&
                old.critical === values.critical &&
                old.high === values.high &&
                old.medium === values.medium &&
                old.low === values.low &&
                old.asOf?.getTime() === values.asOf?.getTime()
              )
                continue
              await tx
                .insert(securitySources)
                .values({ projectId: id, family: f.family, ...values, updatedAt: now })
                .onConflictDoUpdate({
                  target: [securitySources.projectId, securitySources.family],
                  set: { ...values, updatedAt: now },
                })
              changed = true
            }
            if (!changed) return
            const sourcesAfter = await tx.select().from(securitySources).where(eq(securitySources.projectId, id))
            await writeAudit(ctx, tx, SYNC, {
              action: "security.update",
              entityType: "project",
              entityId: id,
              before: {
                openIssuesCount: project.openIssuesCount,
                openIssuesAsOf: project.openIssuesAsOf,
                sources: sourcesBefore,
              },
              after: { openIssuesCount: repo.openIssues, openIssuesAsOf: repo.issuesAsOf, sources: sourcesAfter },
            })
            run.add("projectsUpdated")
          })
        }
      })
    }
  })
}

/** The latest runs, newest first. */
export function recentSyncRuns(ctx: Ctx, limit = 20): Promise<SyncRunRow[]> {
  return ctx.db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(limit)
}
