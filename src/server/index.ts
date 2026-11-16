import { existsSync, writeSync } from "node:fs"
import type { Server } from "node:http"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { createApp, socketAddress } from "./app.ts"
import { AuthHolder } from "./auth/auth.ts"
import { ConfigError, loadConfig } from "./config.ts"
import { createDatabase, migrationFailure } from "./db/client.ts"
import { clientAddress } from "./http/auth.ts"
import { errorFacts, log } from "./log.ts"
import { createAgentAccess } from "./oauth/access.ts"
import { agentOAuthMount } from "./oauth/routes.ts"
import { getSettings } from "./services/admin.ts"
import { ReloadableSecretScanner } from "./services/secrets.ts"
import { createSettingsCipher } from "./settings/crypto.ts"
import { effectiveTelegram } from "./settings/effective.ts"
import { SettingsRuntime } from "./settings/runtime.ts"
import { TelegramService } from "./telegram/runtime.ts"

/** Writes synchronously: console output to a pipe may still be pending when the process exits. */
function fail(msg: string): never {
  writeSync(2, `${JSON.stringify({ level: "error", msg })}\n`)
  process.exit(1)
}

let config: ReturnType<typeof loadConfig>
try {
  config = loadConfig()
} catch (error) {
  if (error instanceof ConfigError) fail(error.message)
  throw error
}
for (const warning of config.warnings) log.warn(warning)

const database = createDatabase(config.databaseUrl)
try {
  await database.migrate(config.migrationsDir)
} catch (error) {
  // The driver's message may include the host but never the password; the URL itself is not logged. Drizzle wraps a
  // failed statement in DrizzleQueryError ("Failed query: ..."); PostgreSQL's own message (a migration's RAISE
  // EXCEPTION, for example) is its cause.
  fail(`Database migration failed: ${migrationFailure(error)}`)
}

const scanner = new ReloadableSecretScanner()
const ctx = { db: database.db, secrets: scanner, clock: () => new Date() }
const env = { overrides: config.overrides, cipher: createSettingsCipher(config.settingsKeys) }
const telegram = new TelegramService({ ctx, publicUrl: config.publicUrl, apiUrl: config.telegramApiUrl })

// Agent access by approval (oauth/): the authorization server for agents on a small pool of its own (an approval holds
// a transaction of the main pool while the library stores its grant), its cookies signed with ADIUTOR_OAUTH_SECRETS.
// Built before Better Auth, whose identity changes end every agent connection (D7).
const storeDatabase = createDatabase(config.databaseUrl, { max: 4 })
const access = await createAgentAccess({
  ctx,
  publicUrl: config.publicUrlText,
  cookieKeys: config.oauthSecrets.map((k) => k.value),
  storeDb: storeDatabase.db,
  cipher: env.cipher,
})
if (access.issuerProblem) log.warn("agents cannot connect under this public URL", { problem: access.issuerProblem })

const settings = await getSettings(ctx.db)
const auth = new AuthHolder(
  {
    ctx,
    secrets: config.authSecrets,
    publicUrl: config.publicUrl,
    trustedProxies: config.trustedProxies,
    sendOtp: (code) => telegram.sendSignInCode(code),
    identityChanges: access.identity,
  },
  {
    sessionIdleDays: settings.sessionIdleDays,
    otpViaTelegram: settings.otpViaTelegram && effectiveTelegram(settings, env.overrides, env.cipher).state === "on",
  },
)
const runtime = new SettingsRuntime({ ctx, env, auth, telegram, scanner })
try {
  // The secret check's domains, and the bot with the morning job when Telegram is set up.
  await runtime.apply(settings)
} catch (error) {
  fail(`Telegram could not start: ${error instanceof Error ? error.name : "unknown error"}`)
}
const pair = effectiveTelegram(settings, env.overrides, env.cipher)
if (pair.state === "incomplete") log.warn("telegram is incomplete: the bot is off", { missing: pair.missing })

// The image holds the built UI in dist/web next to the server bundle; a checkout without a UI build serves the API only.
const webRoot = process.env.ADIUTOR_WEB_DIR ?? "dist/web"
const web = existsSync(join(webRoot, "index.html")) ? { root: webRoot } : undefined
// The agent skill served at /agents/skill/: skill/adiutor beside dist/ (the image copies it to /app/skill/adiutor).
const skillDir = fileURLToPath(new URL("../../skill/adiutor", import.meta.url))
const agentOAuth = agentOAuthMount(access, undefined, undefined, undefined, skillDir)
const app = createApp({
  checkDatabase: database.ping,
  core: {
    ctx,
    config,
    auth,
    settings: runtime,
    telegram,
    clientIp: clientAddress(config.trustedProxies, socketAddress),
  },
  web,
  agentOAuth,
})

// Connections made under another public URL, or left active while agents are off, end before the first request; the
// sweep then runs every 15 minutes.
await access.start()

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  log.info(`Adiutor ${config.version} listening`, { port })
}) as Server

const shutdown = (signal: string) => {
  log.info("shutting down", { signal })
  // The server stops taking requests at once, while Telegram stops: an agent call still open then writes its audit row
  // by its deadline, within the container's stop grace period (docker-compose.yml).
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  const stopped = telegram
    .stop()
    .catch((error: unknown) => log.error("telegram did not stop cleanly", errorFacts(error)))
  void Promise.all([closed, stopped]).then(() =>
    // The agent calls still running write their audit rows before the pools close.
    agentOAuth
      .drain()
      .catch((error: unknown) => log.error("agent calls did not finish cleanly", errorFacts(error)))
      .finally(() => {
        access.stop()
        void Promise.all([database.close(), storeDatabase.close()]).then(() => process.exit(0))
      }),
  )
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
