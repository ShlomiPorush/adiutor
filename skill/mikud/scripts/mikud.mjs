#!/usr/bin/env node
/*
 * mikud for agents: connect to Mikud with a code the owner approves in the browser (Better Auth's device
 * authorization), then keep the owner's board current through Mikud's /api/v1 routes.
 *
 * One of three versions with one contract: mikud.mjs (Node 20+), mikud.ps1 (Windows PowerShell 5.1 and PowerShell 7)
 * and mikud.sh (POSIX sh and curl). Same commands, same one-line JSON answers and error codes, the same files and the
 * same lock, so they can run side by side on one computer. No secret ever appears in the output.
 *
 * The approved code gives a session token, which is a full owner session. It lives in memory only: the command turns
 * it into one agent key (api-key/create) and ends that session (revoke-session) at once, whatever happens in between.
 * Mikud has no refresh token: the key is the connection until it ends or the owner disconnects it. What a lost answer
 * or a stopped run may have left on Mikud (a session, a key) is written to the `left` record before the information
 * is lost, and reported with its Mikud address until it ends or the owner says he cleaned up.
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const CLIENT_ID = "mikud-connect"
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const DAYS_DEFAULT = 90
const DAYS_MIN = 1
const DAYS_MAX = 365
const whole = (value, fallback) => (/^[1-9][0-9]*$/.test(String(value ?? "")) ? Number(value) : fallback)
const WAIT_SECONDS = whole(process.env.MIKUD_WAIT_SECONDS, 90)
// Test seams: the tests shorten the lock wait and the request timeout, and move the clock forward.
const LOCK_WAIT_MS = whole(process.env.MIKUD_TEST_LOCK_WAIT_MS, 20_000)
const TIMEOUT_MS = whole(process.env.MIKUD_TEST_TIMEOUT_MS, 15_000)
const CLOCK_OFFSET = whole(process.env.MIKUD_TEST_CLOCK_OFFSET, 0)
// Device codes and keys as Mikud sends them; anything else is refused before it is stored.
const SECRET = /^[A-Za-z0-9._~+/=-]{8,512}$/
// Every value in a file: no quote, backslash or control character, so the shell version reads it too.
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const PLAIN = /^[^"\\\u0000-\u001f\u007f]*$/
const LABEL = /^[A-Za-z0-9 ._:-]{1,60}$/
// The path part: lower-case letters, digits, slash and hyphen only, matched as typed, never decoded.
const PATH_PART = /^[a-z0-9/-]+$/
// RFC 3986's query characters, without the apostrophe (fetch would encode it) and with every % followed by two hex
// digits. Passed on as typed.
const QUERY = /^(?:[A-Za-z0-9\-._~!$&()*+,;=:@/?]|%[0-9A-Fa-f]{2})*$/
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
// The only calls the command makes on /api/v1: one per MCP tool.
const ROUTES = [
  ["POST", "threads/start"],
  ["GET", "items"],
  ["GET", "items/{id}"],
  ["POST", "items"],
  ["PATCH", "items/{id}"],
  ["POST", "items/{id}/comments"],
  ["POST", "capture"],
  ["POST", "items/{id}/threads"],
  ["GET", "projects"],
  ["PATCH", "projects/{id}"],
  ["POST", "projects/{id}/stage-proposals"],
  ["GET", "notes"],
  ["GET", "notes/{id}"],
  ["POST", "notes"],
  ["PATCH", "notes/{id}"],
].map(([method, template]) => [method, new RegExp(`^${template.replace("{id}", UUID)}$`)])

const CONNECTION_FIELDS = [
  ["v", "n"],
  ["origin", "s"],
  ["key", "s"],
  ["keyName", "s"],
  ["expiresAt", "s"],
]
const PENDING_FIELDS = [
  ["v", "n"],
  ["attemptId", "s"],
  ["origin", "s"],
  ["deviceCode", "s"],
  ["userCode", "s"],
  ["link", "s"],
  ["interval", "n"],
  ["nextPollAt", "n"],
  ["codeExpiresAt", "n"],
  ["days", "n"],
  ["keyName", "s"],
  ["phase", "s"],
  ["pollInFlight", "n"],
  ["uncertain", "n"],
  ["sessionOpen", "n"],
  ["keySaved", "n"],
]
const LEFT_FIELDS = [
  ["origin", "s"],
  ["keyName", "s"],
  ["expiresAt", "s"],
  ["reason", "s"],
  ["at", "s"],
]
// Reasons whose key end date came from Mikud: the entry drops by itself once that date has passed.
const DATED = new Set(["replaced", "disconnected", "not_saved"])
const REASONS = new Set([...DATED, "key_unknown", "session_unknown"])

const win = process.platform === "win32"

class Fail extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    this.extra = extra
  }
}

/** The attempt changed under this run (another command, after a wrongly broken lock): answer from the new state. */
class Changed extends Error {}

const now = () => Math.floor(Date.now() / 1000) + CLOCK_OFFSET
const iso = (seconds) => new Date(seconds * 1000).toISOString()
const hex = (n) => randomBytes(n).toString("hex")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const str = (value) => (typeof value === "string" ? value : "")
const host = () => (win ? process.env.COMPUTERNAME || os.hostname() : os.hostname())
const sameHost = (name) => String(name).toLowerCase() === host().toLowerCase()
const rm = (target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch {}
}
// Windows tools by their full path: in Git Bash, for one, whoami is a different program.
const system32 = (exe) => path.join(process.env.SystemRoot || "C:\\Windows", "System32", exe)
const groupedCode = (code) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code)
const waitCommand = (origin) => `mikud connect --wait --url ${origin}`
const SESSION_TEXT =
  "Mikud may have opened a 'mikud connect (agent approval)' session that was not ended: end it on the Account page."

const HELP = `mikud: keep the owner's Mikud board current, after the owner approves this computer user once.

  connect [--url <address>] [--days <1-365>] [--replace]
                          Ask to connect; prints a link and a code to show the owner.
  connect --wait --url <address>
                          Wait up to ${WAIT_SECONDS} s for the approval; run again while it answers still_waiting.
  status [--clear-left]   Whether this computer user is connected, and what the command left on Mikud (no secrets).
  disconnect              Forget the connection on this computer (the key stays on Mikud until it ends).
  get '<path>'            GET /api/v1/<path>, for example: get 'items?q=login'
  post '<path>' --json '<body>' | --json-file <file>
  patch '<path>' --json '<body>' | --json-file <file>
                          --as <label> (or MIKUD_AGENT_LABEL) names the agent in Mikud's activity log.`

