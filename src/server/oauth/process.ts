import { readFileSync } from "node:fs"
import { hostname } from "node:os"

/**
 * Which process an identity change belongs to: the host (the container's name in Docker), the pid, and that process's
 * start time as Linux records it (`/proc/<pid>/stat`, field 22, clock ticks since boot), so a pid used again by another
 * process is not taken for it. Null start time where `/proc` cannot be read.
 */
export type ProcessIdentity = { host: string; pid: number; startedAt: string | null }

/** A process's start time, or null when it does not exist or `/proc` cannot be read. */
export function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    // The command name (field 2) is in parentheses and may hold spaces: count the fields after its closing one.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null
  } catch {
    return null
  }
}

export function currentProcess(): ProcessIdentity {
  return { host: hostname(), pid: process.pid, startedAt: processStart(process.pid) }
}

/**
 * Whether the process that recorded an identity change is certainly gone: it ran on this host, `/proc` can be read
 * here, and its pid no longer exists or now belongs to a process that started at another time. Anything else (another
 * host, no `/proc`, no start time recorded) is not certain, and its change stays under way.
 */
export function processGone(owner: ProcessIdentity): boolean {
  if (owner.host !== hostname() || !owner.startedAt || processStart(process.pid) === null) return false
  return processStart(owner.pid) !== owner.startedAt
}
