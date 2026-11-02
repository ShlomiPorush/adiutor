import { randomBytes } from "node:crypto"
import { authUser } from "../db/schema.ts"
import { type AuthOptions, createAuth } from "./auth.ts"

/** A random password the CLI prints once: 24 characters of base64url. */
export const randomPassword = () => randomBytes(18).toString("base64url")

/**
 * The recovery command: Better Auth's documented password reset, run on the server. A Better Auth instance with a
 * local sendResetPassword hands the reset token to this function instead of sending it anywhere; then the reset
 * consumes it, writes the new hash and (revokeSessionsOnPasswordReset) deletes every session, in one transaction.
 * Two-factor is not touched: the owner signs in with the new password and the authenticator or a backup code. Both
 * routes are closed over HTTP; these are server calls. Returns the username and the new password, or null when no
 * owner exists.
 */
export async function resetOwnerPassword(
  options: Omit<AuthOptions, "sendResetPassword" | "sendOtp" | "otpViaTelegram">,
): Promise<{ username: string; password: string } | null> {
  const [owner] = await options.ctx.db
    .select({ email: authUser.email, username: authUser.username, name: authUser.name })
    .from(authUser)
    .limit(1)
  if (!owner) return null
  let token: string | undefined
  const auth = createAuth({
    ...options,
    otpViaTelegram: false,
    sendResetPassword: async (value) => {
      token = value
    },
  })
  await auth.api.requestPasswordReset({ body: { email: owner.email } })
  if (!token) throw new Error("Better Auth did not issue a reset token")
  const password = randomPassword()
  await auth.api.resetPassword({ body: { token, newPassword: password } })
  return { username: owner.username ?? owner.name, password }
}
