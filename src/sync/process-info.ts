// Whether a process the sync started is certainly gone: its id alone is not enough, since an id is reused, so the
// process's creation time is read too and compared. Used by the T3 session's pending records (plan, "T3 session
// lifecycle"): a pending issue is looked up only once its child is certainly gone.

import { readFileSync } from "node:fs"
import type { Runner } from "./exec.ts"
import { processAlive } from "./lock.ts"

export type ProcessInfoDeps = {
  platform: NodeJS.Platform
  runner: Runner
  /** The full path of a Windows component under %SystemRoot%\System32, or undefined. */
  systemCommand: (name: string) => Promise<string | undefined>
}

/**
 * The creation time of a process of this computer, as an opaque text to compare: null when no process has this id,
 * undefined when it cannot be told (then the process counts as alive).
 */
export async function processCreation(pid: number, deps: ProcessInfoDeps): Promise<string | null | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (!processAlive(pid, deps.platform)) return null
  if (deps.platform === "linux") {
    try {
      // Field 22 of /proc/<pid>/stat, after the command name in parentheses: the start time in clock ticks after boot.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      const start = fields[19]
      return start && /^[0-9]+$/.test(start) ? `linux:${start}` : undefined
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined
    }
  }
  if (deps.platform === "win32") {
    // Windows PowerShell 5.1 is part of Windows, under System32, where only administrators can write. The id is a
    // number, so the command holds nothing from outside.
    const powershell = await deps.systemCommand("WindowsPowerShell\\v1.0\\powershell")
    if (!powershell) return undefined
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks } else { 'none' }`
    const result = await deps.runner(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeoutMs: 30_000,
    })
    const text = result.stdout.trim()
    if (result.code !== 0) return undefined
    if (text === "none") return null
    return /^[0-9]+$/.test(text) ? `win32:${text}` : undefined
  }
  return undefined
}
