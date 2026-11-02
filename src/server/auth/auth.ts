import { apiKey } from "@better-auth/api-key"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { twoFactor, username } from "better-auth/plugins"
import { AGENT_KEY_NAME_MAX, AGENT_KEY_PREFIX, isValidUsername, ownerEmail } from "../../shared/auth.ts"
import type { VersionedKey } from "../config.ts"
import {
  authAccount,
  authApiKey,
  authRateLimit,
  authSession,
  authTwoFactor,
  authUser,
  authVerification,
} from "../db/schema.ts"
import { errorFacts, log } from "../log.ts"
import type { By, Ctx } from "../services/context.ts"
import { writeAudit } from "../services/context.ts"

// Better Auth as it documents itself: its routes, its plugins (username, twoFactor, api-key), its options and its
// documented hooks. Mikud does not wrap its handler. The hooks below only refuse (a closed route, a second owner, a
// trusted device, an agent key without two-factor) and write audit rows; Better Auth makes every decision about
// passwords, sessions and codes. See "Security design" in docs/project-foundation.md for what this leaves open.

const DAY_S = 86_400
const HOUR_S = 3_600

/** How long a two-factor challenge (after the password, before the code) lives: 3 minutes, not 10. */
export const TWO_FACTOR_CHALLENGE_S = 180

/**
 * The only /api/auth routes a browser may call (matched on Better Auth's route pattern, `ctx.path`). Everything else
 * answers 404 over HTTP, including routes a future Better Auth version adds. Server calls (`auth.api.*`) are not
 * HTTP requests and are not limited by this list: the recovery CLI resets the password through them.
 */
export const ALLOWED_PATHS = [
  "/ok",
  "/get-session",
  "/sign-up/email",
  "/sign-in/username",
  "/sign-out",
  "/change-password",
  "/list-sessions",
  "/revoke-other-sessions",
  "/revoke-sessions",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/generate-backup-codes",
  "/api-key/create",
  "/api-key/list",
  "/api-key/delete",
] as const

/** Routes of Better Auth's two-factor OTP: open only while the owner sends sign-in codes to Telegram. */
export const OTP_PATHS = ["/two-factor/send-otp", "/two-factor/verify-otp"] as const

/** Every route whose body accepts `trustDevice` (a 30-day cookie that skips the code). Mikud refuses it. */
export const TRUST_DEVICE_PATHS = [
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
  "/two-factor/send-otp",
] as const

/** Credential routes: 5 attempts per 5 minutes per address and route. */
const CREDENTIAL_PATHS = [
  "/sign-up/email",
  "/sign-in/username",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/change-password",
  ...OTP_PATHS,
]

/** Paths whose session deletions are ended sessions (one audit row each). Sign-out is audited after the fact. */
const SESSION_END_PATHS = new Set(["/revoke-other-sessions", "/revoke-sessions", "/reset-password"])

/** Second-factor routes and the method each one records at sign-in. */
const SECOND_FACTOR: Record<string, string> = {
  "/two-factor/verify-totp": "totp",
  "/two-factor/verify-backup-code": "backup_code",
  "/two-factor/verify-otp": "otp",
}

export type AuthSettings = {
  /** Settings: sign out after this many days without a refresh by the Better Auth client. */
  sessionIdleDays: number
  /** Settings: Better Auth's two-factor OTP through the Telegram bot. Off by default. */
  otpViaTelegram: boolean
}

export type AuthOptions = AuthSettings & {
  ctx: Ctx
  /** MIKUD_AUTH_SECRETS: Better Auth's versioned `secrets`. */
  secrets: VersionedKey[]
  /** MIKUD_AUTH_SECRET: Better Auth's legacy `secret`, which decrypts data from before `secrets`. */
  legacySecret?: string
  publicUrl: URL
  /** MIKUD_TRUSTED_PROXIES: the proxies whose X-Forwarded-For hop Better Auth skips. */
  trustedProxies: string[]
  /** Sends a sign-in code to the owner's Telegram chat; used only while otpViaTelegram is on. */
  sendOtp?: (code: string) => Promise<void>
  /** The recovery CLI only: receives the reset token instead of sending it anywhere. */
  sendResetPassword?: (token: string) => Promise<void>
}

