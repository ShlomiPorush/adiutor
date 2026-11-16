// The sync's owner-only folder for secrets (the Adiutor connection and the T3 session): mode 0700 and 0600 files
// elsewhere; on Windows `icacls` limits it to the user, SYSTEM and Administrators, makes the user its owner, and reads
// the access lists back, refusing any other entry. It is checked again before a file in it is read, never loosened,
// and every file is written in one step through a private temporary file.

import { randomBytes } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"
import { ClientError } from "./errors.ts"
import type { Runner } from "./exec.ts"

export type FolderDeps = {
  runner: Runner
  /** The full path of a Windows component in System32 (icacls, whoami), or undefined. */
  systemCommand: (name: string) => Promise<string | undefined>
  platform: NodeJS.Platform
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export function ownerOnlyFolder(dir: string, deps: FolderDeps) {
  const win = deps.platform === "win32"
  const hex = (n: number) => randomBytes(n).toString("hex")
  let secured = false
  let checked = false

  async function icacls(args: string[]): Promise<void> {
    const exe = await deps.systemCommand("icacls")
    if (!exe) throw new ClientError("insecure_credentials", "icacls was not found in %SystemRoot%\\System32.")
    for (let i = 0; ; i++) {
      const result = await deps.runner(exe, args, { timeoutMs: 30_000 })
      if (result.code === 0) return
      if (i >= 4) throw new ClientError("insecure_credentials", `Could not limit ${dir} to your user (icacls failed).`)
      await deps.sleep(100 + Math.random() * 200)
    }
  }

  async function userSid(): Promise<string> {
    const whoami = await deps.systemCommand("whoami")
    if (!whoami) throw new ClientError("insecure_credentials", "whoami was not found in %SystemRoot%\\System32.")
    const result = await deps.runner(whoami, ["/user", "/fo", "csv", "/nh"], { timeoutMs: 30_000 })
    const sid = /"(S-1-[0-9-]+)"\s*$/.exec(result.stdout.trim())?.[1]
    if (result.code !== 0 || !sid) throw new ClientError("insecure_credentials", "Could not tell the current user.")
    return sid
  }

  /** Reads the folder's and its files' ACLs back and allows no one but this user, SYSTEM and Administrators. */
  async function assertOnlyUser(sid: string): Promise<void> {
    const saved = join(dir, `.acl-${hex(4)}`)
    try {
      await icacls([dir, "/save", saved, "/T", "/Q"])
      const other = othersAllowed(readFileSync(saved).toString("utf16le"), sid)
      if (other)
        throw new ClientError("insecure_credentials", `Others can open ${dir} (${other}). Remove their access.`)
    } finally {
      rmSync(saved, { force: true })
    }
  }

  function assertOwnMode(path: string, mode: number, uid: number): void {
    if (uid !== process.getuid?.())
      throw new ClientError("insecure_credentials", `${path} belongs to another user. Use a folder of your own.`)
    if (mode & 0o077) throw new ClientError("insecure_credentials", `Others can open ${path}. Run: chmod 700 '${path}'`)
  }

  /** Creates the folder if needed and limits it to this user; refuses one that is open to others. */
  async function secure(): Promise<void> {
    if (secured) return
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch {
      throw new ClientError("cannot_save", `Cannot create ${dir}. Allow the sync to write there.`)
    }
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new ClientError("insecure_credentials", `${dir} must be a plain folder, not a link.`)
    if (win) {
      const sid = await userSid()
      await icacls([
        dir,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F",
        "/Q",
      ])
      // The owner may always change an ACL, so the folder and its files must be this user's.
      await icacls([dir, "/setowner", `*${sid}`, "/T", "/Q"])
      await assertOnlyUser(sid)
    } else assertOwnMode(dir, st.mode, st.uid)
    secured = true
  }

  /** Before a file in it is read: the folder must still be one only this user can open. Checks only. */
  async function check(): Promise<void> {
    if (secured || checked) return
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new ClientError("insecure_credentials", `${dir} must be a plain folder, not a link.`)
    if (win) await assertOnlyUser(await userSid())
    else assertOwnMode(dir, st.mode, st.uid)
    checked = true
  }

  /** A file of the folder, or null when it does not exist. The file and the folder are checked first. */
  async function read(name: string): Promise<string | null> {
    const file = join(dir, name)
    try {
      const st = lstatSync(file)
      if (st.isSymbolicLink() || !st.isFile())
        throw new ClientError("insecure_credentials", `${file} must be a plain file.`)
      if (!win && (st.uid !== process.getuid?.() || st.mode & 0o077))
        throw new ClientError("insecure_credentials", `Others can read ${file}. Run: chmod 600 '${file}'`)
      await check()
      return readFileSync(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  }

  /** Writes a file of the folder in one step: a private temporary file, flushed, then renamed over it. */
  async function write(name: string, text: string): Promise<void> {
    await secure()
    const file = join(dir, name)
    const tmp = `${file}.${hex(6)}.tmp`
    let fd: number | undefined
    try {
      fd = openSync(tmp, "wx", 0o600)
      writeSync(fd, text)
      fsyncSync(fd)
    } catch {
      throw new ClientError("cannot_save", `Cannot write in ${dir}. Allow the sync to write there.`)
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    // On Windows an open handle (an antivirus scan) can refuse the rename for a moment.
    const until = deps.now() + 5_000
    for (;;) {
      try {
        renameSync(tmp, file)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? ""
        if (!win || !["EPERM", "EBUSY", "EACCES"].includes(code) || deps.now() > until) {
          rmSync(tmp, { force: true })
          throw new ClientError("cannot_save", `Cannot replace ${file}.`)
        }
        await deps.sleep(100)
      }
    }
  }

  const remove = (name: string) => rmSync(join(dir, name), { force: true })

  return { dir, secure, check, read, write, remove }
}

export type OwnerOnlyFolder = ReturnType<typeof ownerOnlyFolder>

/**
 * What in saved ACLs (icacls /save: one SDDL line per object) lets anyone but this user, SYSTEM and Administrators
 * in. Anything but plain allow and deny entries counts too: refused, not guessed.
 */
export function othersAllowed(saved: string, userSid: string): string | null {
  const allowed = new Set([userSid, "SY", "BA", "S-1-5-18", "S-1-5-32-544"])
  // SDDL writes the built-in Administrator account (RID 500) as LA.
  if (/^S-1-5-21-[0-9-]+-500$/.test(userSid)) allowed.add("LA")
  for (const line of saved.split(/\r?\n/)) {
    const at = line.indexOf("D:")
    if (at < 0) continue
    const dacl = line.slice(at + 2).split(/S:/)[0] ?? ""
    let depth = 0
    let ace = ""
    for (const ch of dacl) {
      if (ch === "(") {
        depth++
        if (depth > 1) return "a conditional entry"
        ace = ""
      } else if (ch === ")") {
        depth--
        const parts = ace.split(";")
        const type = parts[0] ?? ""
        const sid = parts[5] ?? ""
        if (!["A", "D", "OA", "OD"].includes(type)) return `an entry of type ${type}`
        if ((type === "A" || type === "OA") && !allowed.has(sid)) return sid
      } else if (depth === 1) ace += ch
    }
  }
  return null
}
