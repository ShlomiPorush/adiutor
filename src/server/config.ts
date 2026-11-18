import { hkdfSync } from "node:crypto"
import { KEY_PROBLEM_TEXT, normalizeKey, readPrivateKey } from "./github/key.ts"

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
   * The cookie keys of the authorization server for agents, one derived from each auth secret in the order listed
   * (newest first: the first signs, the others only verify), so rotating ADIUTOR_AUTH_SECRETS rotates them too.
   */
  agentCookieKeys: string[]
  /** ADIUTOR_TRUSTED_PROXIES: the proxy addresses or CIDR ranges in front of Adiutor (Traefik), comma-separated. */
  trustedProxies: string[]
  /** The URL the owner opens; browsers' Origin must match it. */
  publicUrl: URL
  /**
   * ADIUTOR_PUBLIC_URL as written. The authorization server for agents refuses a URL that a browser would spell
   * differently (oauth/issuer.ts), which the parsed `publicUrl` no longer shows.
   */
  publicUrlText: string
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
  /** The GitHub App's id, digits only. */
  githubAppId?: string
  /** The App's private key, normalized (github/key.ts) and checked locally. */
  githubPrivateKey?: string
  /** The installation ids the server may read; each is checked against GitHub at every pull. */
  githubInstallations?: number[]
}

/** The environment variable behind each override, named by the UI when a field is locked. */
export const OVERRIDE_VARIABLES = {
  telegramBotToken: "ADIUTOR_TELEGRAM_BOT_TOKEN",
  telegramChatId: "ADIUTOR_TELEGRAM_CHAT_ID",
  privateDomains: "ADIUTOR_PRIVATE_DOMAINS",
  githubAppId: "ADIUTOR_GITHUB_APP_ID",
  githubPrivateKey: "ADIUTOR_GITHUB_PRIVATE_KEY",
  githubInstallations: "ADIUTOR_GITHUB_INSTALLATIONS",
} as const satisfies Record<keyof EnvOverrides, string>

export const DEFAULT_TELEGRAM_API_URL = "https://api.telegram.org"
export const MIN_SECRET_BYTES = 32

/** A bot token as BotFather issues it, and a numeric chat id: checked for the environment and the API alike. */
export const TELEGRAM_BOT_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/
export const TELEGRAM_CHAT_ID = /^-?\d{1,20}$/
/** A GitHub App id or installation id: a positive integer. */
export const GITHUB_ID = /^[1-9][0-9]{0,15}$/
/** GitHub's API, which the server reads through the owner's App only; tests point it at a stand-in by a flag. */
export const DEFAULT_GITHUB_API_ORIGIN = "https://api.github.com"

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

/** A whole value that is a `<...>` slot or one character repeated: no random key can be one. */
const CERTAIN_PLACEHOLDER = /^(?:<[^<>]*>|(.)\1*)$/su

/**
 * A word an example or a template writes instead of a key, in any case, as a token: after the start of the value or
 * a character that is not a letter or digit, and before the end or a character that is not a letter, so a digit ends
 * it (`please-change-me-...`, `CHANGE_ME_to_...`, `your_secret`, `ReplaceMe0123...`, `Example2-key`).
 */
const PLACEHOLDER_WORD =
  /(?<![a-z0-9])(?:change[-_ ]?me|replace[-_ ]?me|placeholder|example|your|secret|todo|fixme)(?![a-z])/i
/** A random key of 32 bytes has far more distinct characters; `secret-secret-...` or `abcabc...` has fewer. */
const MIN_DISTINCT_CHARACTERS = 8

/** Refused in every entry of every key family: a `<...>` slot or one character repeated. */
export function isCertainPlaceholder(value: string): boolean {
  return CERTAIN_PLACEHOLDER.test(value)
}

/**
 * Refused only in the current entry (the first, which signs or encrypts): a placeholder word as a token, or fewer
 * than MIN_DISTINCT_CHARACTERS distinct characters. A random non-hex key can rarely look like this; the way out is a
 * new hex key listed first, so this one stays listed as an older version and keeps decrypting. Older entries are
 * never refused by it.
 */