type OwnerRow = { id: string; username: string; twoFactorEnabled: boolean }

/** The one owner, read on Mikud's own connection (outside Better Auth's transaction), or null before setup. */
async function readOwner(ctx: Ctx): Promise<OwnerRow | null> {
  const [row] = await ctx.db
    .select({
      id: authUser.id,
      username: authUser.username,
      name: authUser.name,
      twoFactorEnabled: authUser.twoFactorEnabled,
    })
    .from(authUser)
    .limit(1)
  return row
    ? { id: row.id, username: row.username ?? row.name, twoFactorEnabled: row.twoFactorEnabled === true }
    : null
}

type HookContext = { path?: string; request?: Request; context?: { session?: unknown } } | null | undefined

const refuse = (status: "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST", code: string, message: string) =>
  new APIError(status, { code, message })

/**
 * Better Auth for the one owner: username and password, then TOTP (or a backup code), and agent keys. The instance
 * is rebuilt when a setting it reads changes (AuthHolder).
 */
export function createAuth(options: AuthOptions) {
  const { ctx, publicUrl } = options
  const otp = options.otpViaTelegram && options.sendOtp ? options.sendOtp : undefined
  const allowed = new Set<string>([...ALLOWED_PATHS, ...(otp ? OTP_PATHS : [])])

  const ownerBy = (owner: OwnerRow | null): By => ({
    actor: { kind: "owner", label: owner?.username ?? "owner" },
    source: "ui",
  })
  const audit = async (by: By, action: string, entityType: string, after?: unknown, entityId: string | null = null) =>
    writeAudit(ctx, ctx.db, by, { action, entityType, entityId, after })

  /** One documented `hooks.before`: the allow-list, the refusals and the audit rows that may refuse. */
  const beforeAuthRoute = createAuthMiddleware(async (c) => {
    const path = c.path
    const http = Boolean(c.request)
    if (http && !allowed.has(path)) throw refuse("NOT_FOUND", "NOT_FOUND", "Nothing is here.")
    const body = (c.body ?? {}) as Record<string, unknown>

    if (path === "/sign-up/email") {
      if (await readOwner(ctx)) throw refuse("FORBIDDEN", "ALREADY_SET_UP", "Mikud already has its owner.")
      if (typeof body.username !== "string" || body.email !== ownerEmail(body.username))
        throw refuse("BAD_REQUEST", "INVALID_EMAIL", "The e-mail must be the one Mikud derives from the username.")
      return
    }
    if ((TRUST_DEVICE_PATHS as readonly string[]).includes(path) && body.trustDevice)
      throw refuse("BAD_REQUEST", "TRUST_DEVICE_UNSUPPORTED", "Mikud asks for the code at every sign-in.")
    if (path === "/two-factor/generate-backup-codes") {
      await audit(ownerBy(await readOwner(ctx)), "account.backup_codes_new", "account")
      return
    }
    if (path.startsWith("/api-key/")) {
      const owner = await readOwner(ctx)
      // Browsers only: server calls (verifying a key) keep working while the owner sets up a new authenticator.
      if (http && !owner?.twoFactorEnabled)
        throw refuse("FORBIDDEN", "TOTP_REQUIRED", "Set up two-factor authentication first.")
      const by: By = http ? ownerBy(owner) : { actor: { kind: "system", label: "system" }, source: "api" }
      if (path === "/api-key/create") {
        if (body.prefix !== undefined && body.prefix !== AGENT_KEY_PREFIX)
          throw refuse("BAD_REQUEST", "INVALID_KEY_PREFIX", `Agent keys start with ${AGENT_KEY_PREFIX}.`)
        await audit(by, "api_key.create", "api_key", {
          name: typeof body.name === "string" ? body.name.slice(0, AGENT_KEY_NAME_MAX) : null,
        })
      } else if (path === "/api-key/delete") {
        const keyId = typeof body.keyId === "string" ? body.keyId.slice(0, 100) : null
        await audit(by, "api_key.delete", "api_key", undefined, keyId)
      }
    }
  })

  /**
   * One documented `hooks.after`: the sign-out row. A throwing hook on sign-out would be swallowed by Better Auth and
   * leave the session valid, so the sign-out is recorded after the fact and this hook never throws.
   */
  const auditAfterTheFact = createAuthMiddleware(async (c) => {
    if (c.path !== "/sign-out") return
    const returned = (c.context as { returned?: unknown }).returned
    if (returned instanceof APIError || returned instanceof Error) return
    try {
      await audit(ownerBy(await readOwner(ctx)), "session.sign_out", "session")
    } catch (error) {
      log.error("the sign-out audit row was not written", errorFacts(error))
    }
  })

  const pathOf = (context: HookContext) => context?.path ?? ""
  const viaHttp = (context: HookContext) => Boolean(context?.request)

  return betterAuth({
    appName: "Mikud",
    secrets: options.secrets.map((k) => ({ version: k.version, value: k.value })),
    ...(options.legacySecret ? { secret: options.legacySecret } : {}),
    basePath: "/api/auth",
    baseURL: publicUrl.origin,
    trustedOrigins: [publicUrl.origin],
    telemetry: { enabled: false },
    // Better Auth would log the raw error, whose message can hold a failed query with its parameters. Its own lines
    // go through logBetterAuth; an error that is not an APIError leaves the handler (onAPIError.throw) and Mikud's
    // app.onError logs only errorFacts.
    logger: { level: "error", log: logBetterAuth },
    onAPIError: { throw: true },
    database: drizzleAdapter(ctx.db, {
      provider: "pg",
      transaction: true,
      schema: {
        user: authUser,
        session: authSession,
        account: authAccount,
        verification: authVerification,
        twoFactor: authTwoFactor,
        rateLimit: authRateLimit,
        apikey: authApiKey,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      ...(options.sendResetPassword
        ? {
            sendResetPassword: async ({ token }: { token: string }) => {
              await options.sendResetPassword?.(token)
            },
          }
        : {}),
    },
    // The sliding idle limit. GET reads never extend a session (deferSessionRefresh); the Better Auth client's own
    // refresh (POST /get-session) does, at most once per updateAge. freshAge 0: listing sessions works in any session.
    session: {
      expiresIn: options.sessionIdleDays * DAY_S,
      updateAge: HOUR_S,
      deferSessionRefresh: true,
      freshAge: 0,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: Object.fromEntries(CREDENTIAL_PATHS.map((p) => [p, { window: 300, max: 5 }])),
    },
    advanced: {
      // Better Auth skips its origin check under NODE_ENV=test; Mikud keeps it on everywhere.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: publicUrl.protocol === "https:",
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: options.trustedProxies },
    },
    hooks: { before: beforeAuthRoute, after: auditAfterTheFact },
    databaseHooks: {
      user: {
        create: {
          // Inside the sign-up transaction: a second owner is refused (the single-owner index backs this up).
          before: async (user) => {
            if (await readOwner(ctx)) throw refuse("FORBIDDEN", "ALREADY_SET_UP", "Mikud already has its owner.")
            const name = String((user as { username?: string }).username ?? user.name)
            await audit({ actor: { kind: "owner", label: name }, source: "ui" }, "account.setup", "account", {
              username: name,
            })
          },
        },
        update: {
          // Only the audit row of a two-factor change; a refusal leaves the factor as it was.
          before: async (data, context) => {
            if (!("twoFactorEnabled" in data) || data.twoFactorEnabled === undefined) return
            const owner = await readOwner(ctx)
            if (!owner || owner.twoFactorEnabled === Boolean(data.twoFactorEnabled)) return
            const by = viaHttp(context) ? ownerBy(owner) : { actor: { kind: "system", label: "system" }, source: "api" }
            await audit(by as By, data.twoFactorEnabled ? "account.totp_enable" : "account.totp_disable", "account")
          },
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            const path = pathOf(context)
            const prior = Boolean((context as HookContext)?.context?.session)
            // Every session Better Auth creates after a password is recorded as the password stage, whatever the
            // account's two-factor flag says now: with two-factor on, the plugin turns it into a challenge, and a
            // sign-in racing enrolment (G6) keeps it. The second-factor routes record the second stage.
            let after: { stage: "password" | "second_factor"; method?: string } | null = null
            if (path === "/sign-up/email" || path === "/sign-in/username") after = { stage: "password" }
            else if (SECOND_FACTOR[path] && !prior) after = { stage: "second_factor", method: SECOND_FACTOR[path] }
            if (!after) return
            const owner = await readOwner(ctx)
            const label = owner?.username ?? String((session as { userId?: string }).userId ?? "owner")
            await audit({ actor: { kind: "owner", label }, source: "ui" }, "session.sign_in", "session", after)
          },
        },
        delete: {
          // Never on /sign-out (a throw there is swallowed and leaves the session valid): see hooks.after.
          before: async (_session, context) => {
            const path = pathOf(context)
            if (!SESSION_END_PATHS.has(path)) return
            const by: By =
              path === "/reset-password"
                ? { actor: { kind: "system", label: "cli" }, source: "cli" }
                : ownerBy(await readOwner(ctx))
            await audit(by, "session.end", "session", { via: path.slice(1) })
          },
        },
      },
      account: {
        update: {
          before: async (data, context) => {
            if (!(data as { password?: string }).password) return
            const path = pathOf(context)
            if (path === "/reset-password")
              await audit(
                { actor: { kind: "system", label: "cli" }, source: "cli" },
                "account.password_reset",
                "account",
              )
            else await audit(ownerBy(await readOwner(ctx)), "account.password_change", "account")
          },
        },
      },
    },
    plugins: [
      // The documented usernameValidator: no dot at either end and no two dots in a row, so the username is the
      // readable local part of the synthetic e-mail that the authenticator app shows (ownerEmail).
      username({ usernameValidator: isValidUsername }),
      twoFactor({
        issuer: "Mikud",
        twoFactorCookieMaxAge: TWO_FACTOR_CHALLENGE_S,
        ...(otp
          ? {
              otpOptions: {
                sendOTP: async ({ otp: code }: { otp: string }) => {
                  await otp(code)
                },
              },
            }
          : {}),
      }),
      apiKey({
        defaultPrefix: AGENT_KEY_PREFIX,
        enableSessionForAPIKeys: false,
        rateLimit: { enabled: false },
        requireName: true,
        maximumNameLength: AGENT_KEY_NAME_MAX,
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

/**
 * The running Better Auth instance. Some of its options are fixed when it is built (the idle length, the OTP
 * route), so a change of those settings builds a new instance with the same options and swaps it in. A request
 * in flight finishes on the instance it started with; sessions live in the database, so both agree on them.
 */
export class AuthHolder {
  private instance: Auth
  private applied: AuthSettings

  constructor(
    private readonly base: Omit<AuthOptions, keyof AuthSettings>,
    settings: AuthSettings,
  ) {
    this.applied = { ...settings }
    this.instance = createAuth({ ...base, ...settings })
  }

  get current(): Auth {
    return this.instance
  }

  get settings(): AuthSettings {
    return { ...this.applied }
  }

  /** Builds a new instance when a setting it reads changed. Returns true when it swapped. */
  apply(settings: AuthSettings): boolean {
    if (
      settings.sessionIdleDays === this.applied.sessionIdleDays &&
      settings.otpViaTelegram === this.applied.otpViaTelegram
    )
      return false
    this.instance = createAuth({ ...this.base, ...settings })
    this.applied = { ...settings }
    return true
  }
}

/** Better Auth's own log lines: the level and the facts of any error passed along, never the message itself. */
export function logBetterAuth(level: string, _message: string, ...args: unknown[]): void {
  const error = args.find((arg) => arg instanceof Error)
  const facts = error ? errorFacts(error) : {}
  if (level === "error") log.error("better auth reported an error", facts)
  else if (level === "warn") log.warn("better auth reported a warning", facts)
}
