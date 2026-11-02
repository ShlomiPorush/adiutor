export type VersionedKey = { version: number; value: string }

export type ServerConfig = {
  port: number
  databaseUrl: string
  /**
   * Better Auth's versioned `secrets` (MIKUD_AUTH_SECRETS, "2:new,1:old"): the first signs cookies and encrypts new
   * data, the others only decrypt. Each at least MIN_SECRET_BYTES bytes.
   */
  authSecrets: VersionedKey[]
  /** MIKUD_AUTH_SECRET, optional: Better Auth's legacy `secret`, which decrypts data from before `secrets`. */
  legacyAuthSecret: string | undefined
  /** MIKUD_SETTINGS_KEYS ("2:new,1:old"): encrypts the secrets stored in Settings. Never an auth secret. */
  settingsKeys: VersionedKey[]
  /** MIKUD_TRUSTED_PROXIES: the proxy addresses or CIDR ranges in front of Mikud (Traefik), comma-separated. */
  trustedProxies: string[]
  /** The URL the owner opens; browsers' Origin must match it. */
  publicUrl: URL
  migrationsDir: string
  version: string
  /** The Telegram Bot API base URL. Only tests and the verify stack change it, to a stand-in. */
  telegramApiUrl: string
  /** Owner settings the environment sets; each overrides the stored value, and the UI shows it as locked. */
  overrides: EnvOverrides
  /** Lines to log once at start (old variables that are no longer read). Never a value. */
  warnings: string[]
}

export type EnvOverrides = {
  telegramBotToken?: string
  telegramChatId?: string
  privateDomains?: string[]
}

/** The environment variable behind each override, named by the UI when a field is locked. */
export const OVERRIDE_VARIABLES = {
  telegramBotToken: "MIKUD_TELEGRAM_BOT_TOKEN",
  telegramChatId: "MIKUD_TELEGRAM_CHAT_ID",
  privateDomains: "MIKUD_PRIVATE_DOMAINS",
} as const satisfies Record<keyof EnvOverrides, string>

export const DEFAULT_TELEGRAM_API_URL = "https://api.telegram.org"
export const MIN_SECRET_BYTES = 32

/** A bot token as BotFather issues it, and a numeric chat id: checked for the environment and the API alike. */
export const TELEGRAM_BOT_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/
export const TELEGRAM_CHAT_ID = /^-?\d{1,20}$/
/** One domain name, lowercased, without leading or trailing dots. */
export const DOMAIN_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/

/** Configuration that refuses to start the server. Its message never includes a value. */
export class ConfigError extends Error {
  override name = "ConfigError"
}

/** Variables Better Auth would read on its own when its options lack a value: Mikud refuses them (need 5). */
const FOREIGN_AUTH_VARIABLES = /^(BETTER_AUTH_|AUTH_SECRET$)/

/** Variables of earlier versions: only warned about. */
const RETIRED = ["MIKUD_OWNER_TOKEN", "MIKUD_AGENT_TOKEN"] as const

/** Splits a comma-separated list of domain names, normalized. */
export function parseDomains(text: string): string[] {
  return text
    .split(",")
    .map((d) =>
      d
        .trim()
        .toLowerCase()
        .replace(/^\.+|\.+$/g, ""),
    )
    .filter(Boolean)
}

/**
 * Reads "2:new,1:old": versions are distinct non-negative integers, each value at least MIN_SECRET_BYTES bytes.
 * Problems name the variable and the position, never a value.
 */
function parseKeys(name: string, text: string, problems: string[]): VersionedKey[] {
  const keys: VersionedKey[] = []
  const seen = new Set<number>()
  text.split(",").forEach((raw, index) => {
    const entry = raw.trim()
    const colon = entry.indexOf(":")
    const versionText = colon > 0 ? entry.slice(0, colon) : ""
    const value = colon > 0 ? entry.slice(colon + 1).trim() : ""
    const version = /^\d{1,6}$/.test(versionText) ? Number(versionText) : Number.NaN
    if (!Number.isInteger(version) || !value) {
      problems.push(`${name} entry ${index + 1} must look like <version>:<secret>`)
      return
    }
    if (seen.has(version)) problems.push(`${name} repeats version ${version}`)
    seen.add(version)
    if (Buffer.byteLength(value, "utf8") < MIN_SECRET_BYTES)
      problems.push(`${name} entry ${index + 1} must be at least ${MIN_SECRET_BYTES} bytes (use 32 random bytes)`)
    keys.push({ version, value })
  })
  return keys
}

