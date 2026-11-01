export type ServerConfig = {
  port: number
  databaseUrl: string
  ownerToken: string
  agentToken: string
  /** The URL the owner opens; browsers' Origin must match it. */
  publicUrl: URL
  migrationsDir: string
  version: string
}

export const MIN_TOKEN_LENGTH = 32

/** Configuration that refuses to start the server. Its message never includes a value. */
export class ConfigError extends Error {
  override name = "ConfigError"
}

/**
 * Reads the server configuration from the environment and refuses an unsafe one: both tokens are
 * required, at least MIN_TOKEN_LENGTH characters long and different from each other.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const problems: string[] = []
  const required = (name: string) => {
    const value = env[name]
    if (!value) problems.push(`${name} is required`)
    return value ?? ""
  }

  const databaseUrl = required("DATABASE_URL")
  const ownerToken = required("MIKUD_OWNER_TOKEN")
  const agentToken = required("MIKUD_AGENT_TOKEN")
  const publicUrlText = required("MIKUD_PUBLIC_URL")

  for (const [name, token] of [
    ["MIKUD_OWNER_TOKEN", ownerToken],
    ["MIKUD_AGENT_TOKEN", agentToken],
  ] as const) {
    if (token && token.length < MIN_TOKEN_LENGTH)
      problems.push(`${name} must be at least ${MIN_TOKEN_LENGTH} characters (use 32 random bytes)`)
  }
  if (ownerToken && ownerToken === agentToken) problems.push("MIKUD_OWNER_TOKEN and MIKUD_AGENT_TOKEN must differ")

  let publicUrl: URL | undefined
  if (publicUrlText) {
    publicUrl = URL.canParse(publicUrlText) ? new URL(publicUrlText) : undefined
    if (!publicUrl || (publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:"))
      problems.push("MIKUD_PUBLIC_URL must be an http or https URL")
  }

  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push("DATABASE_URL must be a postgres:// URL")

  const port = Number(env.PORT ?? 8080)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) problems.push("PORT must be a port number")

  if (problems.length > 0 || !publicUrl) throw new ConfigError(`Invalid configuration: ${problems.join("; ")}`)

  return {
    port,
    databaseUrl,
    ownerToken,
    agentToken,
    publicUrl,
    migrationsDir: env.MIGRATIONS_DIR || "drizzle",
    version: env.MIKUD_VERSION || "dev",
  }
}