/* Arguments */

function parseArgs(args) {
  const opts = { positional: [] }
  const value = (name) => {
    if (!args.length) throw new Fail("bad_option", `${name} needs a value.`)
    return args.shift()
  }
  while (args.length) {
    const a = args.shift()
    if (a === "--url") opts.url = value(a)
    else if (a === "--days") opts.days = value(a)
    else if (a === "--json") opts.json = value(a)
    else if (a === "--json-file") opts.jsonFile = value(a)
    else if (a === "--as") opts.as = value(a)
    else if (a === "--replace") opts.replace = true
    else if (a === "--wait") opts.wait = true
    else if (a === "--clear-left") opts.clearLeft = true
    else if (a.startsWith("--")) throw new Fail("bad_option", `Unknown option ${a}. Run: mikud help`)
    else opts.positional.push(a)
  }
  return opts
}

function daysOf(raw) {
  if (raw === undefined) return DAYS_DEFAULT
  const days = /^[0-9]{1,3}$/.test(raw) ? Number(raw) : 0
  if (days < DAYS_MIN || days > DAYS_MAX) throw new Fail("bad_option", `--days takes ${DAYS_MIN} to ${DAYS_MAX}.`)
  return days
}

/** The canonical origin of an address: https, or http on this computer only; no path, query or credentials. */
function originOf(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new Fail(
      "no_url",
      "That is not an address. Ask the owner for Mikud's address, for example https://mikud.example.com.",
    )
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Fail("no_url", "Mikud's address must start with https:// (http only for localhost or 127.0.0.1).")
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw new Fail("no_url", "Give Mikud's address alone, for example https://mikud.example.com.")
  return url.origin
}

/* Where the connection is kept: one folder per computer user, shared by every agent install of that user. */

function context() {
  const base = win ? process.env.USERPROFILE || os.homedir() : os.homedir()
  const dir = path.resolve(process.env.MIKUD_SKILL_HOME || path.join(base, ".mikud"))
  return {
    dir,
    connection: path.join(dir, "connection"),
    pending: path.join(dir, "pending"),
    left: path.join(dir, "left"),
    lock: path.join(dir, "lock"),
  }
}

const insecure = (message) => new Fail("insecure_credentials", message)

let homeChecked = false

