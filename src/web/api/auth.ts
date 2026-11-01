// The Better Auth client: sign-in, the TOTP step and enrolment, and sign-out, on /api/auth. Every request
// names itself with X-Mikud-Request, which the server requires on each POST there (with the page's Origin).
// The account itself (sessions, the password) goes through the Mikud API in endpoints.ts.

import { createAuthClient } from "better-auth/client"
import { twoFactorClient, usernameClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [usernameClient(), twoFactorClient()],
  fetchOptions: { headers: { "X-Mikud-Request": "1" } },
})

/** What an /api/auth answer that failed means for the form that sent it. */
export type AuthFailure =
  | "network"
  | "wrong_password"
  | "wrong_code"
  | "code_expired"
  | "rate_limited"
  | "busy"
  | "session_ended"
  | "other"

export type AuthError = { status?: number; code?: string; message?: string; reason?: string } | null | undefined

/**
 * Sorts a failed answer by what the owner can do next. An answer without a status never reached the server;
 * then what was typed stays, as it was not refused.
 */
export function authFailure(error: AuthError, step: "password" | "code"): AuthFailure {
  if (!error?.status) return "network"
  const code = (error.code ?? "").toUpperCase()
  if (code === "SESSION_ENDED") return "session_ended"
  if (error.status === 429 || code === "RATE_LIMITED") return "rate_limited"
  if (error.status === 503) return "busy"
  if (code === "INVALID_TWO_FACTOR_COOKIE" || code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE") return "code_expired"
  if (step === "code" && (code === "INVALID_CODE" || error.status === 401)) return "wrong_code"
  if (code === "INVALID_PASSWORD" || code === "INVALID_USERNAME_OR_PASSWORD" || error.status === 401)
    return "wrong_password"
  return "other"
}

/** The locale key of a failure's sentence (other failures say the server's reason). */
export const FAILURE_TEXT: Record<Exclude<AuthFailure, "other" | "session_ended">, string> = {
  network: "auth.error.network",
  wrong_password: "auth.error.wrongPassword",
  wrong_code: "auth.error.wrongCode",
  code_expired: "auth.error.codeExpired",
  rate_limited: "auth.error.rateLimited",
  busy: "auth.error.busy",
}
