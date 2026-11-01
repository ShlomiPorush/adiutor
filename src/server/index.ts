import { existsSync, writeSync } from "node:fs"
import type { Server } from "node:http"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import { createApp } from "./app.ts"
import { createAuth } from "./auth/auth.ts"
import { ConfigError, loadConfig } from "./config.ts"
import { createDatabase } from "./db/client.ts"
import { MorningJob } from "./jobs/morning.ts"
import { errorFacts, log } from "./log.ts"
import { createSecretScanner } from "./services/secrets.ts"
import { sweepSessions } from "./services/session-policy.ts"
import { BotApi } from "./telegram/api.ts"
import { TelegramBot } from "./telegram/bot.ts"
import { TELEGRAM_OFF, type TelegramRuntime } from "./telegram/status.ts"

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

const database = createDatabase(config.databaseUrl)
try {
  await database.migrate(config.migrationsDir)
} catch (error) {
  // The driver's message may include the host but never the password; the URL itself is not logged.
  fail(`Database migration failed: ${error instanceof Error ? error.message : String(error)}`)
}

const ctx = { db: database.db, secrets: createSecretScanner(config.privateDomains), clock: () => new Date() }

// The bot and the morning message run only when both Telegram values are set.
let bot: TelegramBot | undefined
let morningJob: MorningJob | undefined
let telegram: TelegramRuntime = TELEGRAM_OFF
if (config.telegram) {
  const { botToken, chatId, apiUrl } = config.telegram
  const api = new BotApi(botToken, apiUrl)
  const telegramBot = new TelegramBot({ ctx, api, chatId, publicUrl: config.publicUrl })
  bot = telegramBot
  morningJob = new MorningJob({
    ctx,
    publicUrl: config.publicUrl,
    send: async (text, signal) => {
      await api.sendMessage(chatId, text, signal)
    },
  })
  telegram = {
    configured: true,
    polling: () => telegramBot.polling,
    send: async (text) => {
      await api.sendMessage(chatId, text)
    },
  }
} else {
  log.info("telegram is not configured: the bot and the morning message are off")
}

// The image holds the built UI in dist/web next to the server bundle; a checkout without a UI build serves the API only.
const webRoot = process.env.MIKUD_WEB_DIR ?? "dist/web"
const web = existsSync(join(webRoot, "index.html")) ? { root: webRoot } : undefined
const auth = createAuth({ db: database.db, secret: config.authSecret, publicUrl: config.publicUrl })
const app = createApp({
  checkDatabase: database.ping,
  core: { ctx, config, auth, lockAuth: database.lockAuth, telegram },
  web,
})

// Ended and expired browser sessions are removed every hour.
const sweep = () =>
  void sweepSessions(ctx).catch((error: unknown) => log.error("the session sweep failed", errorFacts(error)))
sweep()
const sweeper = setInterval(sweep, 3_600_000)
sweeper.unref()
const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  log.info(`Mikud ${config.version} listening`, { port })
}) as Server

bot?.start()
try {
  await morningJob?.start()
} catch (error) {
  fail(`The morning job could not start: ${error instanceof Error ? error.name : "unknown error"}`)
}

const shutdown = (signal: string) => {
  log.info("shutting down", { signal })
  clearInterval(sweeper)
  void Promise.all([bot?.stop(), morningJob?.stop()]).finally(() => {
    server.close(() => {
      void database.close().then(() => process.exit(0))
    })
  })
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
