// Operator commands, run inside the Adiutor container on the server:
//   docker compose exec adiutor node dist/server/cli.js reset-password
// Sets a new random password through Better Auth's documented reset and prints it once. Every session and every agent
// connection ends (D7: an identity change); two-factor stays as it is (sign in with the authenticator or a backup code).
// Uses the same configuration as the server, and runs in the server's own container (`exec`, never `run`): agent
// access tells a change under way from a crashed one by its process (oauth/process.ts).
import { writeSync } from "node:fs"
import { resetOwnerPassword } from "./auth/recovery.ts"
import { ConfigError, loadConfig } from "./config.ts"
import { createDatabase } from "./db/client.ts"
import { createAgentAccess } from "./oauth/access.ts"
import { getSettings } from "./services/admin.ts"
import { createSecretScanner } from "./services/secrets.ts"
import { createSettingsCipher } from "./settings/crypto.ts"

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
const storeDatabase = createDatabase(config.databaseUrl, { max: 2 })
let code = 0
try {
  const ctx = { db: database.db, secrets: createSecretScanner(), clock: () => new Date() }
  // The reset is an identity change: it ends every agent connection before Better Auth writes the new password.
  const access = await createAgentAccess({
    ctx,
    publicUrl: config.publicUrlText,
    cookieKeys: config.agentCookieKeys,
    storeDb: storeDatabase.db,
    cipher: createSettingsCipher(config.settingsKeys),
  })
  const result = await resetOwnerPassword({
    ctx,
    secrets: config.authSecrets,
    publicUrl: config.publicUrl,
    trustedProxies: config.trustedProxies,
    sessionIdleDays: (await getSettings(ctx.db)).sessionIdleDays,
    identityChanges: access.identity,
  })
  if (!result) {
    err("No owner exists yet. Open Adiutor in a browser to create it.")
    code = 1
  } else {
    out(`Username: ${result.username}`)
    out(`New password: ${result.password}`)
    out("Every session and every agent connection was ended. Two-factor authentication is unchanged.")
    out("Sign in with this password and your authenticator (or a saved backup code), then change the password in")
    out("Account (the account menu).")
  }
} catch (error) {
  err(`The reset failed: ${error instanceof Error ? error.name : "unknown error"}. Nothing was changed.`)
  code = 1
} finally {
  await Promise.all([database.close(), storeDatabase.close()])
}
process.exit(code)
