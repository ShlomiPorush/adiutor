import { writeSync } from "node:fs"
import type { Server } from "node:http"
import { serve } from "@hono/node-server"
import { createApp } from "./app.ts"
import { ConfigError, loadConfig } from "./config.ts"
import { createDatabase } from "./db/client.ts"
import { log } from "./log.ts"
import { createSecretScanner } from "./services/secrets.ts"

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
const app = createApp({ checkDatabase: database.ping, core: { ctx, config } })
const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  log.info(`Mikud ${config.version} listening`, { port })
}) as Server

const shutdown = (signal: string) => {
  log.info("shutting down", { signal })
  server.close(() => {
    void database.close().then(() => process.exit(0))
  })
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
