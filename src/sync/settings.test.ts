import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_T3_URL, dataDir, defaultT3Cli, envFileToRead, resolveSettings } from "./settings.ts"

// The sync's settings: an option, the env file, the environment, the settings file, then the default.

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function home(settings?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "adiutor-sync-settings-"))
  temps.push(dir)
  const env = { HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") }
  if (settings !== undefined) {
    mkdirSync(dataDir("linux", env), { recursive: true })
    writeFileSync(join(dataDir("linux", env), "settings.json"), JSON.stringify(settings))
  }
  return env
}

const NOW = Date.parse("2026-11-16T12:00:00.000Z")

describe("resolveSettings", () => {
  it("takes each setting from the first place that sets it", () => {
    const env = home({
      adiutorUrl: "https://from-settings.example.com",
      t3CliPath: "/settings/t3",
      t3Url: "http://127.0.0.1:4000",
      overviewDir: "/settings/overview",
    })
    const given = {
      platform: "linux" as const,
      env: { ...env, ADIUTOR_URL: "https://from-env.example.com", T3CODE_CLI_PATH: "/env/t3" },
      envFileVars: { ADIUTOR_URL: "https://from-file.example.com/" },
      now: NOW,
      flags: { overviewDir: "/flag/overview" },
    }
    // The default sync.env, and any env file of connect, come after the environment, as before.
    expect(resolveSettings(given).url).toBe("https://from-env.example.com")
    // An env file given with --env to run (and the other commands) wins over the environment, as before.
    const resolved = resolveSettings({ ...given, envFileFirst: true })
    expect(resolved).toMatchObject({
      url: "https://from-file.example.com",
      cliPath: "/env/t3",
      t3Url: "http://127.0.0.1:4000",
      overviewDir: "/flag/overview",
      problems: [],
    })
    expect(resolveSettings({ platform: "linux", env, now: NOW, flags: { url: "https://flag.example.com" } }).url).toBe(
      "https://flag.example.com",
    )
  })

  it("defaults to T3's own CLI and address, and no Adiutor", () => {
    const env = home()
    expect(resolveSettings({ platform: "linux", env, now: NOW })).toEqual({
      url: undefined,
      cliPath: join(env.HOME, ".t3", "bin", "t3"),
      t3Url: DEFAULT_T3_URL,
      overviewDir: undefined,
      pause: null,
      problems: [],
    })
    expect(defaultT3Cli("win32", { USERPROFILE: "C:\\Users\\dev" })).toBe("C:\\Users\\dev\\.t3\\bin\\t3.cmd")
  })

  it("reports addresses that are not usable, without their values", () => {
    const env = home({ t3Url: "http://203.0.113.5:3773" })
    const resolved = resolveSettings({
      platform: "linux",
      env: { ...env, ADIUTOR_URL: "http://adiutor.example.com/app" },
      now: NOW,
    })
    expect(resolved.url).toBeUndefined()
    expect(resolved.t3Url).toBeUndefined()
    expect(resolved.problems).toHaveLength(2)
    expect(resolved.problems.join(" ")).not.toContain("203.0.113")
  })

  it("reads the tray's pause, and drops one that ended", () => {
    expect(resolveSettings({ platform: "linux", env: home({ pause: { until: null } }), now: NOW }).pause).toEqual({
      until: null,
    })
    const until = "2026-11-16T13:00:00.000Z"
    expect(resolveSettings({ platform: "linux", env: home({ pause: { until } }), now: NOW }).pause).toEqual({ until })
    expect(
      resolveSettings({ platform: "linux", env: home({ pause: { until } }), now: NOW + 7_200_000 }).pause,
    ).toBeNull()
  })

  it("reports a damaged settings file instead of guessing", () => {
    const env = home()
    mkdirSync(dataDir("linux", env), { recursive: true })
    writeFileSync(join(dataDir("linux", env), "settings.json"), "{")
    expect(resolveSettings({ platform: "linux", env, now: NOW }).problems).toEqual([
      "the settings file is not a JSON object",
    ])
  })
})

describe("envFileToRead", () => {
  it("reads --env, or the default sync.env only when it exists", () => {
    const env = home()
    expect(envFileToRead("/given.env", "linux", env)).toEqual({ path: "/given.env", required: true })
    expect(envFileToRead(undefined, "linux", env)).toBeUndefined()
    mkdirSync(dataDir("linux", env), { recursive: true })
    writeFileSync(join(dataDir("linux", env), "sync.env"), "ADIUTOR_URL=https://adiutor.example.com\n")
    expect(envFileToRead(undefined, "linux", env)).toEqual({
      path: join(dataDir("linux", env), "sync.env"),
      required: false,
    })
  })
})
