// The command's contract, run against every version this computer can run (ADIUTOR_IMPLS picks them; a version whose
// file does not exist yet is skipped): the same answers, the same files, and the same care with what a lost answer or
// a stopped run may leave on Adiutor. Every secret comes from fake-server.mjs, new for every run.
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
const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "adiutor", "scripts")
const FILES = { node: "adiutor.mjs", sh: "adiutor.sh", ps: "adiutor.ps1", pwsh: "adiutor.ps1" }
// ps is Windows PowerShell 5.1, pwsh PowerShell 7: the same adiutor.ps1 runs on both.
const requested = (process.env.ADIUTOR_IMPLS ?? (win ? "node,ps,pwsh" : "node,sh")).split(",").filter(Boolean)
for (const impl of requested) if (!FILES[impl]) throw new Error(`unknown implementation ${impl}`)
const present = (impl) => fs.existsSync(path.join(scripts, FILES[impl]))
const impls = requested.filter(present)
const tmpBase = process.env.ADIUTOR_TEST_TMP ?? (win ? "T:\\adiutor\\skill-tests" : os.tmpdir())
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
fs.writeFileSync(path.join(standin, "node"), `#!/bin/sh\necho called >> "$ADIUTOR_TEST_NODE_CALLED"\nexit 1\n`, {
  mode: 0o755,
})
fs.writeFileSync(path.join(standin, "node.cmd"), `@echo called>>"%ADIUTOR_TEST_NODE_CALLED%"\r\n@exit /b 1\r\n`)
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
  if (impl === "node") return [process.execPath, [path.join(scripts, "adiutor.mjs")]]
  if (impl === "sh") return ["sh", [path.join(scripts, "adiutor.sh")]]
  const ps = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "adiutor.ps1")]
  if (impl === "ps") return ["powershell.exe", ps]
  if (impl === "pwsh") return ["pwsh", ps]
  throw new Error(`unknown implementation ${impl}`)
}

/** The environment every run gets: its own folder, no Adiutor settings from the host. */
function baseEnv(home, extra) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith("ADIUTOR_")) delete env[k]
  return { ...env, ADIUTOR_SKILL_HOME: home, ADIUTOR_WAIT_SECONDS: "8", ADIUTOR_TEST_NODE_CALLED: nodeCalled, ...extra }
}

