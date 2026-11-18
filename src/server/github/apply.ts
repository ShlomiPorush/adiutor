import { randomUUID } from "node:crypto"
import { asc, eq, inArray, type SQL, sql } from "drizzle-orm"
import type { SyncOutcome } from "../../shared/enums.ts"
import { audit, projects, securitySources, settings, syncRuns } from "../db/schema.ts"
import { getSettings } from "../services/admin.ts"
import type { By, Ctx } from "../services/context.ts"
import { lockGitHubShared } from "./gate.ts"
import { ALERT_FAMILIES, type AlertFamily, type FamilyRead, type PullRead } from "./pull.ts"

// A pull's writes, in one short transaction: under the shared GitHub lock and only for the generation the pull read
// under; projects locked in id order and skipped when their repository changed since the read; the sources and the
// Issues counts written set-based; the audit rows inserted in one statement; and the pull's run row last. Any failure
// writes nothing.

/** The server's own pull, in the audit log. */
export const GITHUB_PULL: By = { actor: { kind: "system", label: "github" }, source: "github" }
/** Run rows of the server's pulls (`sync_runs.kind`); the PC's are `t3` and `security`. */
export const GITHUB_RUN_KIND = "github"
/** A write waits at most this long for a lock (a project row the owner is changing): the next pull tries again. */
const LOCK_TIMEOUT = "5s"
/**
 * Rows per statement: PostgreSQL takes at most 65,535 parameters in one statement, and a source row has 12, so a pull
 * of many projects writes in batches, all in the one transaction.
 */
const BATCH = 500
const batches = <T>(rows: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(rows.length / BATCH) }, (_, i) => rows.slice(i * BATCH, (i + 1) * BATCH))
/** A run row keeps at most this many errors. */
const MAX_ERRORS = 500

type SourceRow = typeof securitySources.$inferSelect
type ProjectRow = typeof projects.$inferSelect

export type ApplyResult =
  | { written: false }
  | {
      written: true
      runId: string
      outcome: SyncOutcome
      counts: Record<string, number>
      errors: { record: string; code: string }[]
    }

const plain = (value: unknown) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))
const time = (d: Date | null | undefined) => d?.getTime() ?? null

/** The source row a family read leaves: a definite result replaces the stored one; an error keeps it. */
function nextSource(projectId: string, family: AlertFamily, read: FamilyRead, old: SourceRow | undefined, now: Date) {
  if (read.coverage === "error")
    return old
      ? { ...old, attemptedAt: now, attempt: "error" as const, updatedAt: now }
      : {
          id: randomUUID(),
          projectId,
          family,
          coverage: "error" as const,
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          asOf: null,
          origin: "github" as const,
          attemptedAt: now,
          attempt: "error" as const,
          updatedAt: now,
        }
  const counts = read.coverage === "enabled" ? read.counts : { critical: 0, high: 0, medium: 0, low: 0 }
  return {
    id: old?.id ?? randomUUID(),
    projectId,
    family,
    coverage: read.coverage,
    ...counts,
    asOf: read.asOf,
    origin: "github" as const,
    attemptedAt: now,
    attempt: "ok" as const,
    updatedAt: now,
  }
}

const sameResult = (a: SourceRow | undefined, b: ReturnType<typeof nextSource>) =>
  a !== undefined &&
  a.coverage === b.coverage &&
  a.critical === b.critical &&
  a.high === b.high &&
  a.medium === b.medium &&
  a.low === b.low

/**
 * How a pull ended: `succeeded` when every allowed installation was read in full or is definitely not usable and no
 * read failed, `failed` when nothing could be read, `partial` otherwise.
 */
export function pullOutcome(read: PullRead, skipped: number): SyncOutcome {
  const installationsKnown = read.installations.every(
    (i) => (i.state === "usable" && i.inventory?.complete === true) || (i.state !== "usable" && i.state !== "error"),
  )
  const reads = read.projects.flatMap((p) => [
    ...ALERT_FAMILIES.map((f) => p.families[f].coverage !== "error"),
    p.issues.kind !== "error",
  ])
  const anyRead = reads.some(Boolean) || read.installations.some((i) => i.state !== "error")
  if (!anyRead) return "failed"
  if (installationsKnown && reads.every(Boolean) && skipped === 0 && read.stopped === null) return "succeeded"
  return "partial"
}

