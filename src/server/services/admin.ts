import { and, desc, eq, lt } from "drizzle-orm"
import type { Language } from "../../shared/enums.ts"
import { VISIT_SAFETY_MARGIN_MS } from "../db/client.ts"
import { settings, suppressions, visits } from "../db/schema.ts"
import { invalid, notFound } from "../errors.ts"
import { type By, type Ctx, type DbOrTx, inLinkTx, inTx, requireOwner, writeAudit } from "./context.ts"

export type SettingsRow = typeof settings.$inferSelect
export type SuppressionRow = typeof suppressions.$inferSelect

// --- Settings (a single row, created on first read) ---

export async function getSettings(db: DbOrTx): Promise<SettingsRow> {
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing()
  const [row] = await db.select().from(settings).where(eq(settings.id, 1))
  if (!row) throw new Error("settings row missing")
  return row
}

export type SettingsPatch = {
  closedItemDays?: number
  dateFormat?: string
  timeFormat?: string
  language?: Language
  sessionMaxDays?: number
  sessionIdle?: boolean
  sessionIdleMinutes?: number
}

export async function updateSettings(ctx: Ctx, by: By, patch: SettingsPatch): Promise<SettingsRow> {
  requireOwner(by, "change settings")
  if (patch.closedItemDays !== undefined && !(patch.closedItemDays >= 1 && patch.closedItemDays <= 365))
    throw invalid("closedItemDays must be between 1 and 365.")
  return inTx(ctx, async (tx) => {
    const before = await getSettings(tx)
    const [after] = await tx
      .update(settings)
      .set({ ...patch, updatedAt: ctx.clock() })
      .where(eq(settings.id, 1))
      .returning()
    await writeAudit(ctx, tx, by, { action: "settings.update", entityType: "settings", entityId: "1", before, after })
    return after ?? before
  })
}

// --- Suppressions ---

export async function listSuppressions(ctx: Ctx, by: By): Promise<SuppressionRow[]> {
  requireOwner(by, "see suppressions")
  return ctx.db.select().from(suppressions).orderBy(desc(suppressions.createdAt))
}

/** Owner only. The sync may then recreate the item or project on its next run. */
export async function removeSuppression(ctx: Ctx, by: By, id: string): Promise<void> {
  requireOwner(by, "remove suppressions")
  return inLinkTx(ctx, async (tx) => {
    const [before] = await tx.delete(suppressions).where(eq(suppressions.id, id)).returning()
    if (!before) throw notFound("The suppression")
    await writeAudit(ctx, tx, by, { action: "suppression.delete", entityType: "suppression", entityId: id, before })
  })
}

// --- Visits ("new since your last visit", per browser: the mikud_browser cookie names a devices row) ---

export const FIRST_VISIT_WINDOW_MS = 24 * 60 * 60 * 1000

/** The browser's previous visit before now, or 24 hours ago on its first visit (and without a browser). */
export async function previousVisit(ctx: Ctx, deviceId: string | null | undefined): Promise<Date> {
  const now = ctx.clock()
  if (deviceId) {
    const [row] = await ctx.db
      .select({ at: visits.at })
      .from(visits)
      .where(and(eq(visits.deviceId, deviceId), lt(visits.at, now)))
      .orderBy(desc(visits.at))
      .limit(1)
    if (row) return row.at
  }
  return new Date(now.getTime() - FIRST_VISIT_WINDOW_MS)
}

/** The owner's latest visit in any browser before now, or null when there is none. */
export async function lastVisitAnyDevice(ctx: Ctx): Promise<Date | null> {
  const [row] = await ctx.db
    .select({ at: visits.at })
    .from(visits)
    .where(lt(visits.at, ctx.clock()))
    .orderBy(desc(visits.at))
    .limit(1)
  return row?.at ?? null
}

/**
 * Records that the owner saw the board in this browser: VISIT_SAFETY_MARGIN_MS before the start of the read that
 * was shown (never later than now; now when it is not given), so a write that committed after that read
 * still counts as new (see the invariant in db/client.ts). Bookkeeping, not a change: no audit row.
 */
export async function recordVisit(ctx: Ctx, deviceId: string, shownAt?: Date): Promise<Date> {
  const now = ctx.clock()
  const readAt = shownAt && shownAt.getTime() < now.getTime() ? shownAt : now
  const at = new Date(readAt.getTime() - VISIT_SAFETY_MARGIN_MS)
  await ctx.db.insert(visits).values({ deviceId, at })
  return at
}
