// The sync's state in its data folder, none of it secret: the run lock (one run at a time across the tray and the
// command line), the status file `status.json` (the last run and the last good sync, for `status` and the tray), and
// the last good T3 project list. Files are written in one step through a temporary file and a rename.

import { randomBytes } from "node:crypto"
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import type { RunReport } from "./contract.ts"
import { ClientError } from "./errors.ts"
import { asArray, asObject, asString, asTime, parseJson } from "./json.ts"
import { fileLock, type Holder, type LockDeps, processAlive, readHolder } from "./lock.ts"
import { PROJECT_ID, projectFrom, type T3Project } from "./t3.ts"

export const RUN_LOCK = "run.lock"
export const STATUS_FILE = "status.json"
export const LAST_PROJECTS = "t3-projects.json"

/** Writes a file in one step: a temporary file of its own, flushed, then renamed over it. */
export async function writeAtomic(
  path: string,
  text: string,
  deps: Pick<LockDeps, "platform" | "now" | "sleep">,
): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, "wx", 0o600)
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  const until = deps.now() + 5_000
  for (;;) {
    try {
      renameSync(tmp, path)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ""
      // On Windows an open handle (an antivirus scan, a reader) can refuse the rename for a moment.
      if (deps.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(code) || deps.now() > until) {
        rmSync(tmp, { force: true })
        throw error
      }
      await deps.sleep(100)
    }
  }
}

export type RunLockHeld = { busy: false; release: () => void } | { busy: true; startedAt: string | null }

/**
 * The run lock, held for the whole run, the collector included. A second run does not wait: it answers busy with the
 * holder's start time. A dead holder's lock is taken over (src/sync/lock.ts).
 */
export async function takeRunLock(dir: string, deps: LockDeps): Promise<RunLockHeld> {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const lock = fileLock(join(dir, RUN_LOCK), deps)
  try {
    const token = await lock.acquire({
      // A live holder is not waited for: the second run answers busy at once.
      waitMs: 0,
      busy: (held) => new BusyError(held),
      cannotCreate: () => new ClientError("cannot_save", `Cannot create the run lock in ${dir}.`),
    })
    return { busy: false, release: () => lock.release(token) }
  } catch (error) {
    if (error instanceof BusyError) return { busy: true, startedAt: startedAt(error.held) }
    throw error
  }
}

class BusyError extends Error {
  constructor(readonly held: Holder | null) {
    super("busy")
  }
}

const startedAt = (held: Holder | null) =>
  held && !held.empty && Number.isFinite(Number(held.startedAt))
    ? new Date(Number(held.startedAt) * 1000).toISOString()
    : null

/** The running run's start time, from the run lock; null when no live run holds it. */
export function runningSince(dir: string, deps: Pick<LockDeps, "platform" | "env">): { startedAt: string } | null {
  const held = readHolder(join(dir, RUN_LOCK))
  if (!held) return null
  if (held.empty) return { startedAt: new Date(held.mtime ?? 0).toISOString() }
  const here = deps.platform === "win32" ? deps.env.COMPUTERNAME || hostname() : hostname()
  // A run of this computer that died left its lock: the next run takes it over.
  if (String(held.host).toLowerCase() === here.toLowerCase() && !processAlive(Number(held.pid), deps.platform))
    return null
  return { startedAt: startedAt(held) ?? new Date(0).toISOString() }
}

// --- status.json ---

export type StatusFile = { v: 1; lastRun: RunReport | null; lastGoodSyncAt: string | null }

export function readStatus(dir: string): StatusFile {
  try {
    const root = asObject(parseJson(readFileSync(join(dir, STATUS_FILE), "utf8"), "the status file"))
    // Written by this engine. An older one also kept a security part, which no longer counts: it is dropped.
    const { security: _security, ...lastRun } = asObject(root?.lastRun) ?? {}
    const run = Object.keys(lastRun).length > 0 ? (lastRun as unknown as RunReport) : null
    // The last good sync is the last run with T3 accepted. An older engine counted only runs where security was
    // accepted too: its last run counts when T3 was accepted in it.
    const t3Good = run?.t3?.result === "accepted" ? asTime(run.finishedAt) : null
    const lastGoodSyncAt = t3Good ?? asTime(root?.lastGoodSyncAt)
    // The report says the same as the status: an older engine's report kept its own, both-parts time.
    if (run) run.lastGoodSyncAt = lastGoodSyncAt
    return { v: 1, lastRun: run, lastGoodSyncAt }
  } catch {
    return { v: 1, lastRun: null, lastGoodSyncAt: null }
  }
}

/** Under the run lock: the run's report, and the last good sync. */
export async function writeStatus(dir: string, status: StatusFile, deps: Pick<LockDeps, "platform" | "now" | "sleep">) {
  await writeAtomic(join(dir, STATUS_FILE), `${JSON.stringify(status, null, 2)}\n`, deps)
}

// --- The last good T3 project list ---

export type ProjectList = { savedAt: string; environmentId: string; projects: T3Project[] }

export async function saveProjectList(
  dir: string,
  list: ProjectList,
  deps: Pick<LockDeps, "platform" | "now" | "sleep">,
) {
  await writeAtomic(join(dir, LAST_PROJECTS), `${JSON.stringify(list)}\n`, deps)
}

/** The last good list, or undefined when there is none or it cannot be read. */
export function readProjectList(dir: string): ProjectList | undefined {
  try {
    const root = asObject(parseJson(readFileSync(join(dir, LAST_PROJECTS), "utf8"), "the last project list"))
    const savedAt = asTime(root?.savedAt)
    const environmentId = asString(root?.environmentId)
    if (!root || !savedAt || !environmentId) return undefined
    const projects: T3Project[] = []
    for (const item of asArray(root.projects)) {
      const data = asObject(item)
      const id = asString(data?.id)
      if (!data || !id || !PROJECT_ID.test(id)) continue
      projects.push(projectFrom(data, id))
    }
    return { savedAt, environmentId, projects }
  } catch {
    return undefined
  }
}
