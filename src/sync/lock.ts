// A lock file shared by the sync's commands (the agent-access client contract, "The lock"): created exclusively,
// naming its holder (process id, host, a random token, the start time). It is never taken from a live holder, however
// old; a holder that died (same host, process gone), or an empty lock older than a minute, is taken over by moving the
// lock aside atomically, so of two takers only one wins. Used for the Adiutor connection's refresh, the T3 session and
// the run lock. The folder it lives in is the caller's to prepare.

import { randomBytes } from "node:crypto"
import { closeSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs"
import { hostname } from "node:os"
import { ClientError } from "./errors.ts"

export type LockDeps = {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** Milliseconds since the epoch. */
  now: () => number
  sleep: (ms: number) => Promise<void>
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
        if (win && (code === "EPERM" || code === "EACCES") && deps.now() < deadline) {
          await deps.sleep(50 + Math.random() * 100)
          continue
        }
        if (code !== "EEXIST") throw options.cannotCreate()
      }
      const held = readHolder(lockFile)
      if (options.own && held && !held.empty && held.token === options.own) return options.own
      const dead = held?.empty
        ? deps.now() - (held.mtime ?? 0) > 60_000
        : held &&
          String(held.host).toLowerCase() === host().toLowerCase() &&
          !processAlive(Number(held.pid), deps.platform)
      if (dead && held && breakLock(held)) continue
      if (deps.now() >= deadline) throw options.busy(held)
      await deps.sleep(100 + Math.random() * 200)
    }
  }

  /** Moves a dead holder's lock away atomically; puts it back when what was moved is not the dead lock. */
  function breakLock(held: Holder): boolean {
    const moved = `${lockFile}.${randomBytes(6).toString("hex")}.dead`
    try {
      renameSync(lockFile, moved)
    } catch {
      return true
    }
    const got = readHolder(moved)
    if (got && (held.empty ? got.empty : got.token === held.token)) {
      rmSync(moved, { force: true })
      return true
    }
    try {
      // A link, not a rename: a newer lock already in its place wins.
      linkSync(moved, lockFile)
    } catch {}
    rmSync(moved, { force: true })
    return false
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
