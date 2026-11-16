// A lock file shared by the sync's commands (the agent-access client contract, "The lock"): created exclusively,
// naming its holder (process id, host, a random token, the start time). It is never taken from a live holder, however
// old. A holder that died (same host, process gone), or an empty lock older than a minute, is taken over: under a guard
// file of that dead holder's own, created exclusively, the taker reads the lock again and removes it only when it still
// names the dead holder. Of several takers only one holds the guard, and none can remove a lock another one created. Used for the Adiutor connection's refresh, the T3 session and
// the run lock. The folder it lives in is the caller's to prepare.

import { randomBytes } from "node:crypto"
import { closeSync, lstatSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import { hostname } from "node:os"
import { ClientError } from "./errors.ts"

export type LockDeps = {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** Milliseconds since the epoch. */
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Test seam: runs after a taker found the holder dead, before it takes the lock over. */
  beforeBreak?: (held: Holder) => Promise<void>
}

/** What a lock file says about its holder; `empty` when it cannot be read (a holder that died while writing it). */
export type Holder = { token?: string; pid?: number; host?: string; startedAt?: number; empty?: true; mtime?: number }

/** Whether a process of this computer is alive; on Windows a process of another user answers EPERM: alive. */
// Lock holders are this user's processes; elsewhere EPERM means another user's process reusing the id.
export function processAlive(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function readHolder(path: string): Holder | null {
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as Holder
    return typeof held?.token === "string" ? held : { empty: true, mtime: lstatSync(path).mtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    try {
      return { empty: true, mtime: lstatSync(path).mtimeMs }
    } catch {
      return null
    }
  }
}

export type AcquireOptions = {
  /** A token this command already holds: taking the lock again returns it. */
  own?: string
  /** How long to wait for a live holder before giving up. */
  waitMs: number
  /** The failure when a live holder keeps it past waitMs. */
  busy: (held: Holder | null) => Error
  /** The failure when the lock cannot be created at all. */
  cannotCreate: () => Error
}

export function fileLock(lockFile: string, deps: LockDeps) {
  const win = deps.platform === "win32"
  const nowS = () => Math.floor(deps.now() / 1000)
  const host = () => (win ? deps.env.COMPUTERNAME || hostname() : hostname())

  async function acquire(options: AcquireOptions): Promise<string> {
    const token = randomBytes(16).toString("hex")
    const line = JSON.stringify({ pid: process.pid, host: host(), token, startedAt: nowS() })
    const deadline = deps.now() + options.waitMs
    // A name still being deleted is waited for even by a lock that does not wait for a live holder.
    const transient = deps.now() + Math.max(options.waitMs, 2_000)
    for (;;) {
      let fd: number | undefined
      try {
        fd = openSync(lockFile, "wx", 0o600)
        writeSync(fd, line)
        closeSync(fd)
        return token
      } catch (error) {
        if (fd !== undefined) closeSync(fd)
        const code = (error as NodeJS.ErrnoException).code
        // Windows refuses for a moment to create a file whose name is still being deleted.
        if (win && (code === "EPERM" || code === "EACCES") && deps.now() < transient) {
          await deps.sleep(50 + Math.random() * 100)
          continue
        }
        if (code !== "EEXIST") throw options.cannotCreate()
      }
      const held = readHolder(lockFile)
      if (options.own && held && !held.empty && held.token === options.own) return options.own
      if (held && dead(held)) {
        await deps.beforeBreak?.(held)
        if (breakDead(lockFile, held)) continue
      }
      if (deps.now() >= deadline) throw options.busy(readHolder(lockFile) ?? held)
      await deps.sleep(100 + Math.random() * 200)
    }
  }

  const dead = (held: Holder) =>
    held.empty
      ? deps.now() - (held.mtime ?? 0) > 60_000
      : String(held.host).toLowerCase() === host().toLowerCase() && !processAlive(Number(held.pid), deps.platform)

  /** The same holder: the same token, or for an empty lock the same modification time. */
  const same = (a: Holder | null, b: Holder) =>
    a !== null && (b.empty ? a.empty === true && a.mtime === b.mtime : !a.empty && a.token === b.token)

  /**
   * Removes a lock file whose holder was found dead, under a guard file named after that holder, created exclusively:
   * of several takers only one holds it, and while it does, the dead holder's lock cannot change (nobody else may
   * remove it, and nobody can create one in its place), so the lock is read again and removed only when it still names
   * that holder. A guard whose own holder died is removed the same way, one level up. Returns whether to try creating
   * the lock again; false while another taker is at it.
   */
  function breakDead(file: string, held: Holder, depth = 0): boolean {
    if (depth > 3) return false
    const id = held.empty ? `empty-${Math.floor(held.mtime ?? 0)}` : String(held.token).replace(/[^A-Za-z0-9]/g, "")
    const guard = `${file}.${id}.takeover`
    const token = randomBytes(16).toString("hex")
    let fd: number | undefined
    try {
      fd = openSync(guard, "wx", 0o600)
      writeSync(fd, JSON.stringify({ pid: process.pid, host: host(), token, startedAt: nowS() }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false
      const other = readHolder(guard)
      return other !== null && dead(other) && breakDead(guard, other, depth + 1) && breakDead(file, held, depth)
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    try {
      if (same(readHolder(file), held)) rmSync(file, { force: true })
      return true
    } finally {
      // Only a taker that found this one dead removes its guard otherwise, and this one is alive.
      if (readHolder(guard)?.token === token) rmSync(guard, { force: true })
    }
  }

  const mine = (token: string) => readHolder(lockFile)?.token === token
  const release = (token: string) => {
    if (mine(token)) rmSync(lockFile, { force: true })
  }

  async function withLock<T>(options: AcquireOptions, fn: (token: string) => Promise<T>): Promise<T> {
    const token = await acquire(options)
    try {
      return await fn(token)
    } finally {
      release(token)
    }
  }

  return { file: lockFile, acquire, release, mine, withLock, holder: () => readHolder(lockFile) }
}

export type FileLock = ReturnType<typeof fileLock>

/** The lock's standard failures for a lock that guards one connection's secrets. */
export function connectionLockOptions(lockFile: string, dir: string, deps: Pick<LockDeps, "now">, what: string) {
  return {
    waitMs: 20_000,
    cannotCreate: () => new ClientError("cannot_save", `Cannot create a lock in ${dir}.`),
    busy: (held: Holder | null) => {
      const old = held && !held.empty && Math.floor(deps.now() / 1000) - Number(held.startedAt) > 600
      return new ClientError(
        "busy",
        old
          ? `Another sync command has held ${lockFile} for over 10 minutes. If none is running, delete that file.`
          : what,
      )
    },
  }
}
