export type VersionedKey = { version: number; value: string }

export type ServerConfig = {
  port: number
  databaseUrl: string
  /**
   * Better Auth's versioned `secrets` (ADIUTOR_AUTH_SECRETS, "2:new,1:old"): the first signs cookies and encrypts new
   * data, the others only decrypt. Each at least MIN_SECRET_BYTES bytes.
   */
  authSecrets: VersionedKey[]
  /** ADIUTOR_SETTINGS_KEYS ("2:new,1:old"): encrypts the secrets stored in Settings. Never an auth secret. */
  settingsKeys: VersionedKey[]
  /**
   * ADIUTOR_OAUTH_SECRETS ("2:new,1:old"): the cookie keys of the authorization server for agents, in the order
   * listed (newest first: the first signs, the others only verify). Never an auth secret or a settings key. Null
   * while it is not set: optional until the release that switches agents to it.
   */
  oauthSecrets: VersionedKey[] | null
  /** ADIUTOR_TRUSTED_PROXIES: the proxy addresses or CIDR ranges in front of Adiutor (Traefik), comma-separated. */
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
  telegramBotToken: "ADIUTOR_TELEGRAM_BOT_TOKEN",
  telegramChatId: "ADIUTOR_TELEGRAM_CHAT_ID",
  privateDomains: "ADIUTOR_PRIVATE_DOMAINS",
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

/** Variables Better Auth would read on its own when its options lack a value: Adiutor refuses them (need 5). */
const FOREIGN_AUTH_VARIABLES = /^(BETTER_AUTH_|AUTH_SECRET$)/

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

/** Words an example or a template writes instead of a key, in any case. */
const PLACEHOLDER_WORD = "change[-_ ]?me|replace[-_ ]?me|placeholder|example|secret|value|here"

/**
 * A whole value an example or a template holds instead of a key: only placeholder words (`change-me`,
 * `CHANGE_ME_PLACEHOLDER`), a `<...>` slot, or `your-...` / `your_...`. Matched against the whole value, so a random
 * key that happens to contain one of these is never refused. Refused for every key family.
 */
const PLACEHOLDER = new RegExp(
  `^(?:(?:${PLACEHOLDER_WORD})(?:[-_ .]+(?:${PLACEHOLDER_WORD}))*|<[^<>]*>|your[-_].*)$`,
  "is",
)

/** An obvious placeholder: a whole value from an example (PLACEHOLDER), or one character repeated. */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value) || /^(.)\1*$/su.test(value)
}

/**
 * Reads "2:new,1:old": versions are distinct non-negative integers, each value at least MIN_SECRET_BYTES bytes and
 * not a placeholder. Problems name the variable and the position, never a value.
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
    if (isPlaceholder(value))
      problems.push(`${name} entry ${index + 1} looks like an example placeholder (use 32 random bytes)`)
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
      problems.push(`${name} is set: Better Auth would read it on its own; Adiutor uses ADIUTOR_AUTH_SECRETS only`)
  // Better Auth's single legacy `secret`, removed before the first release: a value left behind must not look as if it
  // still does something. Refused even when empty, and never printed.
  if (env.ADIUTOR_AUTH_SECRET !== undefined)
    problems.push("ADIUTOR_AUTH_SECRET is no longer used: remove it; ADIUTOR_AUTH_SECRETS holds the auth keys")

  const databaseUrl = required("DATABASE_URL")
  const publicUrlText = required("ADIUTOR_PUBLIC_URL")
  const authSecretsText = required("ADIUTOR_AUTH_SECRETS")
  const settingsKeysText = required("ADIUTOR_SETTINGS_KEYS")
  const authSecrets = authSecretsText ? parseKeys("ADIUTOR_AUTH_SECRETS", authSecretsText, problems) : []
  const settingsKeys = settingsKeysText ? parseKeys("ADIUTOR_SETTINGS_KEYS", settingsKeysText, problems) : []
  const authValues = new Set(authSecrets.map((k) => k.value))
  if (settingsKeys.some((k) => authValues.has(k.value)))
    problems.push("ADIUTOR_SETTINGS_KEYS must differ from every auth secret")
  // Optional until the release that switches agents to the authorization server: empty is the same as unset.
  const oauthSecretsText = env.ADIUTOR_OAUTH_SECRETS?.trim() ?? ""
  const oauthSecrets = oauthSecretsText ? parseKeys("ADIUTOR_OAUTH_SECRETS", oauthSecretsText, problems) : null
  const settingsValues = new Set(settingsKeys.map((k) => k.value))
  if (oauthSecrets?.some((k) => authValues.has(k.value) || settingsValues.has(k.value)))
    problems.push("ADIUTOR_OAUTH_SECRETS must differ from every auth secret and settings key")

  let publicUrl: URL | undefined
  if (publicUrlText) {
    publicUrl = URL.canParse(publicUrlText) ? new URL(publicUrlText) : undefined
    if (!publicUrl || (publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:"))
      problems.push("ADIUTOR_PUBLIC_URL must be an http or https URL")
  }

  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push("DATABASE_URL must be a postgres:// URL")

  const trustedProxies = (env.ADIUTOR_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  if (trustedProxies.some((p) => !/^[0-9A-Fa-f:.]+(\/\d{1,3})?$/.test(p)))
    problems.push("ADIUTOR_TRUSTED_PROXIES must be a comma-separated list of IP addresses or CIDR ranges")

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
    settingsKeys,
    oauthSecrets,
    trustedProxies,
    publicUrl,
    migrationsDir: env.MIGRATIONS_DIR || "drizzle",
    version: env.ADIUTOR_VERSION || "dev",
    telegramApiUrl: apiUrlText,
    overrides,
    warnings,
  }
}

/** Each override on its own: an empty variable is not set; a malformed one refuses to start, naming it only. */
function readOverrides(env: NodeJS.ProcessEnv, problems: string[]): EnvOverrides {
  const overrides: EnvOverrides = {}
  const token = env.ADIUTOR_TELEGRAM_BOT_TOKEN?.trim()
  if (token) {
    if (!TELEGRAM_BOT_TOKEN.test(token))
      problems.push("ADIUTOR_TELEGRAM_BOT_TOKEN does not look like a bot token from BotFather")
    overrides.telegramBotToken = token
  }
  const chatId = env.ADIUTOR_TELEGRAM_CHAT_ID?.trim()
  if (chatId) {
    if (!TELEGRAM_CHAT_ID.test(chatId)) problems.push("ADIUTOR_TELEGRAM_CHAT_ID must be a numeric chat id")
    overrides.telegramChatId = chatId
  }
  const domains = env.ADIUTOR_PRIVATE_DOMAINS?.trim()
  if (domains) {
    const list = parseDomains(domains)
    if (list.some((d) => !DOMAIN_NAME.test(d)))
      problems.push("ADIUTOR_PRIVATE_DOMAINS must be a comma-separated list of domain names")
    overrides.privateDomains = list
  }
  return overrides
}
