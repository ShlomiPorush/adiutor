import { readFileSync } from "node:fs"
import { hostname } from "node:os"

/**
 * Which process an identity change belongs to: the host (the container's name in Docker), the pid, and that process's
 * start time as Linux records it (`/proc/<pid>/stat`, field 22, clock ticks since boot), so a pid used again by another
 * process is not taken for it. Null start time where it could not be read.
 */
export type ProcessIdentity = { host: string; pid: number; startedAt: string | null }

/**
 * What reading a process's start time gave: its start time; `missing` when `/proc/<pid>` does not exist (ENOENT); or
 * `unknown` for any other read or parse failure, which never counts as gone.
 */
export type StartRead = { kind: "start"; value: string } | { kind: "missing" } | { kind: "unknown" }

/** The one read of `/proc`; tests replace it to inject a read failure. */
export const procfs = {
  readStat: (pid: number): string => readFileSync(`/proc/${pid}/stat`, "utf8"),
}

export function readProcessStart(pid: number): StartRead {
  let stat: string
  try {
    stat = procfs.readStat(pid)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "unknown" }
  }
  // The command name (field 2) is in parentheses and may hold spaces: count the fields after its closing one.
  const close = stat.lastIndexOf(")")
  const value = close < 0 ? undefined : stat.slice(close + 2).split(" ")[19]
  return value && /^\d+$/.test(value) ? { kind: "start", value } : { kind: "unknown" }
}

/** A process's start time, or null when it cannot be read. */
export function processStart(pid: number): string | null {
  const read = readProcessStart(pid)
  return read.kind === "start" ? read.value : null
}

export function currentProcess(): ProcessIdentity {
  return { host: hostname(), pid: process.pid, startedAt: processStart(process.pid) }
}

/** Whether this process can read `/proc` at all: without it, no other process is ever certainly gone. */
const procReadable = () => readProcessStart(process.pid).kind === "start"

/**
 * Whether the process that recorded an identity change is certainly gone: it ran on this host with a recorded start
 * time, and its pid no longer exists (ENOENT) or now belongs to a process that started at another time. Anything else
 * (another host, no start time recorded, a read or parse failure) is not certain, and its change stays under way.
 */
export function processGone(owner: ProcessIdentity): boolean {
  if (owner.host !== hostname() || !owner.startedAt || !procReadable()) return false
  const read = readProcessStart(owner.pid)
  return read.kind === "missing" || (read.kind === "start" && read.value !== owner.startedAt)
}
