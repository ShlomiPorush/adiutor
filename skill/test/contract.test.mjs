// The command's contract, run against every version this computer can run (MIKUD_IMPLS picks them; a version whose
// file does not exist yet is skipped): the same answers, the same files, and the same care with what a lost answer or
// a stopped run may leave on Mikud. Every secret comes from fake-server.mjs, new for every run.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, beforeEach, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { startFakeServer } from "./fake-server.mjs"

const win = process.platform === "win32"
const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mikud", "scripts")
const FILES = { node: "mikud.mjs", sh: "mikud.sh", ps: "mikud.ps1", pwsh: "mikud.ps1" }
// ps is Windows PowerShell 5.1, pwsh PowerShell 7: the same mikud.ps1 runs on both.
const requested = (process.env.MIKUD_IMPLS ?? (win ? "node,ps,pwsh" : "node,sh")).split(",").filter(Boolean)
for (const impl of requested) if (!FILES[impl]) throw new Error(`unknown implementation ${impl}`)
const present = (impl) => fs.existsSync(path.join(scripts, FILES[impl]))
const impls = requested.filter(present)
const tmpBase = process.env.MIKUD_TEST_TMP ?? (win ? "T:\\mikud\\skill-tests" : os.tmpdir())
fs.mkdirSync(tmpBase, { recursive: true })
const root = fs.mkdtempSync(path.join(tmpBase, "run-"))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DAY = 86_400
const uuid = () => randomUUID()
const host = () => (win ? process.env.COMPUTERNAME || os.hostname() : os.hostname())