/** Checks the folder (and creates it when asked): a plain folder of this user that only this user can open. */
function secureHome(ctx, create) {
  let st
  try {
    st = fs.lstatSync(ctx.dir)
  } catch (e) {
    if (e.code !== "ENOENT") throw new Fail("cannot_save", `Cannot read ${ctx.dir}. Allow this agent to use it.`)
    if (!create) return false
    try {
      fs.mkdirSync(ctx.dir, { recursive: true, mode: 0o700 })
      if (win) restrictWindows(ctx.dir, true)
    } catch (e2) {
      if (e2 instanceof Fail) throw e2
      throw new Fail("cannot_save", `Cannot create ${ctx.dir}. Allow this agent to write there.`)
    }
    st = fs.lstatSync(ctx.dir)
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw insecure(`${ctx.dir} must be a plain folder, not a link.`)
  if (win) {
    if (!homeChecked) {
      const present = [ctx.connection, ctx.pending, ctx.left].filter((f) => fs.existsSync(f))
      for (const f of present) plainFile(f)
      checkWindowsAcl(ctx, [ctx.dir, ...present])
    }
  } else {
    if (st.uid !== process.getuid())
      throw insecure(`${ctx.dir} belongs to another user. Remove it, or set MIKUD_SKILL_HOME to a folder of your own.`)
    if ((st.mode & 0o777) !== 0o700) throw insecure(`Others can open ${ctx.dir}. Run: chmod 700 '${ctx.dir}'`)
  }
  homeChecked = true
  return true
}

function plainFile(file) {
  const st = fs.lstatSync(file)
  if (st.isSymbolicLink() || !st.isFile()) throw insecure(`${file} must be a plain file, not a link.`)
  return st
}

/** Checks one file before it is read; null when it does not exist. */
function checkFile(ctx, file) {
  let st
  try {
    st = plainFile(file)
  } catch (e) {
    if (e.code === "ENOENT") return null
    throw e
  }
  if (win) checkWindowsAcl(ctx, [file])
  else {
    if (st.uid !== process.getuid()) throw insecure(`${file} belongs to another user. Remove it and connect again.`)
    if ((st.mode & 0o777) !== 0o600) throw insecure(`Others can read ${file}. Run: chmod 600 '${file}'`)
  }
  return st
}

function readPrivate(ctx, file) {
  if (!secureHome(ctx, false)) return null
  if (!checkFile(ctx, file)) return null
  try {
    return fs.readFileSync(file, "utf8")
  } catch (e) {
    if (e.code === "ENOENT") return null
    throw new Fail("cannot_save", `Cannot read ${file}. Allow this agent to use ${ctx.dir}.`)
  }
}

/* Windows: access lists instead of mode bits. One entry, for the current user; inheritance removed. */

let userSid = ""
const aclChecked = new Set()

function currentSid() {
  if (userSid) return userSid
  try {
    const out = execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
    const sid = /"(S-1-[0-9-]+)"\s*$/.exec(out.trim())?.[1]
    if (sid) userSid = sid
  } catch {}
  if (!userSid) throw insecure("Could not tell the current Windows user (whoami failed).")
  return userSid
}

function powershell(script) {
  const exe = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
  return execFileSync(
    exe,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000, windowsHide: true },
  )
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`

/** icacls: inheritance removed and full control for the current user only. */
function restrictWindows(target, folder) {
  const sid = currentSid()
  try {
    execFileSync(
      system32("icacls.exe"),
      [target, "/inheritance:r", "/grant:r", `*${sid}:${folder ? "(OI)(CI)F" : "F"}`, "/Q"],
      { stdio: "ignore", windowsHide: true },
    )
  } catch {
    throw insecure(`Could not limit ${target} to your user (icacls failed).`)
  }
}

/**
 * What in an SDDL string lets anyone but this user in, or null. Owner: this user (the built-in Administrator shows as
 * LA). Access list: protected (no inheritance) and exactly one allow entry with full control for this user, with
 * (OI)(CI) on the folder and no flags on a file.
 */
function aclProblem(sddl, sid, folder, checkOwner) {
  const me = (who) => who === sid || (who === "LA" && /^S-1-5-21-[0-9-]+-500$/.test(sid))
  if (checkOwner) {
    const owner = /^O:(.*?)(?=G:|D:|S:|$)/.exec(sddl)?.[1] ?? ""
    if (!me(owner)) return `its owner is ${owner || "unknown"}`
  }
  const dacl = /D:([A-Z]*)((?:\([^()]*\))*)(?=S:|$)/.exec(sddl.slice(sddl.indexOf("D:")))
  if (!dacl || sddl.indexOf("D:") < 0) return "its access list cannot be read"
  if (!dacl[1].includes("P")) return "it inherits access from its parent folder"
  const aces = dacl[2].slice(1, -1).split(")(").filter(Boolean)
  if (aces.length !== 1) return `it has ${aces.length} access entries`
  const [type, flags, rights, , , who] = aces[0].split(";")
  if (type !== "A" || !me(who)) return `${who || "someone"} has access`
  if (!["FA", "0x1f01ff"].includes(rights)) return "your user lacks full control"
  if (flags !== (folder ? "OICI" : "")) return "its access entry has unexpected flags"
  return null
}

/** Reads back the owner and access list of folders and files (once per process), and refuses any other. */
function checkWindowsAcl(ctx, targets) {
  const todo = targets.filter((t) => !aclChecked.has(t.toLowerCase()))
  if (!todo.length) return
  let lines
  try {
    lines = powershell(
      [
        "$ErrorActionPreference = 'Stop'",
        "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        ...todo.map((t) => `(Get-Acl -LiteralPath ${psQuote(t)}).Sddl`),
      ].join("\n"),
    )
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    throw insecure(`Could not read who may open ${ctx.dir} (Get-Acl failed).`)
  }
  if (lines.length !== todo.length + 1) throw insecure(`Could not read who may open ${ctx.dir}.`)
  userSid = lines[0]
  todo.forEach((target, i) => {
    const folder = target === ctx.dir
    const problem = aclProblem(lines[i + 1], userSid, folder, true)
    if (problem)
      throw insecure(
        `Others may open ${target} (${problem}). Run: icacls "${target}" /inheritance:r /grant:r "%USERNAME%:${folder ? "(OI)(CI)F" : "F"}"`,
      )
    aclChecked.add(target.toLowerCase())
  })
}

/** A temporary file's access list, read back with icacls /save (one SDDL line per object). */
function readBackWindows(ctx, file) {
  const saved = path.join(ctx.dir, `.acl-${hex(4)}`)
  try {
    execFileSync(system32("icacls.exe"), [file, "/save", saved, "/Q"], { stdio: "ignore", windowsHide: true })
    const text = fs
      .readFileSync(saved)
      .toString("utf16le")
      .replace(/^\uFEFF/, "")
    const sddl = text.split(/\r?\n/)[1] ?? ""
    const problem = aclProblem(sddl, currentSid(), false, false)
    if (problem) throw insecure(`Could not make ${file} private (${problem}).`)
  } catch (e) {
    if (e instanceof Fail) throw e
    throw insecure(`Could not read back who may open ${file} (icacls failed).`)
  } finally {
    rm(saved)
  }
}

/* Files: one line of JSON each (`left`: one per entry), written in one step through a private temporary file. */

function serialize(fields, rec) {
  const parts = fields.map(([k, type]) => {
    if (type === "n") return `"${k}":${Math.max(0, Math.floor(Number(rec[k]) || 0))}`
    const value = String(rec[k] ?? "")
    if (!PLAIN.test(value)) throw new Fail("unexpected_answer", `Mikud sent a value that cannot be stored (${k}).`)
    return `"${k}":"${value}"`
  })
  return `{${parts.join(",")}}`
}

function parseLine(fields, line, file) {
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== "object") throw insecure(`${file} is damaged. Delete it and connect again.`)
  const rec = {}
  for (const [k, type] of fields) rec[k] = type === "n" ? Number(parsed[k]) || 0 : str(parsed[k])
  return rec
}

function hook(point) {
  const at = process.env[`MIKUD_TEST_HOLD_${point.toUpperCase().replace(/-/g, "_")}`]
  if (!at) return
  fs.writeFileSync(`${at}.reached`, String(process.pid))
  for (let i = 0; i < 1200 && !fs.existsSync(`${at}.go`); i++) pause(50)
}

function renameOver(from, to) {
  // On Windows an open handle (an antivirus scan) can refuse the rename for a moment.
  const until = Date.now() + 5_000
  for (;;) {
    try {
      fs.renameSync(from, to)
      return
    } catch (e) {
      if (!win || !["EPERM", "EBUSY", "EACCES"].includes(e.code) || Date.now() > until) {
        rm(from)
        throw new Fail("cannot_save", `Cannot replace ${to}. Allow this agent to write in its folder.`)
      }
      pause(100)
    }
  }
}

/** Writes a file in one step: a temporary file made private before anything is written, then renamed over. */
function writePrivate(ctx, file, text) {
  secureHome(ctx, true)
  const tmp = `${file}.${hex(6)}.tmp`
  let fd
  try {
    try {
      fd = fs.openSync(tmp, "wx", 0o600)
      if (win) {
        fs.closeSync(fd)
        fd = undefined
        restrictWindows(tmp, false)
        readBackWindows(ctx, tmp)
        fd = fs.openSync(tmp, "r+")
      } else {
        const st = fs.fstatSync(fd)
        if (st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600)
          throw insecure(`Could not make ${tmp} private before writing it.`)
      }
      hook("temp")
      fs.writeSync(fd, text)
      fs.fsyncSync(fd)
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  } catch (e) {
    rm(tmp)
    if (e instanceof Fail) throw e
    throw new Fail("cannot_save", `Cannot write in ${ctx.dir}. Allow this agent to write there.`)
  }
  renameOver(tmp, file)
  if (win) aclChecked.add(file.toLowerCase())
}

function removeFile(ctx, file) {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    throw new Fail("cannot_save", `Cannot remove ${file}. Allow this agent to write in ${ctx.dir}.`)
  }
}

function readConnection(ctx) {
  const text = readPrivate(ctx, ctx.connection)
  if (text === null) return null
  const rec = parseLine(CONNECTION_FIELDS, text.trim(), ctx.connection)
  if (!rec.origin || !rec.key || !rec.keyName)
    throw insecure(`${ctx.connection} is damaged. Delete it and connect again.`)
  return rec
}

function readPending(ctx) {
  const text = readPrivate(ctx, ctx.pending)
  if (text === null) return null
  const rec = parseLine(PENDING_FIELDS, text.trim(), ctx.pending)
  if (!rec.attemptId || !rec.origin || !rec.deviceCode || !["polling", "creating_key"].includes(rec.phase))
    throw insecure(`${ctx.pending} is damaged. Delete it and connect again.`)
  return rec
}

const writeConnection = (ctx, rec) => writePrivate(ctx, ctx.connection, `${serialize(CONNECTION_FIELDS, rec)}\n`)

/** Writes the attempt only while it is still the one this run started from. */
function writePendingIf(ctx, rec, attemptId) {
  const current = readPending(ctx)
  if (attemptId !== null && current?.attemptId !== attemptId) throw new Changed()
  writePrivate(ctx, ctx.pending, `${serialize(PENDING_FIELDS, rec)}\n`)
}

/* The left record: what the command left on Mikud, with non-secret fields only. */

function readLeft(ctx) {
  const text = readPrivate(ctx, ctx.left)
  if (text === null) return []
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => parseLine(LEFT_FIELDS, l, ctx.left))
    .filter((e) => REASONS.has(e.reason))
}

/** Entries still worth reporting: a dated entry drops by itself once its key has ended. */
const current = (entries) =>
  entries.filter((e) => !DATED.has(e.reason) || !e.expiresAt || Date.parse(e.expiresAt) > now() * 1000)

function writeLeft(ctx, entries) {
  if (!entries.length) return removeFile(ctx, ctx.left)
  writePrivate(ctx, ctx.left, entries.map((e) => `${serialize(LEFT_FIELDS, e)}\n`).join(""))
}

/** Adds entries (under the lock), before the change that would lose what they record. */
function addLeft(ctx, additions) {
  const entries = current(readLeft(ctx))
  for (const add of additions) {
    const entry = { at: iso(now()), expiresAt: "", ...add }
    const same = (e) => e.origin === entry.origin && e.keyName === entry.keyName
    if (entries.some((e) => same(e) && e.reason === entry.reason)) continue
    // A key whose name and end date are known says more than "a key may exist".
    if (entry.reason === "key_unknown" && entries.some((e) => same(e) && DATED.has(e.reason))) continue
    if (DATED.has(entry.reason)) {
      for (let i = entries.length - 1; i >= 0; i--)
        if (same(entries[i]) && entries[i].reason === "key_unknown") entries.splice(i, 1)
    }
    entries.push(entry)
  }
  writeLeft(ctx, entries)
}

function leftMessage(e) {
  if (e.reason === "session_unknown") return `On ${e.origin}: ${SESSION_TEXT}`
  if (e.reason === "key_unknown")
    return `On ${e.origin}: a key named "${e.keyName}" may exist; delete it in Settings, Agent access.`
  const why = { replaced: "was replaced", disconnected: "was disconnected", not_saved: "could not be saved" }[e.reason]
  return `On ${e.origin}: the key "${e.keyName}" ${why} but still works until ${e.expiresAt || "it ends"}; delete it in Settings, Agent access, if nothing uses it.`
}

const publicLeft = (entries) => current(entries).map((e) => ({ ...e, message: leftMessage(e) }))

function leftNow(ctx) {
  try {
    return publicLeft(readLeft(ctx))
  } catch {
    return []
  }
}

/* The lock: a folder created atomically (renamed into place with its owner file), released by its token only. */

/** The start time of a process as the system reports it, the same in every version; "" when it cannot be read. */
function startOf(pid) {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
      // Field 22; the fields after the command name, which may hold spaces, start with field 3.
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? ""
    }
    if (win)
      return powershell(
        `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ).trim()
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return ""
  }
}

