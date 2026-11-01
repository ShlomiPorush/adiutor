import { z } from "zod"

// The owner's sign-in name and password, shared by the setup API, the recovery CLI and the UI forms. The
// username rules are exactly those of Better Auth's username() plugin with its defaults: 3 to 30 characters
// of [a-zA-Z0-9_.], not trimmed, stored lowercased in `username` with the spelling as typed in
// `displayUsername`; sign-in lowercases what is typed. The password limits are Better Auth's
// minPasswordLength (set to 12) and its default maxPasswordLength.

export const USERNAME_MIN = 3
export const USERNAME_MAX = 30
export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 128

/** 3 to 30 of a-z, A-Z, 0-9, underscore and dot, as typed (no trim). */
export const usernameSchema = z
  .string()
  .min(USERNAME_MIN)
  .max(USERNAME_MAX)
  .regex(/^[a-zA-Z0-9_.]+$/)

/** How the plugin stores and looks up a username. */
export const normalizeUsername = (username: string) => username.toLowerCase()

export const passwordSchema = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX)

/** POST /api/setup/account. */
export const setupAccountBody = z.object({ username: usernameSchema, password: passwordSchema })

/** POST /api/v1/account/password. The current password is only compared, so its length is not checked. */
export const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX),
  newPassword: passwordSchema,
})

/** The synthetic e-mail Better Auth requires; Mikud never sends mail. */
export const ownerEmail = (username: string) => `${username.toLowerCase()}@mikud.local`

// --- Session clocks (Settings) ---

export const SESSION_MAX_DAYS_MIN = 1
export const SESSION_MAX_DAYS_MAX = 90
export const SESSION_MAX_DAYS_DEFAULT = 30
export const SESSION_IDLE_MINUTES_MIN = 5
export const SESSION_IDLE_MINUTES_MAX = 1440
export const SESSION_IDLE_MINUTES_DEFAULT = 30
/** Better Auth keeps every session this long and never extends it; the clocks above always end it first. */
export const SESSION_LIBRARY_DAYS = SESSION_MAX_DAYS_MAX + 1
/** Real input on the page is reported at most this often. */
export const ACTIVITY_REPORT_MS = 30_000

/** Why the clocks ended a session: its maximum length, or no real input for the idle limit. */
export const SESSION_END_REASONS = ["max", "idle"] as const
export type SessionEndReason = (typeof SESSION_END_REASONS)[number]
