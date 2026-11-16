import { type ExecFileException, execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

// Child processes run through execFile with an argument array and no shell. The one exception is a
// Windows batch file (the T3 CLI is installed as t3.cmd): Node refuses to start one without a shell,
// so it runs through cmd.exe with a command line built here. cmd.exe expands %VAR% even inside
// quotes, so a value holding a quote, a percent sign or a line break is refused instead of escaped;
// every other character is safe inside the double quotes.

export type Invocation = { file: string; args: string[]; windowsVerbatimArguments: boolean }

const CMD_UNSAFE = /["%\r\n\0]/

export class UnsafeArgumentError extends Error {
  override name = "UnsafeArgumentError"
}

export function buildInvocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string | undefined = process.env.ComSpec,
): Invocation {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    for (const part of [command, ...args]) {
      if (CMD_UNSAFE.test(part))
        throw new UnsafeArgumentError("refusing a quote, percent sign or line break in a cmd.exe argument")
    }
    // /d skips AutoRun commands, /v:off keeps ! literal, /s /c strips the outer pair of quotes.
    const line = [command, ...args].map((part) => `"${part}"`).join(" ")
    return {
      file: comspec || "cmd.exe",
      args: ["/d", "/v:off", "/s", "/c", `"${line}"`],
      windowsVerbatimArguments: true,
    }
  }
  return { file: command, args, windowsVerbatimArguments: false }
}

/** A variable of the environment; Windows names are case-insensitive (Path), and a copied environment keeps them. */
function envValue(env: Record<string, string | undefined>, name: string, anyCase: boolean): string | undefined {
  return Object.entries(env).find(([key]) => (anyCase ? key.toUpperCase() === name : key === name))?.[1]
}

/** The extensions a Windows command can have here: what CreateProcess starts and the batch files above. */
const WINDOWS_RUNNABLE = [".com", ".exe", ".bat", ".cmd"]

const isFile = (path: string) =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  )
const isExecutable = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  )

/**
 * The full path of a command found on PATH, or undefined. Node starts only .com and .exe files by bare name on
 * Windows, so a command installed as a batch file (npm's codex.cmd) is looked up here, in PATHEXT's order, and the
 * path then goes to buildInvocation. The current folder is never searched.
 */
export async function findCommand(
  name: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const lookup = (wanted: string) => envValue(env, wanted, platform === "win32")
  // A relative entry ("." or empty) would search the current folder: skipped.
  const dirs = (lookup("PATH") ?? "")
    .split(platform === "win32" ? ";" : ":")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => isAbsolute(dir))
  if (platform === "win32") {
    const order = (lookup("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((ext) => ext.trim().toLowerCase())
      .filter((ext) => WINDOWS_RUNNABLE.includes(ext))
    for (const dir of dirs) {
      for (const ext of order) {
        const candidate = join(dir, `${name}${ext}`)
        if (await isFile(candidate)) return candidate
      }
    }
    return undefined
  }
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if ((await isFile(candidate)) && (await isExecutable(candidate))) return candidate
  }
  return undefined
}

/** A Windows path that names its drive, such as C:\Windows. */
export const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:[\\/]/

/**
 * A Windows component (icacls, rundll32, setx) by its full path in %SystemRoot%\System32, or undefined. Started by bare
 * name, Node (libuv) looks in the current folder before PATH, so a planted icacls.exe next to the command would run.
 * System32 is where Windows installs these tools and only administrators can write to it; PATH is not consulted.
 */

export async function systemCommand(
  name: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const root = envValue(env, "SYSTEMROOT", true)?.trim()
  if (!root || !isAbsolute(root)) return undefined
  // On Windows a root without a drive (\Windows) is absolute to Node but lands on the current drive: refuse it.
  if (platform === "win32" && !WINDOWS_DRIVE_ROOT.test(root)) return undefined
  const candidate = join(root, "System32", `${name}.exe`)
  return (await isFile(candidate)) ? candidate : undefined
}

/** The environment for a child process: the agent token never leaves this process. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return withoutVariables(env, ["ADIUTOR_AGENT_TOKEN"])
}

/**
 * Variables that move T3's data folder away from its default (T3's own server config: T3CODE_HOME is the data folder,
 * VITE_DEV_SERVER_URL selects its dev state, T3CODE_BOOTSTRAP_FD can carry a data folder). The sync reads T3's default
 * data folder only, so every T3 CLI call runs without them.
 */
export const T3_DATA_OVERRIDES = ["T3CODE_HOME", "VITE_DEV_SERVER_URL", "T3CODE_BOOTSTRAP_FD"] as const

/** The environment of a T3 CLI call: the child's environment without T3's data folder overrides. */
export function t3Env(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return withoutVariables(childEnv(env), T3_DATA_OVERRIDES)
}

/** A copy without the named variables, in any case (Windows names are case-insensitive, and a copy keeps them). */
function withoutVariables(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const drop = new Set(names.map((name) => name.toUpperCase()))
  return Object.fromEntries(Object.entries(env).filter(([key]) => !drop.has(key.toUpperCase())))
}

export type RunResult = {
  /** Exit code; null when the process did not start or was killed. */
  code: number | null
  stdout: string
  stderr: string
  /** Why the run failed; undefined on success. Never holds a secret. */
  error?: string
}

export type Runner = (
  command: string,
  args: string[],
  options: {
    cwd?: string
    timeoutMs: number
    /** The child's environment before childEnv; the process's own when not given. */
    env?: NodeJS.ProcessEnv
    /** Called with the child's process id once it started. */
    onSpawn?: (pid: number) => void
  },
) => Promise<RunResult>

export const runProcess: Runner = (command, args, options) =>
  new Promise((resolve) => {
    let invocation: Invocation
    try {
      invocation = buildInvocation(command, args)
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error: (error as Error).message })
      return
    }
    const child = execFile(
      invocation.file,
      invocation.args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 256 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        env: childEnv(options.env ?? process.env),
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr })
          return
        }
        const code = typeof error.code === "number" ? error.code : null
        let reason: string
        if (error.killed) reason = `timed out after ${Math.round(options.timeoutMs / 1000)} s`
        else if (code !== null) reason = `exit code ${code}`
        else reason = `could not start (${String(error.code ?? "unknown error")})`
        resolve({ code, stdout, stderr, error: reason })
      },
    )
    if (child.pid !== undefined) options.onSpawn?.(child.pid)
  })

/** The last non-empty line of a process's error output, shortened, for a one-line message. */
export function lastLine(text: string, max = 200): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  return line.length > max ? `${line.slice(0, max)}...` : line
}
