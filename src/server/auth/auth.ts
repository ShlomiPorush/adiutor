import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { twoFactor, username } from "better-auth/plugins"
import { SESSION_LIBRARY_DAYS } from "../../shared/auth.ts"
import type { Db } from "../db/client.ts"
import { authAccount, authSession, authTwoFactor, authUser, authVerification } from "../db/schema.ts"
import { errorFacts, log } from "../log.ts"

/** The header the guard sets from the socket's address; Better Auth records it as the session's address. */
export const CLIENT_IP_HEADER = "x-mikud-client-ip"

/**
 * Better Auth for the one owner: username and password, then TOTP. It has no hooks: every decision is made by
 * Mikud's wrapper around its handler (http/auth-guard.ts), which admits only the routes Mikud uses, checks CSRF,
 * the rate limits and the session clocks, holds the auth lock for the whole request, and then marks TOTP proof,
 * the clocks and the audit row from the final response. The API middleware requires a session that proved TOTP
 * (two_factor_at). Better Auth's own rate limiter is off: Mikud's counts by socket address.
 */
export function createAuth(options: {
  db: Db
  secret: string
  publicUrl: URL
  /** Tests only: runs inside Better Auth before it updates the user (TOTP enrolment sets twoFactorEnabled). */
  beforeUserUpdate?: () => Promise<void>
}) {
  const { publicUrl } = options
  return betterAuth({
    appName: "Mikud",
    secret: options.secret,
    basePath: "/api/auth",
    baseURL: publicUrl.origin,
    trustedOrigins: [publicUrl.origin],
    telemetry: { enabled: false },
    // Better Auth and its router would log the raw error, whose message can hold a failed query with its
    // parameters (a session token, a password hash). Its own log lines go through logBetterAuth, and an error that
    // is not an APIError is thrown out of the handler (APIError answers stay as they are), where Mikud's wrapper
    // (http/auth-guard.ts) logs only what errorFacts allows and answers a safe 500.
    logger: { level: "error", log: logBetterAuth },
    onAPIError: { throw: true },
    database: drizzleAdapter(options.db, {
      provider: "pg",
      schema: {
        user: authUser,
        session: authSession,
        account: authAccount,
        verification: authVerification,
        twoFactor: authTwoFactor,
      },
    }),
    // Sign-up is never routed (the guard answers 404); the owner is created by setup (services/account.ts).
    emailAndPassword: { enabled: true, minPasswordLength: 12, disableSignUp: true },
    // Kept longer than the longest maximum length and never extended: the clocks in Settings decide.
    session: { expiresIn: SESSION_LIBRARY_DAYS * 24 * 3600, disableSessionRefresh: true },
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: publicUrl.protocol === "https:",
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    ...(options.beforeUserUpdate
      ? {
          databaseHooks: {
            user: {
              update: {
                before: async () => {
                  await options.beforeUserUpdate?.()
                },
              },
            },
          },
        }
      : {}),
    plugins: [username(), twoFactor({ issuer: "Mikud" })],
  })
}

export type Auth = ReturnType<typeof createAuth>

/** Better Auth's own log lines: the level and the facts of any error passed along, never the message itself. */
export function logBetterAuth(level: string, _message: string, ...args: unknown[]): void {
  const error = args.find((arg) => arg instanceof Error)
  const facts = error ? errorFacts(error) : {}
  if (level === "error") log.error("better auth reported an error", facts)
  else if (level === "warn") log.warn("better auth reported a warning", facts)
}

/** Better Auth's password hashing, for the services that write credentials themselves. */
export async function passwordHasher(auth: Auth) {
  return (await auth.$context).password
}
