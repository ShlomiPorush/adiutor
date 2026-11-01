// Operator commands, run inside the Mikud container on the server:
//   docker compose exec mikud node dist/server/cli.js reset-password
// Sets a new random password and prints it once, removes TOTP (it is set up again after signing in), ends
// every session and writes an audit row (actor system, label cli). Uses the same configuration as the server.
import { writeSync } from "node:fs"
import { createAuth, passwordHasher } from "./auth/auth.ts"
import { ConfigError, loadConfig } from "./config.ts"
import { createDatabase } from "./db/client.ts"
import { resetPassword } from "./services/account.ts"
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
  const ctx = { db: database.db, secrets: createSecretScanner(config.privateDomains), clock: () => new Date() }
  const auth = createAuth({ db: database.db, secret: config.authSecret, publicUrl: config.publicUrl })
  const result = await resetPassword(ctx, await passwordHasher(auth))
  if (!result) {
    err("No owner exists yet. Open Mikud in a browser to create it.")
    code = 1
  } else {
    out(`Username: ${result.username}`)
    out(`New password: ${result.password}`)
    out("Every session was ended and two-factor authentication was removed.")
    out("Sign in with this password, set up two-factor again, then change the password in Settings, Account.")
  }
} catch (error) {
  err(`The reset failed: ${error instanceof Error ? error.name : "unknown error"}. Nothing was changed.`)
  code = 1
} finally {
  await database.close()
}
process.exit(code)
