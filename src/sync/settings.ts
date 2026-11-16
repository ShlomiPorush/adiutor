// The sync's settings: Adiutor's address, the T3 CLI, T3's address and the overview folder. Each comes from the first
// of: a command-line option, the env file (--env, or the default sync.env when it exists), the environment, the
// settings file (settings.json in the data folder, which the tray writes), then the default. The settings file holds
// no secret and the engine never writes it. Error messages never include a value.

import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, win32 } from "node:path"
import { defaultEnvFile } from "./connect.ts"
import { ClientError } from "./errors.ts"
import { asObject, asString, asTime, parseJson } from "./json.ts"
import { credentialsDir, issuerOf } from "./oauth.ts"

/** The data folder: %LOCALAPPDATA%\adiutor on Windows, ~/.config/adiutor elsewhere; the connection folder is in it. */
export function dataDir(platform: NodeJS.Platform, env: Record<string, string | undefined>): string {
  return dirname(credentialsDir(platform, env))
}

export const SETTINGS_FILE = "settings.json"

/** T3's address by default: the T3 server of this computer. */
export const DEFAULT_T3_URL = "http://127.0.0.1:3773"

/** The T3 CLI where T3 installs it: %USERPROFILE%\.t3\bin\t3.cmd on Windows, ~/.t3/bin/t3 elsewhere. */
export function defaultT3Cli(platform: NodeJS.Platform, env: Record<string, string | undefined>): string {
  return platform === "win32"
    ? win32.join(env.USERPROFILE || homedir(), ".t3", "bin", "t3.cmd")
    : join(env.HOME || homedir(), ".t3", "bin", "t3")
}

export type SettingsFile = {
  adiutorUrl?: string
  t3CliPath?: string
  t3Url?: string
  overviewDir?: string
  /** Set by the tray: paused until a time, or until resumed (null). */
  pause?: { until: string | null }
}

/** The settings file, or empty when there is none. A damaged file is reported, never guessed. */
export function readSettingsFile(path: string): { settings: SettingsFile; problem?: string } {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: {} }
    return { settings: {}, problem: "the settings file cannot be read" }
  }
  let root: Record<string, unknown> | undefined
  try {
    root = asObject(parseJson(text, "the settings file"))
  } catch {
    root = undefined
  }
  if (!root) return { settings: {}, problem: "the settings file is not a JSON object" }
  const text_ = (name: string) => {
    const value = asString(root?.[name])?.trim()
    return value ? value : undefined
  }
  const pauseData = asObject(root.pause)
  const settings: SettingsFile = {
    adiutorUrl: text_("adiutorUrl"),
    t3CliPath: text_("t3CliPath"),
    t3Url: text_("t3Url"),
    overviewDir: text_("overviewDir"),
    ...(pauseData ? { pause: { until: asTime(pauseData.until) } } : {}),
  }
  return { settings }
}

/** The four settings by name: the env file's and the environment's names, then the settings file's keys. */
const NAMES = {
  url: { env: "ADIUTOR_URL", file: "adiutorUrl" },
  cliPath: { env: "T3CODE_CLI_PATH", file: "t3CliPath" },
  t3Url: { env: "ADIUTOR_T3_URL", file: "t3Url" },
  overviewDir: { env: "ADIUTOR_OVERVIEW_DIR", file: "overviewDir" },
} as const

export type Resolved = {
  url?: string
  cliPath: string
  t3Url?: string
  overviewDir?: string
  pause: { until: string | null } | null
  /** Settings that cannot be used, without their values. */
  problems: string[]
  /** The env file that was read, if any. */
  envFile?: string
}

/** T3's address as an origin: http only on this computer, https elsewhere, the address alone. */
export function t3Origin(raw: string): string {
  try {
    return issuerOf(raw)
  } catch (error) {
    if (error instanceof ClientError)
      throw new ClientError("insecure_url", "T3's address must be its address alone: http on this computer, or https.")
    throw error
  }
}

export function resolveSettings(input: {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** The env file's values (parsed by the caller), or undefined when none was read. */
  envFileVars?: Record<string, string>
  envFile?: string
  /** Milliseconds since the epoch, for the pause. */
  now: number
  /** Command-line options, which win. */
  flags?: { url?: string; overviewDir?: string }
}): Resolved {
  const { platform, env } = input
  const file = readSettingsFile(join(dataDir(platform, env), SETTINGS_FILE))
  const problems = file.problem ? [file.problem] : []
  const pick = (name: keyof typeof NAMES, flag?: string) => {
    const from = [flag, input.envFileVars?.[NAMES[name].env], env[NAMES[name].env], file.settings[NAMES[name].file]]
    for (const value of from) {
      const trimmed = value?.trim()
      if (trimmed) return trimmed
    }
    return undefined
  }
  let url = pick("url", input.flags?.url)
  if (url !== undefined) {
    try {
      url = issuerOf(url)
    } catch {
      url = undefined
      problems.push("ADIUTOR_URL must be Adiutor's address alone: https, or http on localhost")
    }
  }
  let t3Url: string | undefined = pick("t3Url") ?? DEFAULT_T3_URL
  try {
    t3Url = t3Origin(t3Url)
  } catch {
    t3Url = undefined
    problems.push("T3's address must be its address alone: http on this computer, or https")
  }
  const pause = file.settings.pause ?? null
  return {
    url,
    cliPath: pick("cliPath") ?? defaultT3Cli(platform, env),
    t3Url,
    overviewDir: pick("overviewDir", input.flags?.overviewDir),
    // A pause that ended is no pause.
    pause: pause && (pause.until === null || Date.parse(pause.until) > input.now) ? pause : null,
    problems,
    ...(input.envFile ? { envFile: input.envFile } : {}),
  }
}

/** The env file to read: --env, or the default sync.env when it exists. */
export function envFileToRead(
  explicit: string | undefined,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): { path: string; required: boolean } | undefined {
  if (explicit) return { path: explicit, required: true }
  const path = defaultEnvFile(platform, env)
  try {
    return statSync(path).isFile() ? { path, required: false } : undefined
  } catch {
    return undefined
  }
}