function running(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === "EPERM"
  }
}

function readOwner(lock) {
  let st
  try {
    st = fs.lstatSync(lock)
  } catch (e) {
    return e.code === "ENOENT" ? null : { unreadable: true }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw insecure(`${lock} must be a plain folder, not a link.`)
  try {
    const held = JSON.parse(fs.readFileSync(path.join(lock, "owner"), "utf8"))
    if (typeof held?.token === "string" && held.token) return held
  } catch {
    if (!fs.existsSync(lock)) return null
  }
  return { unreadable: true }
}

/** free, alive, gone (certainly: same host, and the process ended or its id now runs another start), or unknown. */
function verdict(held) {
  if (!held) return "free"
  if (held.unreadable || !sameHost(held.host)) return "unknown"
  const pid = Number(held.pid)
  if (!Number.isInteger(pid) || pid <= 0) return "unknown"
  if (!running(pid)) return "gone"
  if (!held.start) return "unknown"
  const start = startOf(pid)
  if (!start) return "unknown"
  return start === String(held.start) ? "alive" : "gone"
}

async function acquire(ctx) {
  secureHome(ctx, true)
  const token = hex(16)
  const owner = `${JSON.stringify({ token, host: host(), pid: process.pid, start: startOf(process.pid) })}\n`
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    const fresh = `${ctx.lock}.${hex(6)}.new`
    try {
      fs.mkdirSync(fresh)
      fs.writeFileSync(path.join(fresh, "owner"), owner, { flag: "wx" })
    } catch {
      rm(fresh)
      throw new Fail("cannot_save", `Cannot create a lock in ${ctx.dir}. Allow this agent to write there.`)
    }
    try {
      fs.renameSync(fresh, ctx.lock)
      hook("locked")
      return token
    } catch (e) {
      rm(fresh)
      if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "EBUSY"].includes(e.code))
        throw new Fail("cannot_save", `Cannot create a lock in ${ctx.dir}. Allow this agent to write there.`)
    }
    const held = readOwner(ctx.lock)
    const state = verdict(held)
    if (state === "gone") {
      hook("break-observed")
      breakLock(ctx, held)
      continue
    }
    if (Date.now() > deadline) {
      if (state === "unknown")
        throw new Fail(
          "busy",
          `Another mikud command may hold the lock ${ctx.lock}, and this command cannot tell whether it still runs. Nothing was sent. If no mikud command runs on this computer, remove that folder by hand and run the command again.`,
        )
      throw new Fail("busy", "Another mikud command is using the connection. Nothing was sent; run it again.")
    }
    await sleep(state === "free" ? 50 : 100 + Math.random() * 200)
  }
}

/**
 * Removes the lock of a holder that is certainly gone. Moving it away is atomic, so of two that try only one moves
 * it; if what was moved is not that lock (another command had just taken a fresh one), it goes back.
 */
function breakLock(ctx, held) {
  const moved = `${ctx.lock}.${hex(6)}.dead`
  try {
    fs.renameSync(ctx.lock, moved)
  } catch {
    return
  }
  hook("break-moved")
  const got = readOwner(moved)
  if (got && !got.unreadable && got.token === held.token) return rm(moved)
  try {
    fs.renameSync(moved, ctx.lock)
  } catch {
    rm(moved)
  }
}

