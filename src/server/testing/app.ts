import type { Context } from "hono"
import type { AppDeps } from "../app.ts"
import { AuthHolder, type AuthOptions, type AuthSettings } from "../auth/auth.ts"
import type { EnvOverrides } from "../config.ts"
import { authUser } from "../db/schema.ts"
import type { RateLimiter } from "../http/auth.ts"
import { ReloadableSecretScanner } from "../services/secrets.ts"
import { createSettingsCipher } from "../settings/crypto.ts"
import { SettingsRuntime } from "../settings/runtime.ts"
import { TelegramService } from "../telegram/runtime.ts"
import type { TelegramRuntime } from "../telegram/status.ts"
import { TEST_ORIGIN, TestBrowser } from "./browser.ts"
import type { TestDatabase } from "./db.ts"
import { testSecret } from "./secrets.ts"

// The app's core for integration tests: Better Auth on the test database, the settings runtime and a Telegram
// service that stays off until a test sets it up, with the configuration and limits a test chooses.

/** New for every test process (one per test file). */
export const TEST_AUTH_SECRET = testSecret()
export const TEST_SETTINGS_KEY = testSecret()

type Core = NonNullable<AppDeps["core"]>

export type TestCoreOptions = {
  config: Core["config"]
  limiter?: RateLimiter
  clientIp?: (c: Context) => string
  overrides?: EnvOverrides
  /** The Bot API base URL for the Telegram service (a StandInBotApi). */
  telegramApiUrl?: string
  /** Settings Better Auth starts with; the defaults are the database defaults. */
  authSettings?: Partial<AuthSettings>
  /** The bot as the status and test-message routes see it; the core's own Telegram service when absent. */
  telegram?: TelegramRuntime
  /** Extra Better Auth options (trusted proxies, secrets). */
  auth?: Partial<Pick<AuthOptions, "secrets" | "trustedProxies">>
}

export type TestCore = Core & { auth: AuthHolder; runtime: SettingsRuntime; telegramService: TelegramService }

/** Better Auth's options for a test database, without the settings. */
export function testAuthBase(t: TestDatabase, publicUrl: URL, extra: TestCoreOptions["auth"] = {}) {
  return {
    ctx: t.ctx,
    secrets: extra.secrets ?? [{ version: 1, value: TEST_AUTH_SECRET }],
    publicUrl,
    trustedProxies: extra.trustedProxies ?? [],
  }
}

export function testCore(t: TestDatabase, options: TestCoreOptions): TestCore {
  const scanner = t.ctx.secrets instanceof ReloadableSecretScanner ? t.ctx.secrets : new ReloadableSecretScanner()
  const env = {
    overrides: options.overrides ?? {},
    cipher: createSettingsCipher([{ version: 1, value: TEST_SETTINGS_KEY }]),
  }
  const telegramService = new TelegramService({
    ctx: t.ctx,
    publicUrl: options.config.publicUrl,
    apiUrl: options.telegramApiUrl ?? "http://127.0.0.1:9",
    bot: { pollTimeoutSeconds: 1, retryDelayMs: 50 },
    withoutMorningJob: true,
  })
  const auth = new AuthHolder(
    {
      ...testAuthBase(t, options.config.publicUrl, options.auth),
      sendOtp: (code) => telegramService.sendSignInCode(code),
    },
    { sessionIdleDays: 30, otpViaTelegram: false, ...options.authSettings },
  )
  const runtime = new SettingsRuntime({ ctx: t.ctx, env, auth, telegram: telegramService, scanner })
  return {
    ctx: t.ctx,
    config: options.config,
    auth,
    settings: runtime,
    runtime,
    telegramService,
    telegram: options.telegram ?? telegramService,
    limiter: options.limiter,
    clientIp: options.clientIp,
  }
}

/** An agent key for the owner, created with Better Auth's server call (the UI creates keys over /api/auth). */
export async function createAgentKey(core: TestCore, name = "tests"): Promise<string> {
  const [user] = await core.ctx.db.select({ id: authUser.id }).from(authUser).limit(1)
  if (!user) throw new Error("create the owner first")
  const created = await core.auth.current.api.createApiKey({ body: { userId: user.id, name } })
  return created.key
}

const ownerSecrets = new WeakMap<TestDatabase, string>()
let ownerIp = 0

/**
 * The owner's signed-in browser (two-factor on) on an app: set up and enrolled the first time on a database (after
 * each reset), signed in again with the same authenticator afterwards. Each browser gets its own address.
 */
export async function ownerBrowser(
  t: TestDatabase,
  app: { fetch: (request: Request) => Response | Promise<Response> },
): Promise<TestBrowser> {
  const b = new TestBrowser((request) => app.fetch(request), TEST_ORIGIN, {
    "x-forwarded-for": `203.0.113.${(ownerIp++ % 250) + 1}`,
  })
  const [user] = await t.ctx.db.select({ id: authUser.id }).from(authUser).limit(1)
  const secret = ownerSecrets.get(t)
  if (user && secret) await b.signIn(secret)
  else ownerSecrets.set(t, await b.owner())
  return b
}
