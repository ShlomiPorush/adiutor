// The Better Auth client: sign-up, sign-in, two-factor, the password, the browser sessions and the agent keys, all
// on Better Auth's own routes under /api/auth. Mikud adds nothing to these requests: Better Auth checks the origin
// itself. Its useSession is the only thing that extends a session (deferSessionRefresh on the server): it refreshes
// when the page opens, comes back to the front or online, or another tab changes the session. Never call
// getSession or useSession().refetch from background polling, and keep sessionOptions.refetchInterval at 0.

import { apiKeyClient } from "@better-auth/api-key/client"
import { twoFactorClient, usernameClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

/** Development and screenshot builds answer /api/auth from the mock; the production build drops this branch. */
const mockFetch =
  typeof __MIKUD_MOCK__ !== "undefined" && __MIKUD_MOCK__
    ? async (input: RequestInfo | URL, init?: RequestInit) =>
        (await import("./mock/auth.ts")).mockAuthFetch(input, init)
    : undefined

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [usernameClient(), twoFactorClient(), apiKeyClient()],
  sessionOptions: { refetchInterval: 0 },
  ...(mockFetch ? { fetchOptions: { customFetchImpl: mockFetch } } : {}),
})

/** What an /api/auth answer that failed means for the form that sent it. */
export type AuthFailure =
  | "network"
  | "wrong_password"
  | "wrong_code"
  | "code_expired"
  | "account_locked"
  | "rate_limited"
  | "server"
  | "other"

export type AuthError = { status?: number; code?: string; message?: string } | null | undefined

/**
 * Sorts a failed answer by what the owner can do next. An answer without a status never reached the server;
 * then what was typed stays, as it was not refused.
 */
export function authFailure(error: AuthError, step: "password" | "code"): AuthFailure {
  if (!error?.status) return "network"
  const code = (error.code ?? "").toUpperCase()
  if (code === "ACCOUNT_TEMPORARILY_LOCKED") return "account_locked"
  if (error.status === 429 || code === "RATE_LIMITED") return "rate_limited"
  if (error.status >= 500) return "server"
  if (code === "INVALID_TWO_FACTOR_COOKIE" || code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE") return "code_expired"
  if (step === "code" && (code === "INVALID_CODE" || code === "INVALID_BACKUP_CODE" || error.status === 401))
    return "wrong_code"
  if (code === "INVALID_PASSWORD" || code === "INVALID_USERNAME_OR_PASSWORD" || error.status === 401)
    return "wrong_password"
  return "other"
}

/** The locale key of a failure's sentence (other failures say the server's reason). */
export const FAILURE_TEXT: Record<Exclude<AuthFailure, "other">, string> = {
  network: "auth.error.network",
  wrong_password: "auth.error.wrongPassword",
  wrong_code: "auth.error.wrongCode",
  code_expired: "auth.error.codeExpired",
  account_locked: "auth.error.accountLocked",
  rate_limited: "auth.error.rateLimited",
  server: "auth.error.server",
}

/** Turns a Better Auth client answer into its data, or throws its error (for TanStack Query and try blocks). */
export async function authData<T>(call: Promise<{ data: T | null; error: AuthError }>): Promise<T> {
  const { data, error } = await call
  if (error) throw new AuthCallError(error)
  if (data === null) throw new AuthCallError({ status: 500, message: "empty answer" })
  return data
}

export class AuthCallError extends Error {
  override name = "AuthCallError"
  constructor(readonly answer: NonNullable<AuthError>) {
    super(answer.message ?? answer.code ?? String(answer.status ?? ""))
  }
}