export function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_WORD.test(value) || new Set(value).size < MIN_DISTINCT_CHARACTERS
}

/**
 * Reads "2:new,1:old": versions are distinct non-negative integers, each value at least MIN_SECRET_BYTES bytes and
 * not a certain placeholder; the current (first) value not a likely one either. Problems name the variable and the
 * position, never a value.
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
    if (isCertainPlaceholder(value))
      problems.push(`${name} entry ${index + 1} looks like an example placeholder (use 32 random bytes)`)
    else if (index === 0 && looksLikePlaceholder(value))
      problems.push(
        `${name} entry 1 looks like an example placeholder: generate a new key with openssl rand -hex 32, list it ` +
          "first under a new version, and keep this one after it as an older version",
      )
    keys.push({ version, value })
  })
  return keys
}

/**
 * The cookie keys of the authorization server for agents (`oidc-provider`'s `cookies.keys`): one HKDF-SHA256 key per
 * auth secret, in the order given, under a label of their own, so none equals or reveals the secret Better Auth uses.
 */
export function deriveAgentCookieKeys(authSecrets: VersionedKey[]): string[] {
  return authSecrets.map((k) =>
    Buffer.from(hkdfSync("sha256", k.value, "adiutor", "agent-access-cookies", 32)).toString("base64"),
  )
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
  // Required by 0.2.0 only: existing .env, stack.env and pr.env files still hold it, so a leftover only warns. Its
  // value is never read.
  if (env.ADIUTOR_OAUTH_SECRETS !== undefined)
    warnings.push(
      "ADIUTOR_OAUTH_SECRETS is no longer read: remove it; the agent cookie keys come from ADIUTOR_AUTH_SECRETS",
    )

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
    agentCookieKeys: deriveAgentCookieKeys(authSecrets),
    trustedProxies,
    publicUrl,
    publicUrlText,
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
  const appId = env.ADIUTOR_GITHUB_APP_ID?.trim()
  if (appId) {
    if (!GITHUB_ID.test(appId)) problems.push("ADIUTOR_GITHUB_APP_ID must be the App's numeric id")
    overrides.githubAppId = appId
  }
  const key = env.ADIUTOR_GITHUB_PRIVATE_KEY?.trim()
  if (key) {
    // Checked locally only: start never calls GitHub. The message never repeats the value.
    const read = readPrivateKey(key)
    if ("problem" in read) problems.push(`ADIUTOR_GITHUB_PRIVATE_KEY ${KEY_PROBLEM_TEXT[read.problem]}`)
    overrides.githubPrivateKey = normalizeKey(key)
  }
  const installations = env.ADIUTOR_GITHUB_INSTALLATIONS?.trim()
  if (installations) {
    const ids = installations
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
    if (ids.some((id) => !GITHUB_ID.test(id)))
      problems.push("ADIUTOR_GITHUB_INSTALLATIONS must be a comma-separated list of installation ids")
    overrides.githubInstallations = [...new Set(ids.filter((id) => GITHUB_ID.test(id)).map(Number))]
  }
  return overrides
}

/**
 * Whether the environment means GitHub to be on: it names the App or its installations. The server then refuses to
 * start without a private key in effect (index.ts), rather than run with GitHub silently off.
 */
export const githubMeantOn = (overrides: EnvOverrides) =>
  overrides.githubAppId !== undefined || overrides.githubInstallations !== undefined

/**
 * The GitHub API origin from the command line (`--github-api-origin=<origin>`), never from the environment: only the
 * verification stack passes it, to point the server at a stand-in. Production's command has no such flag.
 */
export function githubApiOrigin(argv: readonly string[]): string {
  const prefix = "--github-api-origin="
  const flag = argv.find((arg) => arg.startsWith(prefix))
  if (flag === undefined) return DEFAULT_GITHUB_API_ORIGIN
  const value = flag.slice(prefix.length)
  const url = URL.canParse(value) ? new URL(value) : undefined
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== value.replace(/\/+$/, ""))
    throw new ConfigError("--github-api-origin must be an http or https origin, without a path")
  return url.origin
}