const mine = (ctx, token) => {
  const held = readOwner(ctx.lock)
  return Boolean(held && !held.unreadable && held.token === token)
}

function release(ctx, token) {
  if (!mine(ctx, token)) return
  const old = `${ctx.lock}.${hex(6)}.old`
  for (let i = 0; i < 20; i++) {
    try {
      fs.renameSync(ctx.lock, old)
      return rm(old)
    } catch {
      if (!win) return
      pause(50)
    }
  }
}

async function withLock(ctx, fn) {
  const token = await acquire(ctx)
  try {
    return await fn(token)
  } finally {
    release(ctx, token)
  }
}

/** Before a request that spends a one-time secret: the lock must still be this command's, or nothing is sent. */
function assertMine(ctx, token) {
  if (!mine(ctx, token)) throw new Fail("busy", "Another mikud command took over the connection. Run it again.")
}

/* Requests */

// Failures that happen before anything reaches the server.
const NOT_SENT = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
])

/** One request to the stored origin only, never following a redirect. `connect` names the request mikud-connect. */
async function request(origin, method, url, { json, bearer, connect, label } = {}) {
  if (new URL(url).origin !== origin) throw new Fail("bad_path", "Only Mikud's own address is called.")
  const headers = { accept: "application/json" }
  if (json !== undefined) headers["content-type"] = "application/json"
  if (bearer) headers.authorization = `Bearer ${bearer}`
  if (connect) headers["user-agent"] = CLIENT_ID
  if (label) headers["x-mikud-agent"] = label
  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: json === undefined ? undefined : typeof json === "string" ? json : JSON.stringify(json),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    const code = e?.cause?.code ?? e?.code
    throw new Fail("unreachable", `Cannot reach ${origin} (${code ?? e?.name ?? "network error"}).`, {
      sent: !NOT_SENT.has(code),
    })
  }
  if (res.status >= 300 && res.status < 400) {
    res.body?.cancel().catch(() => {})
    throw new Fail(
      "unreachable",
      `${origin} answered with a redirect (${res.status}), which the command does not follow. Check Mikud's address.`,
      { sent: true },
    )
  }
  let text
  try {
    text = await res.text()
  } catch {
    throw new Fail("unreachable", `The answer from ${origin} broke off.`, { sent: true })
  }
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {}
  return { status: res.status, text, json: parsed }
}

/** A refusal: Mikud's {error: {code, message}} (or Better Auth's code), carried in `body`. */
function httpFail(r, what) {
  const body = r.json !== null && typeof r.json === "object" ? r.json : null
  const inner = body?.error && typeof body.error === "object" ? body.error : null
  const detail =
    str(inner?.message) || str(inner?.code) || str(body?.message) || str(body?.error_description) || str(body?.error)
  return new Fail(`http_${r.status}`, `${what} failed (${r.status}${detail ? `: ${detail}` : ""}).`, {
    status: r.status,
    body,
  })
}

/* Connecting */

function keyName() {
  const raw = process.env.MIKUD_AGENT_NAME || host()
  const computer =
    raw
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .slice(0, 15)
      .replace(/^-+|-+$/g, "") || "agent"
  return `skill:${computer}:${hex(4)}`
}

function pendingAnswer(pend) {
  return {
    status: "pending",
    origin: pend.origin,
    link: pend.link,
    code: groupedCode(pend.userCode),
    expiresAt: iso(pend.codeExpiresAt),
    next: waitCommand(pend.origin),
  }
}

const connectedAnswer = (conn) => ({
  status: "connected",
  origin: conn.origin,
  keyName: conn.keyName,
  expiresAt: conn.expiresAt,
})

/** The key name was saved as the connection: the attempt finished creating its key. */
const keySaved = (pend, conn) => Boolean(pend.keySaved || conn?.keyName === pend.keyName)

/** What may be left on Mikud if this attempt were removed now; nothing for a completed connect. */
function attemptWarnings(pend, conn) {
  const warnings = []
  if (pend.phase === "creating_key") {
    // The token arrived, so an earlier poll whose answer was lost redeemed nothing: only this session counts.
    if (!keySaved(pend, conn)) warnings.push("key_unknown")
    if (pend.sessionOpen) warnings.push("session_unknown")
  } else if (pend.pollInFlight || pend.uncertain || pend.sessionOpen) warnings.push("session_unknown")
  return warnings
}

/** Removes an attempt, after writing what it may have left on Mikud. Under the lock. */
function removeAttempt(ctx, pend, conn) {
  const warnings = attemptWarnings(pend, conn)
  if (warnings.length)
    addLeft(
      ctx,
      warnings.map((reason) => ({ origin: pend.origin, keyName: pend.keyName, reason })),
    )
  if (readPending(ctx)?.attemptId === pend.attemptId) removeFile(ctx, ctx.pending)
  return warnings
}

function unknownFail(warnings, pend) {
  const session = warnings.includes("session_unknown") ? ` ${SESSION_TEXT}` : ""
  if (warnings.includes("key_unknown"))
    return new Fail(
      "key_unknown",
      `The connection to ${pend.origin} did not finish, and a key named "${pend.keyName}" may exist: delete it in Settings, Agent access.${session}`,
    )
  return new Fail(
    "session_unknown",
    `The connection to ${pend.origin} did not finish, and the command cannot tell what Mikud did. ${SESSION_TEXT}`,
  )
}

/**
 * An attempt a lock holder finds in creating_key belongs to a run that is gone (the lock is held through every step
 * of a redeem): it is removed with what it may have left.
 */
function settle(ctx, conn, pend) {
  if (!pend || pend.phase !== "creating_key") return { pend, warnings: [] }
  return { pend: null, orphan: pend, warnings: removeAttempt(ctx, pend, conn) }
}