/** The run's errors: each installation not read, each read that failed, each project skipped. */
function runErrors(read: PullRead, skipped: string[]) {
  const errors: { record: string; code: string }[] = []
  if (read.stopped?.kind === "rate_limit") errors.push({ record: "pull", code: "rate_limited" })
  for (const i of read.installations)
    if (i.state !== "usable")
      errors.push({ record: `installation:${i.id}`, code: i.state === "error" ? (i.code ?? "error") : i.state })
    else if (i.inventory && !i.inventory.complete)
      errors.push({ record: `installation:${i.id}`, code: i.code ?? "inventory_incomplete" })
  for (const p of read.projects) {
    for (const family of ALERT_FAMILIES) {
      const f = p.families[family]
      if (f.coverage === "error") errors.push({ record: `project:${p.projectId}:${family}`, code: f.code })
    }
    if (p.issues.kind === "error") errors.push({ record: `project:${p.projectId}:issues`, code: p.issues.code })
  }
  for (const id of skipped) errors.push({ record: `project:${id}`, code: "changed" })
  return errors.slice(0, MAX_ERRORS)
}

export type ApplyInput = {
  read: PullRead
  generation: number
  startedAt: Date
  /** The key the pull used is the stored one (not the environment's): GitHub's answer marks it verified or not. */
  keyStored: boolean
  /** Test seam: runs inside the transaction once it holds the shared GitHub lock and checked the generation. */
  afterLock?: () => Promise<void>
}

