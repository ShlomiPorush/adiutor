import { z } from "zod"

// The owner's sign-in name and password, for the UI forms. Better Auth validates both on its own routes
// (sign-up, change-password); these rules repeat its configuration so a form can answer before it sends. The
// username rules are those of Better Auth's username() plugin with its defaults: 3 to 30 characters of
// [a-zA-Z0-9_.], not trimmed, stored lowercased in `username` with the spelling as typed in `displayUsername`;
// sign-in lowercases what is typed. The password limits are the minPasswordLength and maxPasswordLength that
// src/server/auth/auth.ts sets.

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

/**
 * The synthetic e-mail Better Auth requires; Mikud never sends mail. The sign-up refuses any other. Its local part is
 * the lowercased username in hex (`u-` and 2 hex digits per character, at most 62 characters), so every username the
 * plugin accepts (`.alice`, `alice.`, `a..b`) still makes an address that Better Auth's e-mail check accepts.
 */
export const ownerEmail = (username: string) =>
  `u-${[...username.toLowerCase()].map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(2, "0")).join("")}@mikud.local`

// --- Sign out after this long without Mikud open (Settings): Better Auth's sliding session.expiresIn ---

export const SESSION_IDLE_DAYS_MIN = 1
export const SESSION_IDLE_DAYS_MAX = 90
export const SESSION_IDLE_DAYS_DEFAULT = 30

// --- Agent keys (Better Auth's api-key plugin) ---

/** Every agent key starts with this; the secret check refuses it in agent text. */
export const AGENT_KEY_PREFIX = "mkd_"
export const AGENT_KEY_NAME_MAX = 32