async function connect(ctx, opts) {
  const days = daysOf(opts.days)
  secureHome(ctx, true)
  const result = await withLock(ctx, async () => {
    const conn = readConnection(ctx)
    const found = readPending(ctx)
    const { pend } = settle(ctx, conn, found)
    const origin = opts.url ? originOf(opts.url) : conn?.origin || found?.origin
    if (!origin)
      throw new Fail(
        "no_url",
        "No Mikud address is known. Ask the owner for it, then run: mikud connect --url <address>",
      )
    // The open code again, unless asked for a new one (--replace: the link did not work for the owner).
    if (pend && !opts.replace && pend.origin === origin && pend.phase === "polling" && pend.codeExpiresAt > now())
      return pendingAnswer(pend)
    if (conn && !opts.replace)
      throw new Fail(
        "already_connected",
        `Already connected to ${conn.origin} with the key "${conn.keyName}", until ${conn.expiresAt}. To connect again, run: mikud connect --replace`,
      )
    const r = await request(origin, "POST", `${origin}/api/auth/device/code`, {
      json: { client_id: CLIENT_ID },
      connect: true,
    })
    if (r.status !== 200) throw httpFail(r, "Asking Mikud for a code")
    const d = r.json ?? {}
    const deviceCode = str(d.device_code)
    const userCode = str(d.user_code)
    const link = str(d.verification_uri_complete)
    if (!SECRET.test(deviceCode) || !/^[A-Za-z0-9-]{4,20}$/.test(userCode) || !PLAIN.test(link))
      throw new Fail("unexpected_answer", "Mikud answered without a usable code. Nothing was stored.")
    let linkOrigin = ""
    try {
      linkOrigin = new URL(link).origin
    } catch {}
    if (linkOrigin !== origin)
      throw new Fail("unexpected_answer", `Mikud's approval link is not on ${origin}. Nothing was stored.`)
    // A pending attempt is replaced only now, once the new code exists; its link stops being used.
    if (pend) removeAttempt(ctx, pend, conn)
    const t = now()
    const interval = Math.max(1, Math.floor(Number(d.interval) || 5))
    const next = {
      v: 1,
      attemptId: hex(8),
      origin,
      deviceCode,
      userCode,
      link,
      interval,
      nextPollAt: t + interval,
      codeExpiresAt: t + Math.max(1, Math.floor(Number(d.expires_in) || 600)),
      days,
      keyName: keyName(),
      phase: "polling",
      pollInFlight: 0,
      uncertain: 0,
      sessionOpen: 0,
      keySaved: 0,
    }
    writePendingIf(ctx, next, null)
    return pendingAnswer(next)
  })
  print({ ...result, left: leftNow(ctx) })
}

async function waitForApproval(ctx, opts) {
  let origin = opts.url ? originOf(opts.url) : ""
  if (!origin) {
    origin = readPending(ctx)?.origin ?? ""
    if (!origin) throw new Fail("not_connected", "No connection is being made. Run: mikud connect --url <address>")
  }
  const until = Date.now() + WAIT_SECONDS * 1000
  const state = { attemptId: null }
  for (;;) {
    let step
    try {
      step = await withLock(ctx, (token) => waitStep(ctx, origin, state, token))
    } catch (e) {
      if (e instanceof Changed) continue
      throw e
    }
    if (step.done) return print({ ...step.done, left: leftNow(ctx) })
    if (Date.now() + step.wait * 1000 > until)
      return print({ status: "still_waiting", next: waitCommand(origin), left: leftNow(ctx) })
    await sleep(step.wait * 1000)
  }
}

/** One look at the attempt under the lock: an answer, the seconds until the next poll, or one poll. */
async function waitStep(ctx, origin, state, token) {
  const conn = readConnection(ctx)
  const settled = settle(ctx, conn, readPending(ctx))
  const pend = settled.pend
  if (settled.orphan?.origin === origin) {
    if (settled.warnings.length) throw unknownFail(settled.warnings, settled.orphan)
    if (conn?.keyName === settled.orphan.keyName) return { done: connectedAnswer(conn) }
  }
  if (!pend || pend.origin !== origin) {
    // Another command finished this attempt (a parallel --wait), or it was never made here.
    if (conn && conn.origin === origin && (state.attemptId || !pend)) return { done: connectedAnswer(conn) }
    if (state.attemptId) throw new Fail("not_connected", `The connection to ${origin} was cancelled meanwhile.`)
    throw new Fail("not_connected", `No connection to ${origin} is being made. Run: mikud connect --url ${origin}`)
  }
  // Replaced meanwhile (connect --replace): the new attempt has its own link and code.
  if (state.attemptId && pend.attemptId !== state.attemptId) return { done: pendingAnswer(pend) }
  state.attemptId = pend.attemptId
  const t = now()
  if (pend.codeExpiresAt <= t) {
    const warnings = removeAttempt(ctx, pend, conn)
    if (warnings.length) throw unknownFail(warnings, pend)
    throw new Fail("expired", "The code expired before it was approved. Run: mikud connect")
  }
  if (pend.nextPollAt > t) return { wait: pend.nextPollAt - t }
  // A mark left set: the run before this one sent a poll and never recorded its answer.
  if (pend.pollInFlight) pend.uncertain = 1
  pend.pollInFlight = 1
  writePendingIf(ctx, pend, pend.attemptId)
  assertMine(ctx, token)
  hook("poll")
  let r
  try {
    r = await request(origin, "POST", `${origin}/api/auth/device/token`, {
      json: { grant_type: DEVICE_GRANT, device_code: pend.deviceCode, client_id: CLIENT_ID },
      connect: true,
    })
  } catch (e) {
    if (e.code === "unreachable") {
      pend.pollInFlight = 0
      if (e.extra.sent !== false) pend.uncertain = 1
      pend.nextPollAt = now() + pend.interval
      writePendingIf(ctx, pend, pend.attemptId)
    }
    throw e
  }
  const sessionToken = r.status === 200 ? str(r.json?.access_token) : ""
  if (sessionToken) return { done: await redeem(ctx, pend, sessionToken) }
  const error = str(r.json?.error)
  pend.pollInFlight = 0
  if (error === "authorization_pending" || error === "slow_down" || r.status === 429) {
    // RFC 8628: 5 seconds longer from now on; a rate-limited poll is the same request to slow down.
    if (error === "slow_down" || r.status === 429) pend.interval += 5
    pend.nextPollAt = now() + pend.interval
    writePendingIf(ctx, pend, pend.attemptId)
    return { wait: pend.interval }
  }
  if (["access_denied", "expired_token", "invalid_grant"].includes(error)) {
    const warnings = removeAttempt(ctx, pend, conn)
    if (warnings.length) throw unknownFail(warnings, pend)
    if (error === "access_denied")
      throw new Fail("denied", "The owner did not approve the connection. Nothing was created.")
    throw new Fail("expired", "The code is no longer valid. Run: mikud connect")
  }
  // A failure after the server may have started: a session may exist.
  if (r.status >= 500 || r.status === 200) pend.uncertain = 1
  pend.nextPollAt = now() + pend.interval
  writePendingIf(ctx, pend, pend.attemptId)
  throw httpFail(r, "Waiting for the approval")
}

