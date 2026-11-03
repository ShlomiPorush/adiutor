// The Settings sections (v3 FS-8, NL-3): each has its own address, /settings/<section>, and sits under a group in
// the section sidebar and in the picker of narrow screens. The groups and their order are the owner's (Q-2). Every
// field of the one settings draft belongs to one section, so a refused field opens its section first (SV-1).

import type { SettingsPatch } from "../../api/types.ts"

export const SETTINGS_GROUPS = [
  { id: "general", sections: ["general"] },
  { id: "security", sections: ["account", "agents", "secret-check"] },
  { id: "integrations", sections: ["telegram"] },
  { id: "sync", sections: ["status", "suppressions"] },
] as const

export type SettingsSection = (typeof SETTINGS_GROUPS)[number]["sections"][number]

export const SETTINGS_SECTIONS: readonly SettingsSection[] = SETTINGS_GROUPS.flatMap((group) => group.sections)

/** The section `/settings`, and any address that names no section, opens (replacing the address). */
export const FIRST_SECTION: SettingsSection = "general"

export const isSettingsSection = (value: string | undefined): value is SettingsSection =>
  (SETTINGS_SECTIONS as readonly string[]).includes(value ?? "")

export const settingsPath = (section: SettingsSection) => `/settings/${section}`

/** A move between Settings addresses keeps the draft: it holds changes across the sections (SV-1). */
export const isSettingsPath = (pathname: string) => pathname === "/settings" || pathname.startsWith("/settings/")

/** The fields of the settings draft, named as the draft names them. */
export type DraftField =
  | "language"
  | "dateFormat"
  | "timeFormat"
  | "closedItemDays"
  | "sessionIdleDays"
  | "otpViaTelegram"
  | "botToken"
  | "chatId"
  | "privateDomains"

export const FIELD_SECTION: Record<DraftField, SettingsSection> = {
  language: "general",
  dateFormat: "general",
  timeFormat: "general",
  closedItemDays: "general",
  sessionIdleDays: "general",
  otpViaTelegram: "telegram",
  botToken: "telegram",
  chatId: "telegram",
  privateDomains: "secret-check",
}

/** The draft field a key of the save request comes from. */
export const PATCH_FIELD: Record<keyof SettingsPatch, DraftField> = {
  language: "language",
  dateFormat: "dateFormat",
  timeFormat: "timeFormat",
  closedItemDays: "closedItemDays",
  sessionIdleDays: "sessionIdleDays",
  otpViaTelegram: "otpViaTelegram",
  telegramBotToken: "botToken",
  telegramChatId: "chatId",
  privateDomains: "privateDomains",
}

/** The variable that locks each field the environment may set (`setting_locked` names it). */
const VARIABLE_FIELD: Record<string, DraftField> = {
  MIKUD_TELEGRAM_BOT_TOKEN: "botToken",
  MIKUD_TELEGRAM_CHAT_ID: "chatId",
  MIKUD_PRIVATE_DOMAINS: "privateDomains",
}

/** The sections that hold a change: a dot beside each in the sidebar and the picker. */
export function changedSections(patch: SettingsPatch): Set<SettingsSection> {
  const sections = new Set<SettingsSection>()
  for (const key of Object.keys(patch) as (keyof SettingsPatch)[]) sections.add(FIELD_SECTION[PATCH_FIELD[key]])
  return sections
}

const isPatchKey = (value: unknown): value is keyof SettingsPatch => typeof value === "string" && value in PATCH_FIELD

/**
 * The field a refused save names: `setting_locked` names its variable, a rule names its `field`, and a schema
 * failure the `path` of its first issue (docs/api.md). Null when the answer names no field of the draft.
 */
export function refusedField(code: string, details: Record<string, unknown>): DraftField | null {
  if (code === "setting_locked" && typeof details.variable === "string") return VARIABLE_FIELD[details.variable] ?? null
  if (code !== "validation_failed") return null
  if (isPatchKey(details.field)) return PATCH_FIELD[details.field]
  const issues = Array.isArray(details.issues) ? details.issues : []
  for (const issue of issues) {
    const head = String((issue as { path?: unknown } | null)?.path ?? "").split(".")[0]
    if (isPatchKey(head)) return PATCH_FIELD[head]
  }
  return null
}
