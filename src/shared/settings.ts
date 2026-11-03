// The default of each owner setting that has one, in one place: the database schema takes its column defaults from
// here, and Settings marks a value that differs as Changed and offers Reset to default (v3 FS-6). Secrets, the chat
// id and the private domains have no default to go back to: they are the owner's own values.

import { SESSION_IDLE_DAYS_DEFAULT } from "./auth.ts"
import { DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT } from "./datetime-formats.ts"
import type { Language } from "./enums.ts"

export const CLOSED_ITEM_DAYS_MIN = 1
export const CLOSED_ITEM_DAYS_MAX = 365

export const SETTINGS_DEFAULTS = {
  language: "he" as Language,
  dateFormat: DEFAULT_DATE_FORMAT,
  timeFormat: DEFAULT_TIME_FORMAT,
  closedItemDays: 7,
  sessionIdleDays: SESSION_IDLE_DAYS_DEFAULT,
  otpViaTelegram: false,
} as const

export type DefaultedSetting = keyof typeof SETTINGS_DEFAULTS