/** Ends the approval's session with its own token. True only when Mikud confirmed it. */
async function endSession(origin, sessionToken) {
  try {
    const r = await request(origin, "POST", `${origin}/api/auth/revoke-session`, {
      json: { token: sessionToken },
      bearer: sessionToken,
      connect: true,
    })
    return r.status === 200 && r.json?.status === true
  } catch {
    return false
  }
}

/**
 * The approved code gave a session token: record that a key is being created, create it, save the connection, end
 * the session, remove the attempt. In this order in every version, all under the lock.
 */
async function redeem(ctx, pend, sessionToken) {
  const id = pend.attemptId
  try {
    writePendingIf(ctx, { ...pend, phase: "creating_key", sessionOpen: 1, pollInFlight: 0 }, id)
  } catch (e) {
    // Nothing is sent before this mark is written: the session ends at once.
    await endSession(pend.origin, sessionToken)
    if (e instanceof Changed)
      throw new Fail("cannot_save", "The connection changed while this command ran. Run: mikud status")
    throw e
  }
  hook("token")
  let outcome
  try {
    outcome = { conn: await createAndSave(ctx, pend, sessionToken) }
  } catch (e) {
    outcome = { fail: e }
  }
  const ended = await endSession(pend.origin, sessionToken)
  if (ended) {
    try {
      const latest = readPending(ctx)
      if (latest?.attemptId === id) writePendingIf(ctx, { ...latest, sessionOpen: 0 }, id)
    } catch {}
  }
  hook("revoked")
  const last = readPending(ctx)
  if (last?.attemptId === id) removeAttempt(ctx, last, readConnection(ctx))
  else if (!ended) addLeft(ctx, [{ origin: pend.origin, keyName: pend.keyName, reason: "session_unknown" }])
  hook("done")
  if (outcome.fail) {
    if (!ended && outcome.fail instanceof Fail) outcome.fail.message += ` ${SESSION_TEXT}`
    throw outcome.fail
  }
  return {
    ...connectedAnswer(outcome.conn),
    ...(ended
      ? {}
      : {
          warning: `Could not confirm that the approval's temporary session ended. End the session "mikud connect (agent approval)" on the Account page in Mikud.`,
        }),
  }
}

async function createAndSave(ctx, pend, sessionToken) {
  const { origin, keyName: name } = pend
  const unknown = () =>
    new Fail(
      "key_unknown",
      `Mikud's answer to creating the key was lost, so a key named "${name}" may exist on ${origin}: delete it in Settings, Agent access. Then run: mikud connect`,
    )
  let r
  try {
    r = await request(origin, "POST", `${origin}/api/auth/api-key/create`, {
      json: { name, expiresIn: pend.days * 86_400 },
      bearer: sessionToken,
      connect: true,
    })
  } catch (e) {
    if (e.code === "unreachable" && e.extra.sent !== false) throw unknown()
    throw e
  }
  hook("key")
  if (r.status >= 500) throw unknown()
  if (r.status !== 200) throw httpFail(r, "Creating the key")
  const key = str(r.json?.key)
  const expiresAt = str(r.json?.expiresAt)
  if (!SECRET.test(key) || !PLAIN.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) throw unknown()
  const notSaved = (fail) => {
    try {
      addLeft(ctx, [{ origin, keyName: name, expiresAt, reason: "not_saved" }])
    } catch {
      fail.message += ` The key "${name}" on ${origin} works until ${expiresAt}: delete it in Settings, Agent access.`
    }
    return fail
  }
  // Saved only while the attempt is still this run's: a parallel disconnect or --replace wins.
  if (readPending(ctx)?.attemptId !== pend.attemptId)
    throw notSaved(
      new Fail(
        "cannot_save",
        "Another mikud command disconnected or started a new connection while this one waited, so the new key was not saved. Run: mikud status",
      ),
    )
  let old
  try {
    old = readConnection(ctx)
    // The key being replaced stays on Mikud: recorded before the connection that names it is replaced.
    if (old && old.keyName !== name)
      addLeft(ctx, [{ origin: old.origin, keyName: old.keyName, expiresAt: old.expiresAt, reason: "replaced" }])
    writeConnection(ctx, { v: 1, origin, key, keyName: name, expiresAt })
  } catch (e) {
    if (old && old.keyName !== name) {
      try {
        const kept = readConnection(ctx)
        if (kept?.keyName === old.keyName)
          writeLeft(
            ctx,
            readLeft(ctx).filter(
              (x) => !(x.keyName === old.keyName && x.origin === old.origin && x.reason === "replaced"),
            ),
          )
      } catch {}
    }
    throw notSaved(e instanceof Fail ? e : new Fail("cannot_save", `Cannot save the connection in ${ctx.dir}.`))
  }
  try {
    const latest = readPending(ctx)
    if (latest?.attemptId === pend.attemptId) writePendingIf(ctx, { ...latest, keySaved: 1 }, pend.attemptId)
  } catch {}
  hook("saved")
  return { origin, keyName: name, expiresAt }
}

/* The other commands */

function status(ctx) {
  const conn = readConnection(ctx)
  const pend = readPending(ctx)
  const out = { status: conn ? "connected" : "not_connected" }
  if (conn) Object.assign(out, { origin: conn.origin, keyName: conn.keyName, expiresAt: conn.expiresAt })
  // An attempt whose key was saved and whose session ended is a finished connect that only lost its last step.
  const finished = pend && pend.phase === "creating_key" && keySaved(pend, conn) && !pend.sessionOpen
  if (pend && !finished) {
    const warnings = attemptWarnings(pend, conn)
    out.pending = {
      origin: pend.origin,
      link: pend.link,
      code: groupedCode(pend.userCode),
      expiresAt: iso(pend.codeExpiresAt),
      ...(warnings.length ? { warnings } : {}),
    }
  }
  out.left = publicLeft(readLeft(ctx))
  return out
}

async function disconnect(ctx) {
  if (!secureHome(ctx, false)) return print({ status: "not_connected", left: [] })
  const result = await withLock(ctx, async () => {
    const conn = readConnection(ctx)
    const pend = readPending(ctx)
    if (pend) removeAttempt(ctx, pend, conn)
    if (!conn) return { status: "not_connected" }
    // The key stays on Mikud (a key cannot delete itself): recorded before the connection is removed.
    addLeft(ctx, [{ origin: conn.origin, keyName: conn.keyName, expiresAt: conn.expiresAt, reason: "disconnected" }])
    removeFile(ctx, ctx.connection)
    return {
      status: "disconnected",
      origin: conn.origin,
      keyName: conn.keyName,
      expiresAt: conn.expiresAt,
      message: `Forgot the connection on this computer. The key "${conn.keyName}" still works on ${conn.origin} until ${conn.expiresAt}: delete it in Settings, Agent access, if nothing uses it.`,
    }
  })
  print({ ...result, left: leftNow(ctx) })
}

