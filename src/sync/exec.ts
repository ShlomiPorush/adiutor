import { type ExecFileException, execFile } from "node:child_process"

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

/** The environment for a child process: the agent token never leaves this process. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env }
  delete copy.MIKUD_AGENT_TOKEN
  return copy
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
  options: { cwd?: string; timeoutMs: number },
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
    execFile(
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
        env: childEnv(),
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
