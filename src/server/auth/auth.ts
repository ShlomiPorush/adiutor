import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { twoFactor, username } from "better-auth/plugins"
import { SESSION_LIBRARY_DAYS } from "../../shared/auth.ts"
import type { Db } from "../db/client.ts"
import { authAccount, authSession, authTwoFactor, authUser, authVerification } from "../db/schema.ts"

/** The header the guard sets from the socket's address; Better Auth records it as the session's address. */
export const CLIENT_IP_HEADER = "x-mikud-client-ip"

/**
 * Better Auth for the one owner: username and password, then TOTP. It has no hooks: every decision is made by
 * Mikud's wrapper around its handler (http/auth-guard.ts), which admits only the routes Mikud uses, checks CSRF,
 * the rate limits and the session clocks, holds the auth lock for the whole request, and then marks TOTP proof,
 * the clocks and the audit row from the final response. The API middleware requires a session that proved TOTP
 * (two_factor_at). Better Auth's own rate limiter is off: Mikud's counts by socket address.
 */
export function createAuth(options: { db: Db; secret: string; publicUrl: URL }) {
  const { publicUrl } = options
  return betterAuth({
    appName: "Mikud",
    secret: options.secret,
    basePath: "/api/auth",
    baseURL: publicUrl.origin,
    trustedOrigins: [publicUrl.origin],
    telemetry: { enabled: false },
    logger: { level: "error" },
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
    plugins: [username(), twoFactor({ issuer: "Mikud" })],
  })
}

export type Auth = ReturnType<typeof createAuth>

/** Better Auth's password hashing, for the services that write credentials themselves. */
export async function passwordHasher(auth: Auth) {
  return (await auth.$context).password
}