export async function applyPull(ctx: Ctx, input: ApplyInput): Promise<ApplyResult> {
  const { read, generation, startedAt } = input
  // Created before the transaction, which only reads it (the read-only morning read relies on the same).
  await getSettings(ctx.db)
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local lock_timeout = '${LOCK_TIMEOUT}'`))
    await lockGitHubShared(tx)
    const [stored] = await tx
      .select({ generation: settings.githubGeneration, verified: settings.githubKeyVerified })
      .from(settings)
      .where(eq(settings.id, 1))
    if (!stored || stored.generation !== generation) return { written: false } as const
    await input.afterLock?.()

    const now = ctx.clock()
    const ids = [...new Set(read.projects.map((p) => p.projectId))].sort()
    const locked: ProjectRow[] =
      ids.length === 0
        ? []
        : await tx
            .select()
            .from(projects)
            .where(inArray(projects.id, ids))
            .orderBy(asc(projects.id))
            .for("no key update")
    const current = new Map(locked.map((p) => [p.id, p]))
    const skipped: string[] = []
    const reads = read.projects.filter((p) => {
      const row = current.get(p.projectId)
      // Deleted, or its repository changed since the read (an A to B to A change too): written by the next pull.
      if (!row || row.githubRepoVersion !== p.version) {
        if (row) skipped.push(p.projectId)
        return false
      }
      return true
    })
    const writeIds = reads.map((p) => p.projectId)
    const before =
      writeIds.length === 0
        ? []
        : await tx.select().from(securitySources).where(inArray(securitySources.projectId, writeIds))

    const sourceRows: ReturnType<typeof nextSource>[] = []
    const issueCases: {
      id: string
      count: number | null
      asOf: Date | null
      origin: "push" | "github"
      repoId: number | null
    }[] = []
    const audits: (typeof audit.$inferInsert)[] = []
    const timeOnly: unknown[] = []
    const attempts: unknown[] = []
    for (const p of reads) {
      const row = current.get(p.projectId) as ProjectRow
      const old = before.filter((s) => s.projectId === p.projectId)
      let real = false
      const next = ALERT_FAMILIES.map((family) => {
        const prior = old.find((s) => s.family === family)
        const source = nextSource(p.projectId, family, p.families[family], prior, now)
        const result = p.families[family]
        attempts.push({
          projectId: p.projectId,
          family,
          attempt: source.attempt,
          ...(result.coverage === "error" ? { code: result.code } : {}),
        })
        if (result.coverage !== "error" && !sameResult(prior, source)) real = true
        else if (
          result.coverage !== "error" &&
          (time(prior?.asOf) !== time(source.asOf) || prior?.origin !== source.origin)
        )
          timeOnly.push({ projectId: p.projectId, family, from: prior?.asOf ?? null, to: source.asOf })
        return source
      })
      sourceRows.push(...next)

      let issues = { openIssuesCount: row.openIssuesCount, openIssuesAsOf: row.openIssuesAsOf }
      let issuesChanged = false
      if (p.issues.kind !== "error") {
        const count = p.issues.kind === "count" ? p.issues.count : null
        issues = { openIssuesCount: count, openIssuesAsOf: p.issues.asOf }
        issuesChanged = true
        if (count !== row.openIssuesCount) real = true
        else timeOnly.push({ projectId: p.projectId, family: "issues", from: row.openIssuesAsOf, to: p.issues.asOf })
      }
      attempts.push({
        projectId: p.projectId,
        family: "issues",
        attempt: p.issues.kind === "error" ? "error" : "ok",
        ...(p.issues.kind === "error" ? { code: p.issues.code } : {}),
      })
      const repoId = p.repoId !== null && p.repoId !== row.githubRepoId ? p.repoId : null
      if (issuesChanged || repoId !== null)
        issueCases.push({
          id: p.projectId,
          count: issues.openIssuesCount,
          asOf: issues.openIssuesAsOf,
          origin: issuesChanged ? "github" : row.openIssuesOrigin,
          repoId: repoId ?? row.githubRepoId,
        })
      if (real)
        audits.push({
          at: now,
          actorKind: GITHUB_PULL.actor.kind,
          actorLabel: GITHUB_PULL.actor.label,
          source: GITHUB_PULL.source,
          action: "security.update",
          entityType: "project",
          entityId: p.projectId,
          before: plain({ openIssuesCount: row.openIssuesCount, openIssuesAsOf: row.openIssuesAsOf, sources: old }),
          after: plain({ ...issues, sources: next }),
        })
    }

    const excluded = (column: string) => sql.raw(`excluded."${column}"`)
    for (const rows of batches(sourceRows)) {
      await tx
        .insert(securitySources)
        .values(rows)
        .onConflictDoUpdate({
          target: [securitySources.projectId, securitySources.family],
          set: {
            coverage: excluded("coverage"),
            critical: excluded("critical"),
            high: excluded("high"),
            medium: excluded("medium"),
            low: excluded("low"),
            asOf: excluded("as_of"),
            origin: excluded("origin"),
            attemptedAt: excluded("attempted_at"),
            attempt: excluded("attempt"),
            updatedAt: excluded("updated_at"),
          },
        })
    }
    for (const cases of batches(issueCases)) {
      const when = (value: (c: (typeof issueCases)[number]) => SQL) =>
        sql.join(
          [sql`case ${projects.id}`, ...cases.map((c) => sql`when ${c.id}::uuid then ${value(c)}`), sql`end`],
          sql` `,
        )
      await tx
        .update(projects)
        .set({
          openIssuesCount: when((c) => sql`${c.count}::integer`),
          openIssuesAsOf: when((c) => sql`${c.asOf?.toISOString() ?? null}::timestamptz`),
          openIssuesOrigin: when((c) => sql`${c.origin}::text`),
          githubRepoId: when((c) => sql`${c.repoId}::bigint`),
        })
        .where(
          inArray(
            projects.id,
            cases.map((c) => c.id),
          ),
        )
    }

    if (input.keyStored && read.keyAccepted !== null && read.keyAccepted !== stored.verified)
      await tx.update(settings).set({ githubKeyVerified: read.keyAccepted }).where(eq(settings.id, 1))

    const outcome = pullOutcome(read, skipped.length)
    const errors = runErrors(read, skipped)
    const counts: Record<string, number> = {
      installations: read.installations.length,
      installationsRead: read.installations.filter((i) => i.state === "usable" && i.inventory?.complete).length,
      projects: read.projects.length,
      projectsWritten: reads.length,
      projectsSkipped: skipped.length,
      projectsChanged: audits.length,
    }
    for (const coverage of ["enabled", "not_enabled", "no_access", "error"] as const)
      counts[coverage] = read.projects.reduce(
        (n, p) => n + ALERT_FAMILIES.filter((f) => p.families[f].coverage === coverage).length,
        0,
      )
    const runId = randomUUID()
    await tx
      .insert(syncRuns)
      .values({ id: runId, kind: GITHUB_RUN_KIND, startedAt, finishedAt: now, outcome, counts, errors })
    audits.push({
      at: now,
      actorKind: GITHUB_PULL.actor.kind,
      actorLabel: GITHUB_PULL.actor.label,
      source: GITHUB_PULL.source,
      action: "security.pull",
      entityType: "github",
      entityId: runId,
      before: null,
      after: plain({ outcome, counts, timeOnly, attempts, skipped }),
    })
    for (const rows of batches(audits)) await tx.insert(audit).values(rows)
    return { written: true, runId, outcome, counts, errors } as const
  })
}