/* The API */

function apiPath(method, raw) {
  const bad = (why) =>
    new Fail(
      "bad_path",
      `${why} Use one of the paths in SKILL.md, for example: get 'items?q=login' (percent-encode anything else in a query).`,
    )
  let value = String(raw ?? "")
  if (value.startsWith("/")) value = value.slice(1)
  const q = value.indexOf("?")
  const part = q < 0 ? value : value.slice(0, q)
  const query = q < 0 ? "" : value.slice(q + 1)
  if (!PATH_PART.test(part) || part.includes("//"))
    throw bad("The path may hold only lower-case letters, digits, / and -.")
  if (q >= 0 && method !== "GET") throw bad("Only get takes a query.")
  if (!QUERY.test(query)) throw bad("The query holds a character that must be percent-encoded.")
  if (!ROUTES.some(([m, re]) => m === method && re.test(part)))
    throw bad(`${method.toLowerCase()} '${part}' is not a call this skill makes.`)
  return q < 0 ? part : `${part}?${query}`
}

function bodyOf(method, opts) {
  if (method === "GET") {
    if (opts.json !== undefined || opts.jsonFile !== undefined) throw new Fail("bad_json", "get takes no body.")
    return undefined
  }
  let text = opts.json
  if (opts.jsonFile !== undefined) {
    if (text !== undefined) throw new Fail("bad_json", "Give either --json or --json-file, not both.")
    try {
      text = fs.readFileSync(opts.jsonFile, "utf8")
    } catch {
      throw new Fail("bad_json", `Cannot read ${opts.jsonFile}.`)
    }
  }
  if (text === undefined)
    throw new Fail("bad_json", `${method.toLowerCase()} needs a body: --json '<body>' or --json-file <file>.`)
  try {
    JSON.parse(text)
  } catch {
    throw new Fail("bad_json", "The body is not JSON.")
  }
  return text
}

function labelOf(opts) {
  const label = opts.as ?? process.env.MIKUD_AGENT_LABEL ?? ""
  if (label === "" && opts.as === undefined) return ""
  if (!LABEL.test(label))
    throw new Fail("bad_label", "The agent label takes 1 to 60 letters, digits, spaces and . _ : - only.")
  return label
}

/** A key Mikud no longer accepts is forgotten, while it is still the saved one. */
async function forget(ctx, conn) {
  try {
    await withLock(ctx, async () => {
      const saved = readConnection(ctx)
      if (saved && saved.key === conn.key) removeFile(ctx, ctx.connection)
    })
  } catch {}
}

async function api(ctx, method, opts) {
  if (opts.positional.length !== 1) throw new Fail("bad_path", `Give one path: mikud ${method.toLowerCase()} '<path>'`)
  const target = apiPath(method, opts.positional[0])
  const label = labelOf(opts)
  const body = bodyOf(method, opts)
  const conn = readConnection(ctx)
  if (!conn) throw new Fail("not_connected", "Not connected to Mikud. Run: mikud connect")
  if (opts.url && originOf(opts.url) !== conn.origin)
    throw new Fail("not_connected", `Connected to ${conn.origin}, not to ${originOf(opts.url)}.`)
  const unknown = (status) =>
    new Fail(
      "outcome_unknown",
      `The ${method} was sent, but its answer was lost${status ? ` (${status})` : ""}: it may still be written. Read the state once before doing anything else, and never send it again blindly.`,
      status ? { status } : {},
    )
  let r
  try {
    r = await request(conn.origin, method, `${conn.origin}/api/v1/${target}`, {
      json: body,
      bearer: conn.key,
      label,
    })
  } catch (e) {
    if (e.code === "unreachable" && method !== "GET" && e.extra.sent !== false) throw unknown()
    throw e
  }
  if (r.status === 401) {
    await forget(ctx, conn)
    throw new Fail(
      "connection_ended",
      `Mikud no longer accepts this connection's key (it was disconnected in Settings or it expired). Run: mikud connect --url ${conn.origin}`,
    )
  }
  if (method !== "GET" && [502, 503, 504].includes(r.status)) throw unknown(r.status)
  if (r.status >= 200 && r.status < 300) return print({ status: r.status, data: r.json })
  throw httpFail(r, `${method} ${target.split("?")[0]}`)
}

async function main() {
  const args = process.argv.slice(2)
  const command = args.shift() ?? "help"
  if (["help", "--help", "-h"].includes(command)) return process.stdout.write(`${HELP}\n`)
  if (Number(process.versions.node.split(".")[0]) < 20)
    throw new Fail("node_too_old", "Node 20 or later is needed. Use the mikud launcher, which picks another version.")
  if (!win) process.umask(0o077)
  const opts = parseArgs(args)
  const ctx = context()
  try {
    if (command === "status") {
      if (opts.clearLeft) {
        secureHome(ctx, true)
        await withLock(ctx, async () => writeLeft(ctx, []))
      }
      return print(status(ctx))
    }
    if (command === "connect") return opts.wait ? await waitForApproval(ctx, opts) : await connect(ctx, opts)
    if (command === "disconnect") return await disconnect(ctx)
    if (command === "get") return await api(ctx, "GET", opts)
    if (command === "post") return await api(ctx, "POST", opts)
    if (command === "patch") return await api(ctx, "PATCH", opts)
  } catch (e) {
    // What the command left on Mikud travels with every answer about the connection.
    if (e instanceof Fail && ["connect", "disconnect", "status"].includes(command)) e.extra.left = leftNow(ctx)
    throw e
  }
  throw new Fail("unknown_command", `Unknown command "${command}". Run: mikud help`)
}

main().catch((e) => {
  if (e instanceof Fail) {
    print({
      error: e.code,
      message: e.message,
      ...(e.extra.status !== undefined ? { status: e.extra.status } : {}),
      ...(e.extra.body !== undefined && e.extra.body !== null ? { body: e.extra.body } : {}),
      ...(e.extra.left?.length ? { left: e.extra.left } : {}),
    })
  } else {
    print({ error: "failed", message: String(e?.message ?? e) })
  }
  process.exitCode = 1
})
