import { z } from "zod"

// The owner's sign-in name and password, for the UI forms. Better Auth validates both on its own routes
// (sign-up, change-password); these rules repeat its configuration so a form can answer before it sends. The
// username rule is the username() plugin's with Mikud's usernameValidator (isValidUsername below): 3 to 30
// characters of [a-zA-Z0-9_.], no dot at the start or end and no two dots in a row, not trimmed, stored lowercased in
// `username` with the spelling as typed in `displayUsername`; sign-in lowercases what is typed. The password limits
// are the minPasswordLength and maxPasswordLength that src/server/auth/auth.ts sets.

export const USERNAME_MIN = 3
export const USERNAME_MAX = 30
export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 128

/**
 * Letters a-z and A-Z, digits and underscores, with single dots between them. Every such name is a valid e-mail
 * local part as typed, so ownerEmail needs no encoding. scripts/lib/try-pr-seed.mjs and the migration
 * drizzle/0008_readable-email.sql repeat it.
 */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/

/** The username plugin's usernameValidator (the plugin checks the length itself) and the form's rule. */
export const isValidUsername = (username: string) => USERNAME_PATTERN.test(username)

/** 3 to 30 of a-z, A-Z, 0-9, underscore and dot, as typed (no trim); no dot at either end, no two dots in a row. */
export const usernameSchema = z.string().min(USERNAME_MIN).max(USERNAME_MAX).refine(isValidUsername)

/** How the plugin stores and looks up a username. */
export const normalizeUsername = (username: string) => username.toLowerCase()

export const passwordSchema = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX)

const OWNER_EMAIL_DOMAIN = "@mikud.local"

/**
 * The synthetic e-mail Better Auth requires; Mikud never sends mail. The sign-up refuses any other. It is the
 * lowercased username at mikud.local, a valid address for every name isValidUsername allows.
 */
export const ownerEmail = (username: string) => `${username.toLowerCase()}${OWNER_EMAIL_DOMAIN}`

const TOTP_URI_PREFIX = "otpauth://totp/"

/**
 * The authenticator link the setup page draws as a QR code, with the username as the account name. Better Auth's
 * two-factor plugin names the account after the e-mail (`Mikud:<username>@mikud.local`) and has no option for it, so
 * the page drops the synthetic domain from the label (owner's decision, 2026-11-03). Only the label changes: the
 * query (secret, issuer, digits, period) stays exactly as Better Auth wrote it. Any other shape comes back unchanged.
 */
export function authenticatorUri(uri: string): string {
  if (!uri.startsWith(TOTP_URI_PREFIX)) return uri
  const queryAt = uri.indexOf("?")
  const label = uri.slice(TOTP_URI_PREFIX.length, queryAt === -1 ? undefined : queryAt)
  const query = queryAt === -1 ? "" : uri.slice(queryAt)
  // Better Auth encodes the issuer and the account each with encodeURIComponent, so the first raw colon parts them.
  const colon = label.indexOf(":")
  if (colon === -1) return uri
  let account: string
  try {
    account = decodeURIComponent(label.slice(colon + 1))
  } catch {
    return uri
  }
  if (!account.endsWith(OWNER_EMAIL_DOMAIN) || account.length === OWNER_EMAIL_DOMAIN.length) return uri
  const username = account.slice(0, -OWNER_EMAIL_DOMAIN.length)
  return `${TOTP_URI_PREFIX}${label.slice(0, colon)}:${encodeURIComponent(username)}${query}`
}

// --- Sign out after this long without Mikud open (Settings): Better Auth's sliding session.expiresIn ---

export const SESSION_IDLE_DAYS_MIN = 1
export const SESSION_IDLE_DAYS_MAX = 90
export const SESSION_IDLE_DAYS_DEFAULT = 30

// --- Agent keys (Better Auth's api-key plugin) ---

/** Every agent key starts with this; the secret check refuses it in agent text. */
export const AGENT_KEY_PREFIX = "mkd_"
export const AGENT_KEY_NAME_MAX = 32

/** How long a key made by `mikud connect` lives (`--days`): the api-key plugin's keyExpiration limits, in days. */
export const AGENT_KEY_DAYS_MIN = 1
export const AGENT_KEY_DAYS_MAX = 365

// --- Agent approval in the browser (Better Auth's core deviceAuthorization plugin) ---

/** The one client id the device plugin accepts (validateClient); the CLI also sends it as its User-Agent. */
export const CONNECT_CLIENT_ID = "mikud-connect"
/** The page where the owner approves a `mikud connect` request (the plugin's verificationUri). */
export const CONNECT_DEVICE_PATH = "/connect/device"