// A stand-in node first on PATH for the versions that must not hand over to Node: it records a call and fails.
const standin = path.join(root, "standin")
fs.mkdirSync(standin)
const nodeCalled = path.join(root, "node-called")
fs.writeFileSync(path.join(standin, "node"), `#!/bin/sh\necho called >> "$MIKUD_TEST_NODE_CALLED"\nexit 1\n`, {
  mode: 0o755,
})
fs.writeFileSync(path.join(standin, "node.cmd"), `@echo called>>"%MIKUD_TEST_NODE_CALLED%"\r\n@exit /b 1\r\n`)
// The sh version's curl, wrapped to record its arguments (no secret may be in them).
const curlWrap = path.join(root, "curlwrap")
const curlArgs = path.join(root, "curl-args")
if (!win) {
  let realCurl = ""
  try {
    realCurl = execFileSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).trim()
  } catch {}
  if (realCurl) {
    fs.mkdirSync(curlWrap)
    fs.writeFileSync(
      path.join(curlWrap, "curl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${curlArgs}"\nexec "${realCurl}" "$@"\n`,
      { mode: 0o755 },
    )
  }
}

function command(impl) {
  if (impl === "node") return [process.execPath, [path.join(scripts, "mikud.mjs")]]
  if (impl === "sh") return ["sh", [path.join(scripts, "mikud.sh")]]
  const ps = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "mikud.ps1")]
  if (impl === "ps") return ["powershell.exe", ps]
  if (impl === "pwsh") return ["pwsh", ps]
  throw new Error(`unknown implementation ${impl}`)
}

/** The environment every run gets: its own folder, no Mikud settings from the host. */
function baseEnv(home, extra) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith("MIKUD_")) delete env[k]
  return { ...env, MIKUD_SKILL_HOME: home, MIKUD_WAIT_SECONDS: "8", MIKUD_TEST_NODE_CALLED: nodeCalled, ...extra }
}

/** Runs one command; resolves with its exit code, its parsed answer and its raw output. */
function run(impl, home, args, env = {}) {
  const [cmd, base] = command(impl)
  const extra = { ...env }
  if (impl !== "node") {
    extra.MIKUD_NO_NODE = "1"
    const dirs = [standin, ...(impl === "sh" && fs.existsSync(curlWrap) ? [curlWrap] : [])]
    extra.PATH = [...dirs, process.env.PATH].join(path.delimiter)
  }
  const child = spawn(cmd, [...base, ...args], { env: baseEnv(home, extra), stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  let err = ""
  child.stdout.on("data", (d) => {
    out += d
  })
  child.stderr.on("data", (d) => {
    err += d
  })
  const done = new Promise((resolve) => {
    child.on("close", (code) => {
      let json = null
      try {
        json = JSON.parse(out.trim().split("\n").at(-1))
      } catch {}
      // A pass proves that the version itself ran: the stand-in node was never called.
      if (impl !== "node") assert.equal(fs.existsSync(nodeCalled), false, `${impl} handed over to node`)
      resolve({ code, json, out, err, all: `${out}\n${err}` })
    })
  })
  done.child = child
  return done
}

/** Waits until a held run reached a test hook. */
async function reached(file) {
  for (let i = 0; i < 600; i++) {
    if (fs.existsSync(`${file}.reached`)) return
    await sleep(50)
  }
  throw new Error(`hook ${file} not reached`)
}

const go = (file) => fs.writeFileSync(`${file}.go`, "")

async function kill(p) {
  p.child.kill("SIGKILL")
  await new Promise((resolve) => p.child.on("close", resolve))
}

function noSecrets(server, ...results) {
  const { deviceCodes, sessions, keys } = server.secrets()
  for (const r of results)
    for (const secret of [...deviceCodes, ...sessions, ...keys])
      assert.ok(!r.all.includes(secret), `a secret appeared in the output: ${r.out}`)
}

/** Every file under a folder, with its content. */
function filesUnder(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { recursive: true })
    .map((f) => path.join(dir, String(f)))
    .filter((f) => fs.lstatSync(f).isFile())
    .map((f) => [path.relative(dir, f), fs.readFileSync(f, "utf8")])
}

const leftReasons = (answer) => (answer.left ?? []).map((e) => e.reason).sort()

after(() => fs.rmSync(root, { recursive: true, force: true }))

for (const impl of requested.filter((i) => !present(i)))
  describe.skip(`mikud (${impl}): ${FILES[impl]} does not exist yet`, () => {})

for (const impl of impls) {
  describe(`mikud (${impl})`, () => {
    let server
    let other
    let n = 0
    before(async () => {
      server = await startFakeServer()
      other = await startFakeServer()
    })
    after(async () => {
      await server.close()
      await other.close()
    })
    beforeEach(() => {
      server.reset()
      other.reset()
      fs.rmSync(nodeCalled, { force: true })
      fs.rmSync(curlArgs, { force: true })
    })
    const fresh = () => path.join(root, `${impl}-${++n}`, "home")
    const r = (home, args, env) => run(impl, home, args, env)

    async function connected(home, srv = server, args = []) {
      const c = await r(home, ["connect", "--url", srv.origin, ...args])
      assert.equal(c.json?.status, "pending", c.all)
      srv.approve()
      const w = await r(home, ["connect", "--wait", "--url", srv.origin])
      assert.equal(w.json?.status, "connected", w.all)
      return w
    }

    // --- Connecting ---

    it("connects end to end: one key, its session ended, nothing left, no secret anywhere but its files", async () => {
      const home = fresh()
      const c = await r(home, ["connect", "--url", server.origin])
      assert.equal(c.code, 0, c.all)
      assert.equal(c.json.status, "pending")
      assert.equal(c.json.origin, server.origin)
      assert.match(c.json.link, new RegExp(`^${server.origin}/connect/device\\?user_code=[A-Z0-9]{8}$`))
      assert.match(c.json.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
      assert.equal(c.json.next, `mikud connect --wait --url ${server.origin}`)
      assert.deepEqual(c.json.left, [])
      const s1 = await r(home, ["status"])
      assert.equal(s1.json.status, "not_connected", s1.all)
      assert.equal(s1.json.pending.code, c.json.code)
      // The same attempt again, without --url: nothing new is requested.
      const again = await r(home, ["connect"])
      assert.equal(again.json.code, c.json.code, again.all)
      assert.equal(server.counts.deviceCode, 1)
      server.approve()
      const w = await r(home, ["connect", "--wait", "--url", server.origin])
      assert.equal(w.code, 0, w.all)
      assert.equal(w.json.status, "connected")
      assert.match(w.json.keyName, /^skill:[A-Za-z0-9._-]{1,15}:[0-9a-f]{8}$/)
      assert.ok(w.json.keyName.length <= 32)
      assert.equal(w.json.warning, undefined)
      assert.deepEqual(w.json.left, [], "a normal connect leaves no left entry")
      const keys = server.aliveKeys()
      assert.equal(keys.length, 1)
      assert.equal(keys[0][1].name, w.json.keyName)
      assert.equal(keys[0][1].expiresIn, 90 * DAY)
      assert.equal(w.json.expiresAt, keys[0][1].expiresAt)
      assert.equal(server.aliveSessions(), 0, "the approval's session was ended")
      assert.equal(server.counts.revoke, 1)
      for (const req of server.authRequests()) assert.equal(req.userAgent, "mikud-connect", req.path)
      const s2 = await r(home, ["status"])
      assert.deepEqual(
        { ...s2.json },
        {
          status: "connected",
          origin: server.origin,
          keyName: w.json.keyName,
          expiresAt: w.json.expiresAt,
          left: [],
        },
      )
      const g = await r(home, ["get", "items?q=login"])
      assert.equal(g.code, 0, g.all)
      assert.equal(g.json.status, 200)
      assert.equal(g.json.data.path, "/api/v1/items")
      assert.equal(g.json.data.query, "?q=login")
      assert.equal(server.requests.at(-1).authorization, `Bearer ${keys[0][0]}`)
      assert.notEqual(server.requests.at(-1).userAgent, "mikud-connect")
      noSecrets(server, c, s1, again, w, s2, g)
      // Files: the key only in `connection`, nothing else left behind (no lock, no temporary file).
      const files = filesUnder(home)
      assert.deepEqual(
        files.map(([f]) => f),
        ["connection"],
      )
      const { deviceCodes, sessions } = server.secrets()
      for (const [, text] of files)
        for (const secret of [...deviceCodes, ...sessions]) assert.ok(!text.includes(secret))
      if (impl === "sh" && fs.existsSync(curlArgs)) {
        const argv = fs.readFileSync(curlArgs, "utf8")
        for (const secret of [...deviceCodes, ...sessions, keys[0][0]])
          assert.ok(!argv.includes(secret), "a secret in curl's argv")
      }
      const already = await r(home, ["connect"])
      assert.equal(already.json.error, "already_connected", already.all)
      assert.equal(already.code, 1)
    })

    // Started from PowerShell 7, a child Windows PowerShell inherits PS7's module path and cannot load Get-Acl.
    it("connects when started from PowerShell 7 (its PSModulePath inherited)", {
      skip: !win && "Windows only",
    }, async () => {
      const pwshModules = [
        path.join(os.homedir(), "Documents", "PowerShell", "Modules"),
        "C:\\Program Files\\PowerShell\\Modules",
        "C:\\Program Files\\PowerShell\\7\\Modules",
      ].join(";")
      const home = fresh()
      const c = await r(home, ["connect", "--url", server.origin], { PSModulePath: pwshModules })
      assert.equal(c.json?.status, "pending", c.all)
      server.approve()
      const w = await r(home, ["connect", "--wait", "--url", server.origin], { PSModulePath: pwshModules })
      assert.equal(w.json?.status, "connected", w.all)
      const s = await r(home, ["status"], { PSModulePath: pwshModules })
      assert.equal(s.json?.status, "connected", s.all)
    })

    it("names the key after MIKUD_AGENT_NAME, cut to 32 characters, and keeps --days", async () => {
      const home = fresh()
      const c = await r(home, ["connect", "--url", server.origin, "--days", "7"], {
        MIKUD_AGENT_NAME: "Build box (east) with a long name",
      })
      assert.equal(c.json?.status, "pending", c.all)
      server.approve()
      const w = await r(home, ["connect", "--wait", "--url", server.origin], { MIKUD_AGENT_NAME: "ignored" })
      assert.equal(w.json?.status, "connected", w.all)
      assert.match(w.json.keyName, /^skill:Build-box-east:[0-9a-f]{8}$/)
      assert.equal(server.aliveKeys()[0][1].expiresIn, 7 * DAY)
      for (const bad of ["0", "366", "x", "1.5"]) {
        const b = await r(fresh(), ["connect", "--url", server.origin, "--days", bad])
        assert.equal(b.json?.error, "bad_option", `${bad}: ${b.all}`)
      }
    })

    it("keeps waiting, slows down when asked, and says when the owner denied", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.slowDownOnce = true
      const w = await r(home, ["connect", "--wait", "--url", server.origin], { MIKUD_WAIT_SECONDS: "3" })
      assert.equal(w.code, 0, w.all)
      assert.equal(w.json.status, "still_waiting")
      assert.equal(w.json.next, `mikud connect --wait --url ${server.origin}`)
      server.deny()
      const d = await r(home, ["connect", "--wait", "--url", server.origin])
      assert.equal(d.json.error, "denied", d.all)
      assert.equal(d.code, 1)
      assert.equal((await r(home, ["status"])).json.pending, undefined)
    })

    it("says when the code expired", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.expire()
      const w = await r(home, ["connect", "--wait", "--url", server.origin])
      assert.equal(w.json.error, "expired", w.all)
      assert.deepEqual((await r(home, ["status"])).json.left, [])
    })

    it("--replace keeps the old connection until the new one is saved, then reports the old key", async () => {
      const home = fresh()
      const first = await connected(home)
      const oldKey = server.aliveKeys()[0][0]
      const c = await r(home, ["connect", "--replace"])
      assert.equal(c.json?.status, "pending", c.all)
      const s = await r(home, ["status"])
      assert.equal(s.json.status, "connected")
      assert.equal(s.json.keyName, first.json.keyName, "the old connection stays while the new one waits")
      assert.equal((await r(home, ["get", "projects"])).code, 0)
      assert.equal(server.requests.at(-1).authorization, `Bearer ${oldKey}`)
      // Showing the attempt again does not need --replace.
      assert.equal((await r(home, ["connect"])).json.code, c.json.code)
      server.approve()
      const w = await r(home, ["connect", "--wait", "--url", server.origin])
      assert.equal(w.json?.status, "connected", w.all)
      assert.notEqual(w.json.keyName, first.json.keyName)
      assert.deepEqual(
        w.json.left.map(({ origin, keyName, expiresAt, reason }) => ({ origin, keyName, expiresAt, reason })),
        [{ origin: server.origin, keyName: first.json.keyName, expiresAt: first.json.expiresAt, reason: "replaced" }],
      )
      assert.match(w.json.left[0].message, /Settings, Agent access/)
      assert.equal(server.keys.get(oldKey).alive, true, "the command cannot delete a key")
      await r(home, ["get", "projects"])
      assert.notEqual(server.requests.at(-1).authorization, `Bearer ${oldKey}`)
    })

    it("--replace on a pending attempt starts a new one", async () => {
      const home = fresh()
      const a = await r(home, ["connect", "--url", server.origin])
      const b = await r(home, ["connect", "--replace"])
      assert.equal(b.json?.status, "pending", b.all)
      assert.notEqual(b.json.code, a.json.code)
      server.approve()
      const w = await r(home, ["connect", "--wait", "--url", server.origin])
      assert.equal(w.json?.status, "connected", w.all)
      assert.deepEqual(w.json.left, [])
    })

    it("disconnect forgets the connection and reports the key left on Mikud", async () => {
      const home = fresh()
      const w = await connected(home)
      const d = await r(home, ["disconnect"])
      assert.equal(d.json?.status, "disconnected", d.all)
      assert.equal(d.json.keyName, w.json.keyName)
      assert.deepEqual(leftReasons(d.json), ["disconnected"])
      assert.equal(d.json.left[0].origin, server.origin)
      const s = await r(home, ["status"])
      assert.equal(s.json.status, "not_connected")
      assert.deepEqual(leftReasons(s.json), ["disconnected"])
      assert.equal((await r(home, ["get", "items"])).json.error, "not_connected")
      assert.equal(server.aliveKeys().length, 1)
      const cleared = await r(home, ["status", "--clear-left"])
      assert.deepEqual(cleared.json.left, [], cleared.all)
      assert.equal((await r(fresh(), ["disconnect"])).json.status, "not_connected")
    })

    it("asks for an address when none is known", async () => {
      const home = fresh()
      const c = await r(home, ["connect"])
      assert.equal(c.json?.error, "no_url", c.all)
      assert.equal((await r(home, ["status"])).json.status, "not_connected")
    })

    // --- Lost answers ---

    it("a /device/token answer lost, then the code used: session_unknown, never a plain expired", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.approve()
      server.lose.token = true
      const lost = await r(home, ["connect", "--wait", "--url", server.origin])
      assert.equal(lost.json?.error, "unreachable", lost.all)
      assert.deepEqual((await r(home, ["status"])).json.pending.warnings, ["session_unknown"])
      const next = await r(home, ["connect", "--wait", "--url", server.origin])
      assert.equal(next.json?.error, "session_unknown", next.all)
      assert.deepEqual(leftReasons(next.json), ["session_unknown"])
      const s = await r(home, ["status"])
      assert.equal(s.json.pending, undefined)
      assert.deepEqual(leftReasons(s.json), ["session_unknown"])
      assert.equal(server.aliveKeys().length, 0)
    })

    it("an /api-key/create answer lost: key_unknown with the name, and the session still ended", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.approve()
      server.lose.key = true
      const w = await r(home, ["connect", "--wait", "--url", server.origin])
      assert.equal(w.json?.error, "key_unknown", w.all)
      const name = server.aliveKeys()[0][1].name
      assert.ok(w.json.message.includes(name))
      assert.equal(server.counts.revoke, 1)
      assert.equal(server.aliveSessions(), 0)
      const s = await r(home, ["status"])
      assert.equal(s.json.status, "not_connected")
      assert.deepEqual(
        s.json.left.map((e) => [e.reason, e.keyName, e.expiresAt]),
        [["key_unknown", name, ""]],
      )
    })

    it("a revoke answer lost: connected, with the Account page warning, and session_unknown recorded", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.approve()
      server.lose.revoke = true
      const w = await r(home, ["connect", "--wait", "--url", server.origin])
      assert.equal(w.json?.status, "connected", w.all)
      assert.match(w.json.warning, /mikud connect \(agent approval\)/)
      assert.deepEqual(leftReasons(w.json), ["session_unknown"])
    })

    it("a save that fails: the session is still ended and the key is reported", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.approve()
      const hold = path.join(root, `${impl}-save-${n}`)
      const p = r(home, ["connect", "--wait", "--url", server.origin], { MIKUD_TEST_HOLD_KEY: hold })
      await reached(hold)
      // The connection's place is taken by a folder: the save cannot happen.
      fs.mkdirSync(path.join(home, "connection"))
      go(hold)
      const w = await p
      assert.equal(w.code, 1, w.all)
      assert.ok(["cannot_save", "insecure_credentials"].includes(w.json?.error), w.all)
      assert.equal(server.aliveSessions(), 0, "the session was ended")
      const [[, key]] = server.aliveKeys()
      assert.ok(
        w.json.left.some((e) => e.reason === "not_saved" && e.keyName === key.name && e.expiresAt === key.expiresAt),
      )
      fs.rmdirSync(path.join(home, "connection"))
    })

    // --- Concurrency ---

    it("two --wait at once: one key, one revoke", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.approve()
      const [a, b] = await Promise.all([
        r(home, ["connect", "--wait", "--url", server.origin]),
        r(home, ["connect", "--wait", "--url", server.origin]),
      ])
      assert.equal(a.json?.status, "connected", a.all)
      assert.equal(b.json?.status, "connected", b.all)
      assert.equal(a.json.keyName, b.json.keyName)
      assert.equal(server.keys.size, 1)
      assert.equal(server.sessions.size, 1)
      assert.equal(server.counts.revoke, 1)
    })

    it("disconnect during --wait cancels the attempt", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      const p = r(home, ["connect", "--wait", "--url", server.origin])
      for (let i = 0; i < 200 && server.counts.deviceToken === 0; i++) await sleep(50)
      const d = await r(home, ["disconnect"])
      assert.equal(d.json?.status, "not_connected", d.all)
      server.approve()
      const w = await p
      assert.equal(w.json?.error, "not_connected", w.all)
      assert.equal(server.sessions.size, 0, "the code was never redeemed")
    })

    it("never breaks the lock of a live holder: others answer busy and send nothing", async () => {
      const home = fresh()
      const hold = path.join(root, `${impl}-live-${n}`)
      const holder = r(home, ["connect", "--url", server.origin], { MIKUD_TEST_HOLD_LOCKED: hold })
      await reached(hold)
      const busy = await r(home, ["connect", "--url", server.origin], { MIKUD_TEST_LOCK_WAIT_MS: "1500" })
      assert.equal(busy.json?.error, "busy", busy.all)
      assert.equal(server.counts.deviceCode, 0)
      go(hold)
      assert.equal((await holder).json?.status, "pending")
    })

    it("breaks the lock of a holder that died", async () => {
      const home = fresh()
      const hold = path.join(root, `${impl}-dead-${n}`)
      const holder = r(home, ["connect", "--url", server.origin], { MIKUD_TEST_HOLD_LOCKED: hold })
      await reached(hold)
      await kill(holder)
      const next = await r(home, ["connect", "--url", server.origin])
      assert.equal(next.json?.status, "pending", next.all)
    })

    it("breaks a lock whose process id now belongs to another process", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      const lock = path.join(home, "lock")
      fs.mkdirSync(lock)
      // This test's own process is alive, but it started at another time than the lock says.
      const owner = { token: "reused", host: host(), pid: process.pid, start: "not-its-start-time" }
      fs.writeFileSync(path.join(lock, "owner"), `${JSON.stringify(owner)}\n`)
      const s = await r(home, ["connect"])
      assert.equal(s.json?.status, "pending", s.all)
      assert.equal(fs.existsSync(lock), false)
    })

    it("never breaks a lock it cannot decide about, and names the folder to remove by hand", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      const lock = path.join(home, "lock")
      fs.mkdirSync(lock)
      const owner = { token: "elsewhere", host: "another-host.invalid", pid: 1, start: "1" }
      fs.writeFileSync(path.join(lock, "owner"), `${JSON.stringify(owner)}\n`)
      const a = await r(home, ["connect"], { MIKUD_TEST_LOCK_WAIT_MS: "1000" })
      assert.equal(a.json?.error, "busy", a.all)
      assert.ok(a.json.message.includes(lock), a.json.message)
      assert.equal(fs.existsSync(path.join(lock, "owner")), true)
      // An owner file that cannot be read is undecidable too.
      fs.rmSync(path.join(lock, "owner"))
      const b = await r(home, ["connect"], { MIKUD_TEST_LOCK_WAIT_MS: "1000" })
      assert.equal(b.json?.error, "busy", b.all)
      assert.equal(fs.existsSync(lock), true)
      fs.rmSync(lock, { recursive: true })
      assert.equal((await r(home, ["connect"])).json?.status, "pending")
    })

    it("releases the lock by its token only", async () => {
      const home = fresh()
      const hold = path.join(root, `${impl}-token-${n}`)
      const holder = r(home, ["connect", "--url", server.origin], { MIKUD_TEST_HOLD_LOCKED: hold })
      await reached(hold)
      // As if another command had wrongly broken it and taken a lock of its own.
      const owner = path.join(home, "lock", "owner")
      const theirs = { token: "theirs", host: host(), pid: process.pid, start: "x" }
      fs.writeFileSync(owner, `${JSON.stringify(theirs)}\n`)
      go(hold)
      assert.equal((await holder).json?.status, "pending")
      assert.equal(JSON.parse(fs.readFileSync(owner, "utf8")).token, "theirs")
      fs.rmSync(path.join(home, "lock"), { recursive: true })
    })

    it("refuses a save after its lock was broken and the attempt changed", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.approve()
      const hold = path.join(root, `${impl}-broken-${n}`)
      const a = r(home, ["connect", "--wait", "--url", server.origin], { MIKUD_TEST_HOLD_TOKEN: hold })
      await reached(hold)
      // A wrongly broken lock: another command replaces the attempt meanwhile.
      fs.rmSync(path.join(home, "lock"), { recursive: true })
      const b = await r(home, ["connect", "--replace"])
      assert.equal(b.json?.status, "pending", b.all)
      go(hold)
      const w = await a
      assert.equal(w.json?.error, "cannot_save", w.all)
      assert.equal(server.aliveSessions(), 0, "the session was still ended")
      const [[, key]] = server.aliveKeys()
      const s = await r(home, ["status"])
      assert.equal(s.json.status, "not_connected")
      assert.equal(s.json.pending.code, b.json.code)
      assert.ok(
        s.json.left.some((e) => e.reason === "not_saved" && e.keyName === key.name),
        s.all,
      )
    })

    // --- Interrupted runs ---

    it("a run killed with a poll in flight, then the code expires: session_unknown, not expired", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      const held = server.hold("token")
      const a = r(home, ["connect", "--wait", "--url", server.origin])
      await held.reached
      await kill(a)
      server.expire()
      held.open()
      const w = await r(home, ["connect", "--wait", "--url", server.origin])
      assert.equal(w.json?.error, "session_unknown", w.all)
      assert.deepEqual(leftReasons(await r(home, ["status"]).then((x) => x.json)), ["session_unknown"])
    })

    it("a run killed right after the token answer: key_unknown and session_unknown later", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.approve()
      const hold = path.join(root, `${impl}-token-kill-${n}`)
      const a = r(home, ["connect", "--wait", "--url", server.origin], { MIKUD_TEST_HOLD_TOKEN: hold })
      await reached(hold)
      await kill(a)
      const s = await r(home, ["status"])
      assert.deepEqual(s.json.pending.warnings, ["key_unknown", "session_unknown"], s.all)
      const w = await r(home, ["connect", "--wait", "--url", server.origin])
      assert.equal(w.json?.error, "key_unknown", w.all)
      assert.deepEqual(leftReasons(w.json), ["key_unknown", "session_unknown"])
    })

    it("a run killed while creating the key: key_unknown with its name", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.approve()
      const held = server.hold("key")
      const a = r(home, ["connect", "--wait", "--url", server.origin])
      await held.reached
      await kill(a)
      held.open()
      const w = await r(home, ["connect", "--wait", "--url", server.origin])
      assert.equal(w.json?.error, "key_unknown", w.all)
      const entry = w.json.left.find((e) => e.reason === "key_unknown")
      assert.equal(entry.keyName, server.aliveKeys()[0][1].name)
    })

    it("a revoke not confirmed and the run killed before its answer: status still reports the session", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.approve()
      server.revokeStatus = 500
      const hold = path.join(root, `${impl}-done-${n}`)
      const a = r(home, ["connect", "--wait", "--url", server.origin], { MIKUD_TEST_HOLD_DONE: hold })
      await reached(hold)
      await kill(a)
      const s = await r(home, ["status"])
      assert.equal(s.json.status, "connected", s.all)
      assert.deepEqual(leftReasons(s.json), ["session_unknown"])
    })

    it("a run killed after it replaced the connection: status reports the old key from the left record", async () => {
      const home = fresh()
      const first = await connected(home)
      await r(home, ["connect", "--replace"])
      server.approve()
      const hold = path.join(root, `${impl}-replaced-${n}`)
      const a = r(home, ["connect", "--wait", "--url", server.origin], { MIKUD_TEST_HOLD_DONE: hold })
      await reached(hold)
      await kill(a)
      const s = await r(home, ["status"])
      assert.notEqual(s.json.keyName, first.json.keyName)
      assert.deepEqual(
        s.json.left.map((e) => [e.reason, e.origin, e.keyName]),
        [["replaced", server.origin, first.json.keyName]],
      )
    })

    it("a run stopped after the revoke and before the attempt was removed: nothing to warn of", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.approve()
      const hold = path.join(root, `${impl}-revoked-${n}`)
      const a = r(home, ["connect", "--wait", "--url", server.origin], { MIKUD_TEST_HOLD_REVOKED: hold })
      await reached(hold)
      await kill(a)
      const s = await r(home, ["status"])
      assert.equal(s.json.status, "connected", s.all)
      assert.equal(s.json.pending, undefined)
      assert.deepEqual(s.json.left, [])
      const d = await r(home, ["disconnect"])
      assert.deepEqual(leftReasons(d.json), ["disconnected"])
    })

    it("keeps session_unknown and key_unknown past any end date until --clear-left", async () => {
      const home = fresh()
      await connected(home, server, ["--days", "1"])
      await r(home, ["connect", "--replace", "--days", "1"])
      server.approve()
      server.lose.key = true
      server.lose.revoke = false
      server.revokeStatus = 500
      const w = await r(home, ["connect", "--wait", "--url", server.origin])
      assert.equal(w.json?.error, "key_unknown", w.all)
      const later = { MIKUD_TEST_CLOCK_OFFSET: String(100 * DAY) }
      const s = await r(home, ["status"], later)
      // The connection's key ended, so a dated entry would have dropped; these have no date the command knows.
      assert.deepEqual(leftReasons(s.json), ["key_unknown", "session_unknown"], s.all)
      const cleared = await r(home, ["status", "--clear-left"], later)
      assert.deepEqual(cleared.json.left, [])
    })

    it("drops a dated entry once its key has ended", async () => {
      const home = fresh()
      await connected(home, server, ["--days", "1"])
      const d = await r(home, ["disconnect"])
      assert.deepEqual(leftReasons(d.json), ["disconnected"])
      const s = await r(home, ["status"], { MIKUD_TEST_CLOCK_OFFSET: String(2 * DAY) })
      assert.deepEqual(s.json.left, [], s.all)
    })

    it("replacing a connection to another Mikud keeps the old address in the entry", async () => {
      const home = fresh()
      const first = await connected(home)
      const c = await r(home, ["connect", "--replace", "--url", other.origin])
      assert.equal(c.json?.origin, other.origin, c.all)
      other.approve()
      const w = await r(home, ["connect", "--wait", "--url", other.origin])
      assert.equal(w.json?.status, "connected", w.all)
      assert.equal(w.json.origin, other.origin)
      assert.deepEqual(
        w.json.left.map((e) => [e.reason, e.origin, e.keyName]),
        [["replaced", server.origin, first.json.keyName]],
      )
    })

    for (const then of [["disconnect"], ["connect", "--replace"]]) {
      it(`a run killed during a poll, then ${then.join(" ")}: session_unknown kept`, async () => {
        const home = fresh()
        await r(home, ["connect", "--url", server.origin])
        server.approve()
        const held = server.hold("token")
        const a = r(home, ["connect", "--wait", "--url", server.origin])
        await held.reached
        await kill(a)
        held.open()
        const x = await r(home, then)
        assert.equal(x.code, 0, x.all)
        assert.deepEqual(leftReasons(x.json), ["session_unknown"])
      })
    }

    // --- Writes whose answer was lost ---

    it("a POST whose write lands after the timeout: outcome_unknown, and nothing is sent again", async () => {
      const home = fresh()
      await connected(home)
      server.apiDelayMs = 1500
      const id = uuid()
      const p = await r(home, ["post", `items/${id}/comments`, "--json", '{"text":"Done."}'], {
        MIKUD_TEST_TIMEOUT_MS: "300",
      })
      assert.equal(p.json?.error, "outcome_unknown", p.all)
      assert.equal(p.code, 1)
      server.apiDelayMs = 0
      // A read right after shows nothing; the write lands later.
      assert.equal((await r(home, ["get", `items/${id}`])).json.data.writes, 0)
      await sleep(1800)
      assert.equal((await r(home, ["get", `items/${id}`])).json.data.writes, 1)
      assert.equal(server.counts.apiWrites, 1)
    })

    it("502, 503, 504 and a cut answer on a write: outcome_unknown, sent once", async () => {
      const home = fresh()
      await connected(home)
      for (const status of [502, 503, 504]) {
        server.apiStatus = status
        const before = server.counts.apiWrites
        const p = await r(home, ["patch", `notes/${uuid()}`, "--json", '{"version":3,"body":"x"}'])
        assert.equal(p.json?.error, "outcome_unknown", p.all)
        assert.equal(p.json.status, status)
        assert.equal(server.counts.apiWrites, before + 1)
      }
      server.lose.api = true
      const before = server.counts.apiWrites
      const cut = await r(home, ["post", "capture", "--json", '{"text":"An idea"}'])
      assert.equal(cut.json?.error, "outcome_unknown", cut.all)
      assert.equal(server.counts.apiWrites, before + 1)
      // A read that fails is only unreachable or its status.
      server.apiStatus = 503
      assert.equal((await r(home, ["get", "items"])).json?.error, "http_503")
    })

    it("passes Mikud's refusal on with its code", async () => {
      const home = fresh()
      await connected(home)
      server.apiError = { status: 409, code: "version_conflict", message: "Someone changed it." }
      const p = await r(home, ["patch", `items/${uuid()}`, "--json", '{"version":1,"status":"done"}'])
      assert.equal(p.json?.error, "http_409", p.all)
      assert.equal(p.json.body.error.code, "version_conflict")
      assert.match(p.json.message, /Someone changed it/)
    })

    it("a key Mikud no longer accepts ends the connection", async () => {
      const home = fresh()
      await connected(home)
      for (const k of server.keys.values()) k.alive = false
      const g = await r(home, ["get", "items"])
      assert.equal(g.json?.error, "connection_ended", g.all)
      assert.match(g.json.message, new RegExp(`mikud connect --url ${server.origin}$`))
      assert.equal((await r(home, ["status"])).json.status, "not_connected")
      assert.equal((await r(home, ["connect", "--url", server.origin])).json?.status, "pending")
    })

    // --- Calls ---

    it("sends only the listed calls, matched as typed", async () => {
      const home = fresh()
      const id = uuid()
      const bad = [
        ["get", "../auth/api-key/list"],
        ["get", "items/../settings"],
        ["get", `items/${id}/../../settings`],
        ["get", "items%2F..%2Fsettings"],
        ["get", "%252e%252e/settings"],
        ["get", "items\\settings"],
        ["get", `items/${id.toUpperCase()}`],
        ["get", "items/123"],
        ["get", `items/${id}/`],
        ["get", "//evil.example/x"],
        ["get", "https://evil.example/api/v1/items"],
        ["get", "items#x"],
        ["get", "items?q=a b"],
        ["get", "items?q=it's"],
        ["get", "items?q=%zz"],
        ["get", "settings"],
        ["get", "audit"],
        ["get", "sync/runs"],
        ["post", "sync/t3"],
        ["post", "sync/security"],
        ["post", "projects"],
        ["post", "items?x=1"],
        ["post", "items/%3F"],
        ["patch", "items"],
        ["post", `items/${id}`],
        ["post", "Items"],
      ]
      for (const [cmd, p] of bad) {
        const x = await r(home, [cmd, p, ...(cmd === "get" ? [] : ["--json", "{}"])])
        assert.equal(x.json?.error, "bad_path", `${cmd} ${p}: ${x.all}`)
      }
      assert.equal(server.requests.length, 0)
      await connected(home)
      const good = [
        [
          "get",
          "items?q=login&status=todo,in_progress&limit=20",
          "/api/v1/items",
          "?q=login&status=todo,in_progress&limit=20",
        ],
        ["get", `/notes?projectId=${id}&cursor=abc%3D%3D`, "/api/v1/notes", `?projectId=${id}&cursor=abc%3D%3D`],
        ["get", `projects`, "/api/v1/projects", ""],
      ]
      for (const [cmd, p, pathname, query] of good) {
        const x = await r(home, [cmd, p])
        assert.equal(x.json?.status, 200, `${p}: ${x.all}`)
        assert.equal(x.json.data.path, pathname)
        assert.equal(x.json.data.query, query)
        assert.equal(x.json.nextCursor, pathname === "/api/v1/notes" ? "page-2" : undefined)
      }
      for (const [cmd, p] of [
        ["post", "threads/start"],
        ["post", "items"],
        ["patch", `items/${id}`],
        ["post", `items/${id}/comments`],
        ["post", "capture"],
        ["post", `items/${id}/threads`],
        ["patch", `projects/${id}`],
        ["post", `projects/${id}/stage-proposals`],
        ["post", "notes"],
        ["patch", `notes/${id}`],
      ]) {
        const x = await r(home, [cmd, p, "--json", '{"a":1}'])
        assert.equal(x.json?.status, 201, `${cmd} ${p}: ${x.all}`)
        assert.deepEqual(x.json.data.body, { a: 1 })
      }
    })

    it("checks the body and the agent label", async () => {
      const home = fresh()
      await connected(home)
      const file = path.join(root, `${impl}-body-${n}.json`)
      fs.writeFileSync(file, JSON.stringify({ text: "From a file, with 'quotes' and \"more\"." }))
      const f = await r(home, ["post", "capture", "--json-file", file, "--as", "codex:review 2"])
      assert.equal(f.json?.status, 201, f.all)
      assert.equal(f.json.data.body.text, "From a file, with 'quotes' and \"more\".")
      assert.equal(f.json.data.agent, "codex:review 2")
      const e = await r(home, ["get", "items"], { MIKUD_AGENT_LABEL: "claude" })
      assert.equal(e.json.data.agent, "claude")
      const none = await r(home, ["get", "items"])
      assert.equal(none.json.data.agent, null)
      for (const label of ["bad/label", "", "x".repeat(61), "tab\there"]) {
        const x = await r(home, ["get", "items", "--as", label])
        assert.equal(x.json?.error, "bad_label", `${label}: ${x.all}`)
      }
      assert.equal((await r(home, ["get", "items"], { MIKUD_AGENT_LABEL: "no/slash" })).json?.error, "bad_label")
      assert.equal((await r(home, ["post", "capture", "--json", "{nope"])).json?.error, "bad_json")
      assert.equal((await r(home, ["post", "capture"])).json?.error, "bad_json")
      assert.equal((await r(home, ["get", "items", "--json", "{}"])).json?.error, "bad_json")
      assert.equal(
        (await r(home, ["post", "capture", "--json-file", path.join(root, "missing.json")])).json?.error,
        "bad_json",
      )
    })

    // --- Where requests go ---

    it("never follows a redirect", async () => {
      const home = fresh()
      server.redirect["/api/auth/device/code"] = `${other.origin}/api/auth/device/code`
      const c = await r(home, ["connect", "--url", server.origin])
      assert.equal(c.json?.error, "unreachable", c.all)
      assert.ok(!c.json.message.includes(other.origin), "the location is left out")
      assert.equal(other.requests.length, 0)
      server.redirect = {}
      await connected(home)
      server.redirect["/api/v1/items"] = `${other.origin}/api/v1/items`
      const g = await r(home, ["get", "items"])
      assert.equal(g.json?.error, "unreachable", g.all)
      assert.equal(other.requests.length, 0)
    })

    it("waits only at the address the attempt began with", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      const w = await r(home, ["connect", "--wait", "--url", other.origin])
      assert.equal(w.json?.error, "not_connected", w.all)
      assert.equal(other.requests.length, 0)
      assert.equal(server.counts.deviceToken, 0)
    })

    it("refuses an approval link on another address", async () => {
      const home = fresh()
      server.linkOrigin = other.origin
      const c = await r(home, ["connect", "--url", server.origin])
      assert.equal(c.json?.error, "unexpected_answer", c.all)
      assert.equal((await r(home, ["status"])).json.pending, undefined)
    })

    it("refuses an address that is not https, or not an address alone", async () => {
      for (const url of [
        "http://example.com",
        "http://192.0.2.10:8090",
        "ftp://example.com",
        "https://example.com/mikud",
        "https://user:pw@example.com",
        "https://example.com/?a=1",
        "not an address",
      ]) {
        const c = await r(fresh(), ["connect", "--url", url])
        assert.equal(c.json?.error, "no_url", `${url}: ${c.all}`)
      }
      const g = await r(fresh(), ["status"])
      assert.equal(g.code, 0)
    })

    // --- Files ---

    it("makes the temporary file private before anything secret is written", async () => {
      const home = fresh()
      const hold = path.join(root, `${impl}-temp-${n}`)
      const p = r(home, ["connect", "--url", server.origin], { MIKUD_TEST_HOLD_TEMP: hold })
      await reached(hold)
      const tmp = fs.readdirSync(home).filter((f) => f.endsWith(".tmp"))
      assert.equal(tmp.length, 1)
      const file = path.join(home, tmp[0])
      assert.equal(fs.statSync(file).size, 0)
      if (win) {
        const acl = execFileSync("icacls", [file], { encoding: "utf8" })
        const entries = acl
          .replace(file, "")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.includes(":("))
        assert.equal(entries.length, 1, acl)
        assert.ok(!entries[0].includes("(I)"), acl)
      } else assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      go(hold)
      assert.equal((await p).json?.status, "pending")
      if (!win) {
        assert.equal(fs.statSync(home).mode & 0o777, 0o700)
        assert.equal(fs.statSync(path.join(home, "pending")).mode & 0o777, 0o600)
      }
    })

    it("refuses a folder or a file that is a link", async (t) => {
      const target = path.join(root, `${impl}-target-${++n}`)
      fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      const home = fresh()
      fs.mkdirSync(path.dirname(home), { recursive: true })
      fs.symlinkSync(target, home, win ? "junction" : "dir")
      const c = await r(home, ["connect", "--url", server.origin])
      assert.equal(c.json?.error, "insecure_credentials", c.all)
      assert.equal(fs.readdirSync(target).length, 0)
      const home2 = fresh()
      await connected(home2)
      const real = path.join(home2, "connection")
      const moved = path.join(root, `${impl}-moved-${n}`)
      fs.renameSync(real, moved)
      try {
        fs.symlinkSync(moved, real, "file")
      } catch (e) {
        if (win && e.code === "EPERM") return t.skip("this Windows user may not create file links")
        throw e
      }
      const s = await r(home2, ["status"])
      assert.equal(s.json?.error, "insecure_credentials", s.all)
    })

    if (!win) {
      it("refuses loose modes and never changes them", async () => {
        const home = fresh()
        fs.mkdirSync(home, { recursive: true, mode: 0o755 })
        fs.chmodSync(home, 0o755)
        const c = await r(home, ["connect", "--url", server.origin])
        assert.equal(c.json?.error, "insecure_credentials", c.all)
        assert.equal(fs.statSync(home).mode & 0o777, 0o755, "not changed silently")
        const home2 = fresh()
        await connected(home2)
        fs.chmodSync(path.join(home2, "connection"), 0o644)
        const s = await r(home2, ["status"])
        assert.equal(s.json?.error, "insecure_credentials", s.all)
        assert.ok(!s.all.includes(server.aliveKeys()[0][0]))
      })

      it("refuses a file owned by another user", {
        skip: process.getuid?.() !== 0 && "needs root to chown",
      }, async () => {
        const home = fresh()
        await connected(home)
        fs.chownSync(path.join(home, "connection"), 4242, 4242)
        const s = await r(home, ["status"])
        assert.equal(s.json?.error, "insecure_credentials", s.all)
      })
    }

    if (win) {
      it("refuses a folder whose access list lets others in", async () => {
        const home = fresh()
        await connected(home)
        execFileSync("icacls", [home, "/grant", "*S-1-1-0:(OI)(CI)R", "/Q"], { stdio: "ignore" })
        const s = await r(home, ["status"])
        assert.equal(s.json?.error, "insecure_credentials", s.all)
        assert.match(s.json.message, /S-1-1-0|WD|access entries/)
      })
    }

    it("never writes in the skill's folder", async () => {
      const before = filesUnder(scripts)
      const home = fresh()
      await connected(home)
      await r(home, ["get", "items"])
      await r(home, ["disconnect"])
      assert.deepEqual(filesUnder(scripts), before)
    })
  })
}

// Two versions on one computer share one connection, one attempt and one lock.
const [first, second] = impls
const together = second ? describe : describe.skip
together(`mikud (${first ?? "one"} and ${second ?? "another"} together)`, () => {
  let server
  before(async () => {
    server = await startFakeServer()
  })
  after(() => server?.close())

  it("finish each other's attempt, with its days and key name", async () => {
    const home = path.join(root, "together", "home")
    const c = await run(first, home, ["connect", "--url", server.origin, "--days", "7"], {
      MIKUD_AGENT_NAME: "first-version",
    })
    assert.equal(c.json?.status, "pending", c.all)
    assert.equal((await run(second, home, ["connect"])).json.code, c.json.code)
    server.approve()
    const w = await run(second, home, ["connect", "--wait", "--url", server.origin])
    assert.equal(w.json?.status, "connected", w.all)
    assert.match(w.json.keyName, /^skill:first-version:[0-9a-f]{8}$/)
    assert.equal(server.aliveKeys()[0][1].expiresIn, 7 * DAY)
    assert.equal((await run(first, home, ["get", "items"])).json?.status, 200)
    const all = await Promise.all(
      Array.from({ length: 4 }, (_, i) => run(i % 2 ? second : first, home, ["connect", "--replace"])),
    )
    for (const x of all) assert.ok(x.json?.status === "pending" || x.json?.error === "busy", x.all)
  })
})

// The launcher picks a version (Node 20+ when there is one) and passes the arguments on as they are.
const shell = win
  ? ["C:\\Program Files\\Git\\bin\\sh.exe", "C:\\Program Files\\Git\\usr\\bin\\sh.exe"].find((f) => fs.existsSync(f))
  : "sh"
const launcher = shell ? describe : describe.skip
launcher("mikud launcher", () => {
  let server
  before(async () => {
    server = await startFakeServer()
  })
  after(() => server?.close())
  const launch = (home, args, env) =>
    new Promise((resolve) => {
      const child = spawn(shell, [path.join(scripts, "mikud"), ...args], { env: baseEnv(home, env) })
      let out = ""
      let err = ""
      child.stdout.on("data", (d) => {
        out += d
      })
      child.stderr.on("data", (d) => {
        err += d
      })
      child.on("close", (code) => {
        let json = null
        try {
          json = JSON.parse(out.trim().split("\n").at(-1))
        } catch {}
        resolve({ code, json, all: `${out}\n${err}` })
      })
    })

  // A node first on PATH that records its call, then runs the real one.
  const recorder = path.join(root, "recorder")
  const recorded = path.join(root, "node-recorded")
  fs.mkdirSync(recorder, { recursive: true })
  const realNode = process.execPath.replace(/\\/g, "/")
  fs.writeFileSync(
    path.join(recorder, "node"),
    `#!/bin/sh\necho "$*" >> "${recorded.replace(/\\/g, "/")}"\nexec "${realNode}" "$@"\n`,
    {
      mode: 0o755,
    },
  )
  const withRecorder = (extra = {}) => ({ PATH: [recorder, process.env.PATH].join(path.delimiter), ...extra })

  it("runs mikud.mjs with Node 20+, and keeps a query with & as it is", async () => {
    const home = path.join(root, "launcher", "home")
    const c = await run("node", home, ["connect", "--url", server.origin])
    assert.equal(c.json?.status, "pending", c.all)
    server.approve()
    assert.equal((await run("node", home, ["connect", "--wait", "--url", server.origin])).json?.status, "connected")
    fs.rmSync(recorded, { force: true })
    const g = await launch(home, ["get", "items?q=a&status=todo"], withRecorder())
    assert.equal(g.json?.status, 200, g.all)
    assert.equal(g.json.data.query, "?q=a&status=todo")
    assert.match(fs.readFileSync(recorded, "utf8"), /mikud\.mjs/)
  })

  it("hands over to mikud.sh with MIKUD_NO_NODE=1, never to node", {
    skip: !present("sh") && "mikud.sh does not exist yet",
  }, async () => {
    fs.rmSync(nodeCalled, { force: true })
    const s = await launch(path.join(root, "launcher-sh", "home"), ["status"], {
      MIKUD_NO_NODE: "1",
      PATH: [standin, process.env.PATH].join(path.delimiter),
    })
    assert.equal(s.json?.status, "not_connected", s.all)
    assert.equal(fs.existsSync(nodeCalled), false)
  })

  it("hands over to mikud.sh when Node is older than 20", {
    skip: !present("sh") && "mikud.sh does not exist yet",
  }, async () => {
    fs.rmSync(nodeCalled, { force: true })
    const s = await launch(path.join(root, "launcher-old", "home"), ["status"], {
      PATH: [standin, process.env.PATH].join(path.delimiter),
    })
    assert.equal(s.json?.status, "not_connected", s.all)
  })
})