/**
 * Reads the server configuration from the environment and refuses an unsafe one. Only what the process needs
 * before it can read its own settings lives here alone: the database, the keys, the public URL and the proxy
 * wiring. The owner's settings (Telegram, private domains) live in the database; a variable set here overrides
 * the stored value per field.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const problems: string[] = []
  const warnings: string[] = []
  const required = (name: string) => {
    const value = env[name]
    if (!value) problems.push(`${name} is required`)
    return value ?? ""
  }

  for (const name of Object.keys(env).sort())
    if (FOREIGN_AUTH_VARIABLES.test(name) && env[name] !== undefined)
      problems.push(`${name} is set: Better Auth would read it on its own; Mikud uses MIKUD_AUTH_SECRETS only`)
  for (const name of RETIRED) if (env[name]) warnings.push(`${name} is no longer used: remove it`)

  const databaseUrl = required("DATABASE_URL")
  const publicUrlText = required("MIKUD_PUBLIC_URL")
  const authSecretsText = required("MIKUD_AUTH_SECRETS")
  const settingsKeysText = required("MIKUD_SETTINGS_KEYS")
  const authSecrets = authSecretsText ? parseKeys("MIKUD_AUTH_SECRETS", authSecretsText, problems) : []
  const settingsKeys = settingsKeysText ? parseKeys("MIKUD_SETTINGS_KEYS", settingsKeysText, problems) : []
  const legacyAuthSecret = env.MIKUD_AUTH_SECRET || undefined
  if (legacyAuthSecret && Buffer.byteLength(legacyAuthSecret, "utf8") < MIN_SECRET_BYTES)
    problems.push(`MIKUD_AUTH_SECRET must be at least ${MIN_SECRET_BYTES} bytes`)
  const authValues = new Set([...authSecrets.map((k) => k.value), ...(legacyAuthSecret ? [legacyAuthSecret] : [])])
  if (settingsKeys.some((k) => authValues.has(k.value)))
    problems.push("MIKUD_SETTINGS_KEYS must differ from every auth secret")

  let publicUrl: URL | undefined
  if (publicUrlText) {
    publicUrl = URL.canParse(publicUrlText) ? new URL(publicUrlText) : undefined
    if (!publicUrl || (publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:"))
      problems.push("MIKUD_PUBLIC_URL must be an http or https URL")
  }

  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push("DATABASE_URL must be a postgres:// URL")

  const trustedProxies = (env.MIKUD_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  if (trustedProxies.some((p) => !/^[0-9A-Fa-f:.]+(\/\d{1,3})?$/.test(p)))
    problems.push("MIKUD_TRUSTED_PROXIES must be a comma-separated list of IP addresses or CIDR ranges")

  const port = Number(env.PORT ?? 8080)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) problems.push("PORT must be a port number")

  const apiUrlText = (env.TELEGRAM_API_URL?.trim() || DEFAULT_TELEGRAM_API_URL).replace(/\/+$/, "")
  const apiUrl = URL.canParse(apiUrlText) ? new URL(apiUrlText) : undefined
  if (!apiUrl || (apiUrl.protocol !== "https:" && apiUrl.protocol !== "http:"))
    problems.push("TELEGRAM_API_URL must be an http or https URL")

  const overrides = readOverrides(env, problems)

  if (problems.length > 0 || !publicUrl) throw new ConfigError(`Invalid configuration: ${problems.join("; ")}`)

  return {
    port,
    databaseUrl,
    authSecrets,
    legacyAuthSecret,
    settingsKeys,
    trustedProxies,
    publicUrl,
    migrationsDir: env.MIGRATIONS_DIR || "drizzle",
    version: env.MIKUD_VERSION || "dev",
    telegramApiUrl: apiUrlText,
    overrides,
    warnings,
  }
}

/** Each override on its own: an empty variable is not set; a malformed one refuses to start, naming it only. */
function readOverrides(env: NodeJS.ProcessEnv, problems: string[]): EnvOverrides {
  const overrides: EnvOverrides = {}
  const token = env.MIKUD_TELEGRAM_BOT_TOKEN?.trim()
  if (token) {
    if (!TELEGRAM_BOT_TOKEN.test(token))
      problems.push("MIKUD_TELEGRAM_BOT_TOKEN does not look like a bot token from BotFather")
    overrides.telegramBotToken = token
  }
  const chatId = env.MIKUD_TELEGRAM_CHAT_ID?.trim()
  if (chatId) {
    if (!TELEGRAM_CHAT_ID.test(chatId)) problems.push("MIKUD_TELEGRAM_CHAT_ID must be a numeric chat id")
    overrides.telegramChatId = chatId
  }
  const domains = env.MIKUD_PRIVATE_DOMAINS?.trim()
  if (domains) {
    const list = parseDomains(domains)
    if (list.some((d) => !DOMAIN_NAME.test(d)))
      problems.push("MIKUD_PRIVATE_DOMAINS must be a comma-separated list of domain names")
    overrides.privateDomains = list
  }
  return overrides
}
