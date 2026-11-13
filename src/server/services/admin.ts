import { and, desc, eq, lt } from "drizzle-orm"
import type { Language } from "../../shared/enums.ts"
import { CLOSED_ITEM_DAYS_MAX, CLOSED_ITEM_DAYS_MIN } from "../../shared/settings.ts"
import type { EnvOverrides } from "../config.ts"
import { VISIT_SAFETY_MARGIN_MS } from "../db/client.ts"
import { settings, suppressions, visits } from "../db/schema.ts"
import { AppError, invalid, notFound } from "../errors.ts"
import type { SettingsCipher } from "../settings/crypto.ts"
import { BOT_TOKEN_COLUMN, effectivePrivateDomains, effectiveTelegram } from "../settings/effective.ts"
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
  sessionIdleDays?: number
  otpViaTelegram?: boolean
  /** A new bot token, or null to remove the stored one. Never returned or audited. */
  telegramBotToken?: string | null
  telegramChatId?: string | null
  privateDomains?: string[]
}

/** What the settings that hold secrets or may be set by the environment need: the overrides and the cipher. */
export type SettingsEnv = { overrides: EnvOverrides; cipher: SettingsCipher }

/** The settings as the API shows them: the bot token never leaves the server, only whether it is set. */
export function settingsView(row: SettingsRow, env: SettingsEnv) {
  const { telegramBotTokenEnc: _token, telegramChatId: _chat, privateDomains: _domains, ...plain } = row
  return {
    ...plain,
    telegram: effectiveTelegram(row, env.overrides, env.cipher).view,
    privateDomains: effectivePrivateDomains(row, env.overrides),
  }
}

/** A settings row for the audit: the encrypted token becomes "set" or "unset". */
function auditable(row: SettingsRow) {
  const { telegramBotTokenEnc, ...rest } = row
  return { ...rest, telegramBotToken: telegramBotTokenEnc ? "set" : "unset" }
}

const locked = (variable: string) =>
  new AppError(
    "setting_locked",
    `The environment variable ${variable} sets this. Change it there and restart Adiutor.`,
    {
      variable,
    },
  )

export async function updateSettings(ctx: Ctx, by: By, patch: SettingsPatch, env?: SettingsEnv): Promise<SettingsRow> {
  requireOwner(by, "change settings")
  const days = patch.closedItemDays
  if (days !== undefined && !(days >= CLOSED_ITEM_DAYS_MIN && days <= CLOSED_ITEM_DAYS_MAX))
    throw invalid(`closedItemDays must be between ${CLOSED_ITEM_DAYS_MIN} and ${CLOSED_ITEM_DAYS_MAX}.`)
  const overrides = env?.overrides ?? {}
  if (patch.telegramBotToken !== undefined && overrides.telegramBotToken !== undefined)
    throw locked("ADIUTOR_TELEGRAM_BOT_TOKEN")
  if (patch.telegramChatId !== undefined && overrides.telegramChatId !== undefined)
    throw locked("ADIUTOR_TELEGRAM_CHAT_ID")
  if (patch.privateDomains !== undefined && overrides.privateDomains !== undefined)
    throw locked("ADIUTOR_PRIVATE_DOMAINS")
  const { telegramBotToken, ...columns } = patch
  const set: Partial<SettingsRow> = { ...columns, updatedAt: ctx.clock() }
  if (telegramBotToken !== undefined) {
    if (telegramBotToken !== null && !env) throw new Error("storing a bot token needs the settings cipher")
    set.telegramBotTokenEnc =
      telegramBotToken === null ? null : (env as SettingsEnv).cipher.encrypt(BOT_TOKEN_COLUMN, telegramBotToken)
  }
  return inTx(ctx, async (tx) => {
    const before = await getSettings(tx)
    const [after] = await tx.update(settings).set(set).where(eq(settings.id, 1)).returning()
    if (!after) throw new Error("settings row missing")
    // Sign-in codes to Telegram need a working bot: turning it on with Telegram off would lock the owner's codes out.
    if (after.otpViaTelegram && !before.otpViaTelegram && env) {
      const telegram = effectiveTelegram(after, env.overrides, env.cipher)
      if (telegram.state !== "on")
        throw invalid("Set up Telegram before sending sign-in codes there.", { field: "otpViaTelegram" })
    }
    const token = telegramBotToken === undefined ? undefined : telegramBotToken === null ? "removed" : "replaced"
    await writeAudit(ctx, tx, by, {
      action: "settings.update",
      entityType: "settings",
      entityId: "1",
      before: auditable(before),
      after: { ...auditable(after), ...(token ? { telegramBotTokenChange: token } : {}) },
    })
    return after
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

// --- Visits ("new since your last visit", per browser: the adiutor_browser cookie names a devices row) ---

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