/** Runs one command; resolves with its exit code, its parsed answer and its raw output. `first`: folders first on PATH. */
function run(impl, home, args, env = {}, first = []) {
  const [cmd, base] = command(impl)
  const extra = { ...env }
  if (impl !== "node") {
    extra.ADIUTOR_NO_NODE = "1"
    const dirs = [...first, standin, ...(impl === "sh" && fs.existsSync(curlWrap) ? [curlWrap] : [])]
    extra.PATH = [...dirs, process.env.PATH].join(path.delimiter)
  } else if (first.length) extra.PATH = [...first, process.env.PATH].join(path.delimiter)
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
  describe.skip(`adiutor (${impl}): ${FILES[impl]} does not exist yet`, () => {})

for (const impl of impls) {
  describe(`adiutor (${impl})`, () => {
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
    const r = (home, args, env, first) => run(impl, home, args, env, first)

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
      assert.equal(c.json.next, `adiutor connect --wait --url ${server.origin}`)
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
      for (const req of server.authRequests()) assert.equal(req.userAgent, "adiutor-connect", req.path)
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
      assert.notEqual(server.requests.at(-1).userAgent, "adiutor-connect")
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

    it("names the key after ADIUTOR_AGENT_NAME, cut to 32 characters, and keeps --days", async () => {
      const home = fresh()
      const c = await r(home, ["connect", "--url", server.origin, "--days", "7"], {
        ADIUTOR_AGENT_NAME: "Build box (east) with a long name",
      })
      assert.equal(c.json?.status, "pending", c.all)
      server.approve()
      const w = await r(home, ["connect", "--wait", "--url", server.origin], { ADIUTOR_AGENT_NAME: "ignored" })
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
      const w = await r(home, ["connect", "--wait", "--url", server.origin], { ADIUTOR_WAIT_SECONDS: "3" })
      assert.equal(w.code, 0, w.all)
      assert.equal(w.json.status, "still_waiting")
      assert.equal(w.json.next, `adiutor connect --wait --url ${server.origin}`)
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

    it("disconnect forgets the connection and reports the key left on Adiutor", async () => {
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
      assert.match(w.json.warning, /adiutor connect \(agent approval\)/)
      assert.deepEqual(leftReasons(w.json), ["session_unknown"])
    })

    it("a save that fails: the session is still ended and the key is reported", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.approve()
      const hold = path.join(root, `${impl}-save-${n}`)
      const p = r(home, ["connect", "--wait", "--url", server.origin], { ADIUTOR_TEST_HOLD_KEY: hold })
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

    it("a pending file that cannot be read after the key was made: the key is still recorded and reported", async () => {
      for (const leftBlocked of [false, true]) {
        server.reset()
        const home = fresh()
        await r(home, ["connect", "--url", server.origin])
        server.approve()
        const hold = path.join(root, `${impl}-damaged-${n}`)
        const p = r(home, ["connect", "--wait", "--url", server.origin], { ADIUTOR_TEST_HOLD_KEY: hold })
        await reached(hold)
        fs.writeFileSync(path.join(home, "pending"), "{damaged")
        // The left record cannot be written either: then the answer itself names the key.
        if (leftBlocked) fs.mkdirSync(path.join(home, "left"))
        go(hold)
        const w = await p
        assert.equal(w.json?.error, "insecure_credentials", w.all)
        assert.match(w.json.message, /pending is damaged/, "the first failure is the answer")
        assert.equal(server.aliveSessions(), 0, "the session was ended")
        const [[, key]] = server.aliveKeys()
        if (leftBlocked) {
          assert.ok(w.json.message.includes(key.name) && w.json.message.includes(key.expiresAt), w.all)
        } else {
          assert.deepEqual(
            w.json.left.map((e) => [e.reason, e.origin, e.keyName, e.expiresAt]),
            [["not_saved", server.origin, key.name, key.expiresAt]],
          )
        }
        noSecrets(server, w)
      }
    })

    it("a create Adiutor refused: no key_unknown, and the session ended", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.approve()
      server.keyError = { status: 400, code: "INVALID_NAME_LENGTH" }
      const w = await r(home, ["connect", "--wait", "--url", server.origin])
      assert.equal(w.json?.error, "http_400", w.all)
      assert.equal(server.keys.size, 0)
      assert.equal(server.aliveSessions(), 0)
      assert.deepEqual(w.json.left ?? [], [])
      const s = await r(home, ["status"])
      assert.equal(s.json.pending, undefined, s.all)
      assert.deepEqual(s.json.left, [])
    })

    it("a create that never left: no key_unknown, only the session that could not be ended", async () => {
      const lone = await startFakeServer()
      try {
        const home = fresh()
        await r(home, ["connect", "--url", lone.origin])
        lone.approve()
        const hold = path.join(root, `${impl}-unsent-${n}`)
        const p = r(home, ["connect", "--wait", "--url", lone.origin], { ADIUTOR_TEST_HOLD_TOKEN: hold })
        await reached(hold)
        // Adiutor stops listening: the create and the revoke never reach it.
        await lone.close()
        go(hold)
        const w = await p
        assert.equal(w.json?.error, "unreachable", w.all)
        assert.equal(lone.counts.keyCreate, 0)
        assert.deepEqual(leftReasons(w.json), ["session_unknown"], w.all)
      } finally {
        await lone.close()
      }
    })

    it("an interim 103 answer before the real one: connects normally", async () => {
      const home = fresh()
      server.earlyHints = true
      const w = await connected(home)
      assert.equal(w.json.warning, undefined, w.all)
      assert.deepEqual(w.json.left, [])
      assert.equal(server.aliveKeys().length, 1)
      assert.equal(server.aliveSessions(), 0)
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
      const holder = r(home, ["connect", "--url", server.origin], { ADIUTOR_TEST_HOLD_LOCKED: hold })
      await reached(hold)
      const busy = await r(home, ["connect", "--url", server.origin], { ADIUTOR_TEST_LOCK_WAIT_MS: "1500" })
      assert.equal(busy.json?.error, "busy", busy.all)
      assert.equal(server.counts.deviceCode, 0)
      go(hold)
      assert.equal((await holder).json?.status, "pending")
    })

    it("breaks the lock of a holder that died", async () => {
      const home = fresh()
      const hold = path.join(root, `${impl}-dead-${n}`)
      const holder = r(home, ["connect", "--url", server.origin], { ADIUTOR_TEST_HOLD_LOCKED: hold })
      await reached(hold)
      await kill(holder)
      const next = await r(home, ["connect", "--url", server.origin])
      assert.equal(next.json?.status, "pending", next.all)
    })

    it("breaks a lock whose process id now belongs to another process", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      const lock = path.join(home, "lock")
      // This test's own process is alive, but it started at another time than the lock says.
      const owner = { token: "reused", host: host(), pid: process.pid, start: "not-its-start-time" }
      fs.writeFileSync(lock, `${JSON.stringify(owner)}\n`)
      const s = await r(home, ["connect"])
      assert.equal(s.json?.status, "pending", s.all)
      assert.equal(fs.existsSync(lock), false)
    })

    it("never breaks a lock it cannot decide about, and names the file to remove by hand", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      const lock = path.join(home, "lock")
      const owner = { token: "elsewhere", host: "another-host.invalid", pid: 1, start: "1" }
      fs.writeFileSync(lock, `${JSON.stringify(owner)}\n`)
      const a = await r(home, ["connect"], { ADIUTOR_TEST_LOCK_WAIT_MS: "1000" })
      assert.equal(a.json?.error, "busy", a.all)
      assert.ok(a.json.message.includes(lock), a.json.message)
      assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).token, "elsewhere")
      // A lock that names no holder (its holder stopped before writing it) is undecidable too.
      fs.writeFileSync(lock, "")
      const b = await r(home, ["connect"], { ADIUTOR_TEST_LOCK_WAIT_MS: "1000" })
      assert.equal(b.json?.error, "busy", b.all)
      assert.equal(fs.existsSync(lock), true)
      fs.rmSync(lock)
      assert.equal((await r(home, ["connect"])).json?.status, "pending")
    })

    it("releases the lock by its token only, and changes nothing once the lock is not its own", async () => {
      const home = fresh()
      const hold = path.join(root, `${impl}-token-${n}`)
      const holder = r(home, ["connect", "--url", server.origin], { ADIUTOR_TEST_HOLD_LOCKED: hold })
      await reached(hold)
      // As if another command had wrongly broken it and taken a lock of its own.
      const lock = path.join(home, "lock")
      const theirs = { token: "theirs", host: host(), pid: process.pid, start: "x" }
      fs.writeFileSync(lock, `${JSON.stringify(theirs)}\n`)
      go(hold)
      const x = await holder
      assert.equal(x.json?.error, "busy", x.all)
      assert.equal(server.counts.deviceCode, 0, "nothing was sent")
      assert.equal(fs.existsSync(path.join(home, "pending")), false)
      assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).token, "theirs")
      fs.rmSync(lock)
    })

    it("of two that saw the same dead lock, the second never removes the fresh lock the first took", async () => {
      const home = fresh()
      const lock = path.join(home, "lock")
      const h = (name) => path.join(root, `${impl}-race-${name}-${n}`)
      // A holder that died: its lock stays behind.
      const dead = r(home, ["connect", "--url", server.origin], { ADIUTOR_TEST_HOLD_LOCKED: h("dead") })
      await reached(h("dead"))
      await kill(dead)
      // B and C both see that dead lock. (BREAK_MOVED: the same point in the break of 1de3555, which moved the lock
      // aside; this test shows that break's failure.)
      const b = r(home, ["connect", "--url", server.origin], {
        ADIUTOR_TEST_HOLD_BREAK_OBSERVED: h("b-seen"),
        ADIUTOR_TEST_HOLD_TEMP: h("b-temp"),
      })
      const c = r(home, ["connect", "--url", server.origin], {
        ADIUTOR_TEST_HOLD_BREAK_OBSERVED: h("c-seen"),
        ADIUTOR_TEST_HOLD_BREAK_HELD: h("c-held"),
        ADIUTOR_TEST_HOLD_BREAK_MOVED: h("c-held"),
      })
      await Promise.all([reached(h("b-seen")), reached(h("c-seen"))])
      // B breaks it, takes a fresh lock, asks for a code and stops right before it saves the attempt.
      go(h("b-seen"))
      await reached(h("b-temp"))
      const freshLock = fs.readFileSync(lock, "utf8")
      // C now breaks what it saw, and stops there; D comes meanwhile and must find the lock taken.
      go(h("c-seen"))
      await reached(h("c-held"))
      const d = r(home, ["connect", "--url", server.origin], { ADIUTOR_TEST_HOLD_LOCKED: h("d-locked") })
      const dLocked = `${h("d-locked")}.reached`
      for (let i = 0; i < 60 && !fs.existsSync(dLocked); i++) await sleep(50)
      assert.equal(fs.existsSync(dLocked), false, "D took the lock while B held it")
      go(h("c-held"))
      await sleep(1000)
      assert.equal(fs.existsSync(dLocked), false, "D took the lock while B held it")
      assert.equal(fs.readFileSync(lock, "utf8"), freshLock, "B's fresh lock was removed")
      go(h("b-temp"))
      const bx = await b
      assert.equal(bx.json?.status, "pending", bx.all)
      await reached(h("d-locked"))
      go(h("d-locked"))
      const [cx, dx] = await Promise.all([c, d])
      // Nothing was written from a stale look: one code, the one B saved, and no lock or lock.break left.
      assert.equal(cx.json?.code, bx.json.code, cx.all)
      assert.equal(dx.json?.code, bx.json.code, dx.all)
      assert.equal(server.counts.deviceCode, 1)
      assert.deepEqual(
        filesUnder(home).map(([f]) => f),
        ["pending"],
      )
    })

    it("a lock.break left behind: busy names it after the wait, and no command removes it", async () => {
      const home = fresh()
      const lock = path.join(home, "lock")
      const breaker = path.join(home, "lock.break")
      const hold = path.join(root, `${impl}-breaker-${n}`)
      const dead = r(home, ["connect", "--url", server.origin], { ADIUTOR_TEST_HOLD_LOCKED: hold })
      await reached(hold)
      await kill(dead)
      // A command that stopped while it broke that lock.
      fs.copyFileSync(lock, breaker)
      const deadLock = fs.readFileSync(lock, "utf8")
      const a = await r(home, ["connect", "--url", server.origin], { ADIUTOR_TEST_LOCK_WAIT_MS: "1000" })
      assert.equal(a.json?.error, "busy", a.all)
      assert.ok(a.json.message.includes(breaker), a.json.message)
      assert.equal(server.counts.deviceCode, 0)
      assert.equal(fs.readFileSync(breaker, "utf8"), deadLock)
      assert.equal(fs.readFileSync(lock, "utf8"), deadLock)
      // Removed by hand: the dead lock is broken again.
      fs.rmSync(breaker)
      const b = await r(home, ["connect", "--url", server.origin])
      assert.equal(b.json?.status, "pending", b.all)
      assert.deepEqual(
        filesUnder(home).map(([f]) => f),
        ["pending"],
      )
    })

    it("a dead lock that cannot be removed: busy within the wait, naming it", {
      skip: !win && process.getuid?.() === 0 && "root removes files in a read-only folder",
    }, async () => {
      const home = fresh()
      const lock = path.join(home, "lock")
      const h = (name) => path.join(root, `${impl}-stuck-${name}-${n}`)
      const dead = r(home, ["connect", "--url", server.origin], { ADIUTOR_TEST_HOLD_LOCKED: h("dead") })
      await reached(h("dead"))
      await kill(dead)
      let p
      let holder
      if (win) {
        // Another program (a backup, an antivirus) holds the dead lock open without delete sharing.
        const script = `$f = [IO.File]::Open('${lock}', 'Open', 'Read', 'Read'); [IO.File]::WriteAllText('${h("open")}.reached', 'x'); while (-not [IO.File]::Exists('${h("open")}.go')) { Start-Sleep -Milliseconds 50 }; $f.Dispose()`
        holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore" })
        await reached(h("open"))
        p = r(home, ["connect", "--url", server.origin], { ADIUTOR_TEST_LOCK_WAIT_MS: "1500" })
      } else {
        // The folder made read-only once the command checked it: the dead lock can be neither removed nor broken.
        p = r(home, ["connect", "--url", server.origin], {
          ADIUTOR_TEST_LOCK_WAIT_MS: "1500",
          ADIUTOR_TEST_HOLD_BREAK_OBSERVED: h("seen"),
        })
        await reached(h("seen"))
        fs.chmodSync(home, 0o500)
        go(h("seen"))
      }
      const started = Date.now()
      const a = await Promise.race([p, sleep(30_000).then(() => null)])
      if (win) {
        go(h("open"))
        await new Promise((resolve) => (holder.exitCode === null ? holder.on("close", resolve) : resolve()))
      } else fs.chmodSync(home, 0o700)
      if (!a) {
        await kill(p)
        assert.fail("the command kept trying to remove the lock past its wait")
      }
      assert.ok(Date.now() - started < 20_000, "busy came long after the wait")
      assert.equal(a.json?.error, "busy", a.all)
      assert.ok(a.json.message.includes(lock), a.json.message)
      assert.equal(server.counts.deviceCode, 0)
      assert.equal(fs.existsSync(lock), true)
      assert.equal(fs.existsSync(path.join(home, "lock.break")), false)
    })

    it("a run whose lock was lost saves nothing, still ends the session, and names the key it made", async () => {
      const home = fresh()
      await r(home, ["connect", "--url", server.origin])
      server.approve()
      const hold = path.join(root, `${impl}-broken-${n}`)
      const a = r(home, ["connect", "--wait", "--url", server.origin], { ADIUTOR_TEST_HOLD_KEY: hold })
      await reached(hold)
      // The lock removed by hand, and another command replaces the attempt meanwhile.
      fs.rmSync(path.join(home, "lock"))
      const b = await r(home, ["connect", "--replace"])
      assert.equal(b.json?.status, "pending", b.all)
      go(hold)
      const w = await a
      assert.equal(w.json?.error, "cannot_save", w.all)
      const [[, key]] = server.aliveKeys()
      assert.ok(w.json.message.includes(key.name) && w.json.message.includes(key.expiresAt), w.all)
      assert.equal(server.aliveSessions(), 0, "the session was still ended")
      const s = await r(home, ["status"])
      assert.equal(s.json.status, "not_connected")
      assert.equal(s.json.pending.code, b.json.code)
      // The command that took over found the attempt half done and recorded what it may have left.
      assert.deepEqual(leftReasons(s.json), ["key_unknown", "session_unknown"], s.all)
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
      const a = r(home, ["connect", "--wait", "--url", server.origin], { ADIUTOR_TEST_HOLD_TOKEN: hold })
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
      const a = r(home, ["connect", "--wait", "--url", server.origin], { ADIUTOR_TEST_HOLD_DONE: hold })
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
      const a = r(home, ["connect", "--wait", "--url", server.origin], { ADIUTOR_TEST_HOLD_DONE: hold })
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
      const a = r(home, ["connect", "--wait", "--url", server.origin], { ADIUTOR_TEST_HOLD_REVOKED: hold })
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
      const later = { ADIUTOR_TEST_CLOCK_OFFSET: String(100 * DAY) }
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
      const s = await r(home, ["status"], { ADIUTOR_TEST_CLOCK_OFFSET: String(2 * DAY) })
      assert.deepEqual(s.json.left, [], s.all)
    })

    it("replacing a connection to another Adiutor keeps the old address in the entry", async () => {
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

    it("a disconnect stopped between its record and the change: the live key is never reported as left", async () => {
      const home = fresh()
      const w = await connected(home)
      const hold = path.join(root, `${impl}-recorded-${n}`)
      const d = r(home, ["disconnect"], { ADIUTOR_TEST_HOLD_RECORDED: hold })
      await reached(hold)
      await kill(d)
      const s = await r(home, ["status"])
      assert.equal(s.json.status, "connected", s.all)
      assert.equal(s.json.keyName, w.json.keyName)
      assert.deepEqual(s.json.left, [])
      // Removed from the record too, under the lock.
      const left = path.join(home, "left")
      assert.ok(!fs.existsSync(left) || !fs.readFileSync(left, "utf8").includes(w.json.keyName))
      const again = await r(home, ["disconnect"])
      assert.deepEqual(leftReasons(again.json), ["disconnected"], again.all)
    })

    it("a replace stopped between its record and the change: the live key is never reported as left", async () => {
      const home = fresh()
      const first = await connected(home)
      await r(home, ["connect", "--replace"])
      server.approve()
      const hold = path.join(root, `${impl}-replace-recorded-${n}`)
      const a = r(home, ["connect", "--wait", "--url", server.origin], { ADIUTOR_TEST_HOLD_RECORDED: hold })
      await reached(hold)
      await kill(a)
      const s = await r(home, ["status"])
      assert.equal(s.json.keyName, first.json.keyName, s.all)
      assert.deepEqual(s.json.left, [])
      assert.deepEqual(s.json.pending.warnings, ["key_unknown", "session_unknown"])
    })

    it("a run stopped after writing a temporary file: the next holder of the lock removes it", async () => {
      const home = fresh()
      const hold = path.join(root, `${impl}-written-${n}`)
      const a = r(home, ["connect", "--url", server.origin], { ADIUTOR_TEST_HOLD_WRITTEN: hold })
      await reached(hold)
      await kill(a)
      const [first] = server.secrets().deviceCodes
      const tmp = fs.readdirSync(home).filter((f) => f.endsWith(".tmp"))
      assert.equal(tmp.length, 1)
      assert.ok(fs.readFileSync(path.join(home, tmp[0]), "utf8").includes(first), "the scenario: a secret left behind")
      const c = await r(home, ["connect", "--url", server.origin])
      assert.equal(c.json?.status, "pending", c.all)
      assert.deepEqual(
        filesUnder(home).map(([f]) => f),
        ["pending"],
      )
      assert.ok(!fs.readFileSync(path.join(home, "pending"), "utf8").includes(first))
    })

    // --- Writes whose answer was lost ---

    it("a POST whose write lands after the timeout: outcome_unknown, and nothing is sent again", async () => {
      const home = fresh()
      await connected(home)
      server.apiDelayMs = 1500
      const id = uuid()
      const p = await r(home, ["post", `items/${id}/comments`, "--json", '{"text":"Done."}'], {
        ADIUTOR_TEST_TIMEOUT_MS: "300",
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

    it("passes Adiutor's refusal on with its code", async () => {
      const home = fresh()
      await connected(home)
      server.apiError = { status: 409, code: "version_conflict", message: "Someone changed it." }
      const p = await r(home, ["patch", `items/${uuid()}`, "--json", '{"version":1,"status":"done"}'])
      assert.equal(p.json?.error, "http_409", p.all)
      assert.equal(p.json.body.error.code, "version_conflict")
      assert.match(p.json.message, /Someone changed it/)
    })

    it("a key Adiutor no longer accepts ends the connection", async () => {
      const home = fresh()
      await connected(home)
      for (const k of server.keys.values()) k.alive = false
      const g = await r(home, ["get", "items"])
      assert.equal(g.json?.error, "connection_ended", g.all)
      assert.match(g.json.message, new RegExp(`adiutor connect --url ${server.origin}$`))
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
      const e = await r(home, ["get", "items"], { ADIUTOR_AGENT_LABEL: "claude" })
      assert.equal(e.json.data.agent, "claude")
      const none = await r(home, ["get", "items"])
      assert.equal(none.json.data.agent, null)
      for (const label of ["bad/label", "", "x".repeat(61), "tab\there"]) {
        const x = await r(home, ["get", "items", "--as", label])
        assert.equal(x.json?.error, "bad_label", `${label}: ${x.all}`)
      }
      assert.equal((await r(home, ["get", "items"], { ADIUTOR_AGENT_LABEL: "no/slash" })).json?.error, "bad_label")
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
        "https://example.com/adiutor",
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
      const p = r(home, ["connect", "--url", server.origin], { ADIUTOR_TEST_HOLD_TEMP: hold })
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

    it("never hands a secret to another program's environment, even under names the caller exported", async () => {
      // Names the versions use for a secret; an exported one would keep its export when assigned.
      const names = [
        "TOKEN",
        "BODY",
        "QQ",
        "qq_s",
        "JF",
        "JV",
        "jg_line",
        "jg_rest",
        "rc_k",
        "rp_d",
        "RP_TEXT",
        "rr_row",
        "rv_rest",
        "rv_v",
        "sz_v",
        "SER",
        "cl_dc",
        "cs_key",
        "ca_set",
        "rq_out",
        "C_key",
        "K_key",
        "V_key",
        "W_key",
        "LN_key",
        "P_deviceCode",
        "R_deviceCode",
        "SN_deviceCode",
        "token",
        "sessionToken",
      ]
      const exported = Object.fromEntries(names.map((k) => [k, ""]))
      // The sh version's programs, wrapped to record their environment.
      const rec = path.join(root, `${impl}-env-${n}`)
      const wrap = path.join(root, `${impl}-envwrap-${n}`)
      const wrapped = []
      if (!win) {
        fs.mkdirSync(wrap)
        for (const prog of ["curl", "awk", "cat", "od"]) {
          let real = ""
          try {
            real = execFileSync("sh", ["-c", `command -v ${prog}`], { encoding: "utf8" }).trim()
          } catch {}
          if (!real) continue
          fs.writeFileSync(path.join(wrap, prog), `#!/bin/sh\nenv >> "${rec}"\nexec "${real}" "$@"\n`, { mode: 0o755 })
          wrapped.push(prog)
        }
      }
      const home = fresh()
      const run2 = (args) => r(home, args, exported, wrapped.length ? [wrap] : [])
      const c = await run2(["connect", "--url", server.origin])
      assert.equal(c.json?.status, "pending", c.all)
      server.approve()
      const w = await run2(["connect", "--wait", "--url", server.origin])
      assert.equal(w.json?.status, "connected", w.all)
      const g = await run2(["get", "items"])
      assert.equal(g.json?.status, 200, g.all)
      noSecrets(server, c, w, g)
      if (impl === "sh" && wrapped.includes("curl")) {
        const envs = fs.readFileSync(rec, "utf8")
        assert.ok(envs.includes("PATH="), "the wrappers recorded the environment")
        const { deviceCodes, sessions, keys } = server.secrets()
        for (const secret of [...deviceCodes, ...sessions, ...keys])
          assert.ok(!envs.includes(secret), "a secret in a child's environment")
      }
    })

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

// The sh version unsets every name it assigns before anything else runs: a name the caller exported keeps its export
// when assigned, and would hand its value (a key, a device code) to curl, awk and every other program the script
// starts. Read from the script itself, so a name added later cannot be forgotten.
describe("adiutor.sh unsets every name it assigns", () => {
  const file = path.join(scripts, "adiutor.sh")
  // Assigned and never unset, each only as a prefix of one command, with a constant value.
  const SAFE = new Map([
    ["IFS", /^\s*IFS= read /],
    ["LC_ALL", /^\s*LC_ALL=C awk /],
  ])

  it("every plain, read, for and eval assignment, and every secret field of a prefix", {
    skip: !fs.existsSync(file),
  }, () => {
    const text = fs.readFileSync(file, "utf8")
    const end = text.indexOf("\nunset _p\n") + "\nunset _p\n".length
    assert.ok(end > 20, "the start-up unset ends with: unset _p")
    const head = text.slice(0, end)
    const unset = new Set()
    for (const m of head.matchAll(/^unset ([^\n]+)$/gm)) for (const w of m[1].split(" ")) unset.add(w)
    for (const m of head.matchAll(/^for _p in ([^;\n]+); do unset ((?:"\$\{_p\}\w+" ?)+); done$/gm))
      for (const prefix of m[1].trim().split(" "))
        for (const s of m[2].matchAll(/\$\{_p\}(\w+)/g)) unset.add(prefix + s[1])

    // The code: no awk program (a multi-line single-quoted value), no comment.
    const lines = text
      .replace(/^[A-Za-z_]\w*='\n[\s\S]*?\n\}'$/gm, "")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .map((l) => l.replace(/\s#\s.*$/, "").replace(/\s-[ov] \w+=/g, " "))
    const assigned = new Set()
    const prefixes = new Set()
    const slots = new Set()
    for (const l of lines) {
      for (const m of l.matchAll(/(?:^|[\s;&|()!{`"])([A-Za-z_]\w*)=/g)) assigned.add(m[1])
      for (const m of l.matchAll(/\bread\s+(?:-\w+\s+)*((?:[A-Za-z_]\w*\s*)+)/g))
        for (const name of m[1].trim().split(/\s+/)) assigned.add(name)
      for (const m of l.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\b/g)) assigned.add(m[1])
      // Record prefixes (read_record, rec_copy and the like assign <PREFIX><field> through eval) and failure slots.
      for (const m of l.matchAll(/(?<=\s)([A-Z]{1,3}_)(?=[\s;)]|$)/g)) prefixes.add(m[1])
      for (const m of l.matchAll(/\berr_(?:save|restore) (\w+)/g)) slots.add(m[1])
    }
    // The reader sees assignments inside eval and plain ones alike.
    for (const name of ["rc_k", "rp_d", "TOKEN", "BODY", "aq_owner"]) assert.ok(assigned.has(name), name)
    assert.ok(prefixes.has("C_") && prefixes.has("P_") && slots.size > 0)

    const missing = [...assigned].filter((name) => !unset.has(name) && !SAFE.has(name)).sort()
    assert.deepEqual(missing, [], "assigned in adiutor.sh but not unset at start-up")
    for (const p of prefixes)
      for (const field of ["key", "deviceCode"])
        assert.ok(unset.has(p + field), `${p + field} is not unset at start-up`)
    for (const s of slots)
      for (const part of ["code", "msg", "status", "body", "sent"])
        assert.ok(unset.has(`${s}_${part}`), `${s}_${part} is not unset at start-up`)
    for (const [name, use] of SAFE)
      for (const l of lines.filter((x) => x.includes(`${name}=`)))
        assert.match(l, use, `${name} is assigned other than as the safe prefix`)
  })
})

// Two versions on one computer share one connection, one attempt and one lock: every ordered pair of them.
const pairs = impls.flatMap((a) => impls.filter((b) => b !== a).map((b) => [a, b]))
if (!pairs.length) describe.skip("adiutor (two versions together): only one version runs here", () => {})
for (const [first, second] of pairs) {
  describe(`adiutor (${first} and ${second} together)`, () => {
    let server
    before(async () => {
      server = await startFakeServer()
    })
    after(() => server?.close())

    it("finish each other's attempt, with its days and key name", async () => {
      const home = path.join(root, `together-${first}-${second}`, "home")
      const c = await run(first, home, ["connect", "--url", server.origin, "--days", "7"], {
        ADIUTOR_AGENT_NAME: "first-version",
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
}

// The launcher picks a version (Node 20+ when there is one) and passes the arguments on as they are.
const shell = win
  ? ["C:\\Program Files\\Git\\bin\\sh.exe", "C:\\Program Files\\Git\\usr\\bin\\sh.exe"].find((f) => fs.existsSync(f))
  : "sh"
const launcher = shell ? describe : describe.skip
launcher("adiutor launcher", () => {
  let server
  before(async () => {
    server = await startFakeServer()
  })
  after(() => server?.close())
  const launch = (home, args, env) =>
    new Promise((resolve) => {
      const child = spawn(shell, [path.join(scripts, "adiutor"), ...args], { env: baseEnv(home, env) })
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

  it("runs adiutor.mjs with Node 20+, and keeps a query with & as it is", async () => {
    const home = path.join(root, "launcher", "home")
    const c = await run("node", home, ["connect", "--url", server.origin])
    assert.equal(c.json?.status, "pending", c.all)
    server.approve()
    assert.equal((await run("node", home, ["connect", "--wait", "--url", server.origin])).json?.status, "connected")
    fs.rmSync(recorded, { force: true })
    const g = await launch(home, ["get", "items?q=a&status=todo"], withRecorder())
    assert.equal(g.json?.status, 200, g.all)
    assert.equal(g.json.data.query, "?q=a&status=todo")
    assert.match(fs.readFileSync(recorded, "utf8"), /adiutor\.mjs/)
  })

  it("hands over to adiutor.sh with ADIUTOR_NO_NODE=1, never to node", {
    skip: !present("sh") && "adiutor.sh does not exist yet",
  }, async () => {
    fs.rmSync(nodeCalled, { force: true })
    const s = await launch(path.join(root, "launcher-sh", "home"), ["status"], {
      ADIUTOR_NO_NODE: "1",
      PATH: [standin, process.env.PATH].join(path.delimiter),
    })
    assert.equal(s.json?.status, "not_connected", s.all)
    assert.equal(fs.existsSync(nodeCalled), false)
  })

  it("hands over to adiutor.sh when Node is older than 20", {
    skip: !present("sh") && "adiutor.sh does not exist yet",
  }, async () => {
    fs.rmSync(nodeCalled, { force: true })
    const s = await launch(path.join(root, "launcher-old", "home"), ["status"], {
      PATH: [standin, process.env.PATH].join(path.delimiter),
    })
    assert.equal(s.json?.status, "not_connected", s.all)
  })
})
