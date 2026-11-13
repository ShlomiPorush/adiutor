// Operator commands, run inside the Adiutor container on the server:
//   docker compose exec adiutor node dist/server/cli.js reset-password
// Sets a new random password through Better Auth's documented reset and prints it once. Every session ends; two-factor
// stays as it is (sign in with the authenticator or a backup code). Uses the same configuration as the server.
import { writeSync } from "node:fs"
import { resetOwnerPassword } from "./auth/recovery.ts"
import { ConfigError, loadConfig } from "./config.ts"
import { createDatabase } from "./db/client.ts"
import { getSettings } from "./services/admin.ts"
import { createSecretScanner } from "./services/secrets.ts"

const out = (line: string) => writeSync(1, `${line}\n`)
const err = (line: string) => writeSync(2, `${line}\n`)

if (process.argv[2] !== "reset-password" || process.argv.length !== 3) {
  err("Usage: node dist/server/cli.js reset-password")
  process.exit(2)
}

let config: ReturnType<typeof loadConfig>
try {
  config = loadConfig()
} catch (error) {
  err(error instanceof ConfigError ? error.message : "The configuration could not be read.")
  process.exit(1)
}

const database = createDatabase(config.databaseUrl)
let code = 0
try {
  const ctx = { db: database.db, secrets: createSecretScanner(), clock: () => new Date() }
  const result = await resetOwnerPassword({
    ctx,
    secrets: config.authSecrets,
    publicUrl: config.publicUrl,
    trustedProxies: config.trustedProxies,
    sessionIdleDays: (await getSettings(ctx.db)).sessionIdleDays,
  })
  if (!result) {
    err("No owner exists yet. Open Adiutor in a browser to create it.")
    code = 1
  } else {
    out(`Username: ${result.username}`)
    out(`New password: ${result.password}`)
    out("Every session was ended. Two-factor authentication is unchanged.")
    out("Sign in with this password and your authenticator (or a saved backup code), then change the password in")
    out("Account (the account menu).")
  }
} catch (error) {
  err(`The reset failed: ${error instanceof Error ? error.name : "unknown error"}. Nothing was changed.`)
  code = 1
} finally {
  await database.close()
}
process.exit(code)
