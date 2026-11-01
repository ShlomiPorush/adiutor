import { createHash, randomBytes } from "node:crypto"
import { and, desc, eq, isNull, lt } from "drizzle-orm"
import type { Language } from "../../shared/enums.ts"
import { devices, settings, suppressions, visits } from "../db/schema.ts"
import { invalid, notFound } from "../errors.ts"
import { type By, type Ctx, type DbOrTx, inTx, requireOwner, writeAudit } from "./context.ts"

export type SettingsRow = typeof settings.$inferSelect
export type DeviceRow = typeof devices.$inferSelect
export type SuppressionRow = typeof suppressions.$inferSelect

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

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
  return inTx(ctx, async (tx) => {
    const [before] = await tx.delete(suppressions).where(eq(suppressions.id, id)).returning()
    if (!before) throw notFound("The suppression")
    await writeAudit(ctx, tx, by, { action: "suppression.delete", entityType: "suppression", entityId: id, before })
  })
}

// --- Devices (paired browsers) ---

/** What a device looks like to clients: never its hash. */
export function publicDevice(row: DeviceRow) {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
  }
}

/** Creates a device and returns its secret once; only the secret's SHA-256 is stored. */
export async function pairDevice(ctx: Ctx, by: By, label: string): Promise<{ device: DeviceRow; secret: string }> {
  requireOwner(by, "pair devices")
  const clean = label.replace(/\s+/g, " ").trim().slice(0, 100) || "Browser"
  const secret = randomBytes(32).toString("base64url")
  return inTx(ctx, async (tx) => {
    const now = ctx.clock()
    const [device] = await tx
      .insert(devices)
      .values({ secretHash: sha256(secret), label: clean, createdAt: now, lastSeenAt: now })
      .returning()
    if (!device) throw new Error("insert returned no row")
    await writeAudit(ctx, tx, by, {
      action: "device.pair",
      entityType: "device",
      entityId: device.id,
      after: publicDevice(device),
    })
    return { device, secret }
  })
}

/** The active device a cookie secret belongs to, or null. Records when it was last seen, once a minute. */
export async function deviceForSecret(ctx: Ctx, secret: string): Promise<DeviceRow | null> {
  const [row] = await ctx.db
    .select()
    .from(devices)
    .where(and(eq(devices.secretHash, sha256(secret)), isNull(devices.revokedAt)))
  if (!row) return null
  const now = ctx.clock()
  if (!row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() > 60_000)
    await ctx.db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, row.id))
  return row
}

export async function listDevices(ctx: Ctx, by: By) {
  requireOwner(by, "see devices")
  const rows = await ctx.db.select().from(devices).orderBy(desc(devices.createdAt))
  return rows.map(publicDevice)
}

export async function revokeDevice(ctx: Ctx, by: By, id: string): Promise<void> {
  requireOwner(by, "revoke devices")
  return inTx(ctx, async (tx) => {
    const [before] = await tx.select().from(devices).where(eq(devices.id, id)).for("update")
    if (!before) throw notFound("The device")
    if (before.revokedAt) return
    const [after] = await tx.update(devices).set({ revokedAt: ctx.clock() }).where(eq(devices.id, id)).returning()
    await writeAudit(ctx, tx, by, {
      action: "device.revoke",
      entityType: "device",
      entityId: id,
      before: publicDevice(before),
      after: after && publicDevice(after),
    })
  })
}

/** "End all devices": revokes every active device, including the caller's. */
export async function revokeAllDevices(ctx: Ctx, by: By): Promise<number> {
  requireOwner(by, "end devices")
  return inTx(ctx, async (tx) => {
    const ended = await tx
      .update(devices)
      .set({ revokedAt: ctx.clock() })
      .where(isNull(devices.revokedAt))
      .returning({ id: devices.id })
    await writeAudit(ctx, tx, by, {
      action: "device.revoke_all",
      entityType: "device",
      entityId: null,
      after: { count: ended.length, ids: ended.map((d) => d.id) },
    })
    return ended.length
  })
}

// --- Visits ("new since your last visit", per device) ---

export const FIRST_VISIT_WINDOW_MS = 24 * 60 * 60 * 1000

/** The device's previous visit before now, or 24 hours ago on its first visit (and without a device). */
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

/** The owner's latest visit on any device before now, or null when there is none. */
export async function lastVisitAnyDevice(ctx: Ctx): Promise<Date | null> {
  const [row] = await ctx.db
    .select({ at: visits.at })
    .from(visits)
    .where(lt(visits.at, ctx.clock()))
    .orderBy(desc(visits.at))
    .limit(1)
  return row?.at ?? null
}

/** Records that the device's owner saw the board now. Bookkeeping, not a change: no audit row. */
export async function recordVisit(ctx: Ctx, deviceId: string): Promise<Date> {
  const at = ctx.clock()
  await ctx.db.insert(visits).values({ deviceId, at })
  return at
}
