import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { afterAll, describe, expect, it } from "vitest"
import { fileLock, type Holder, takeoverGuard } from "./lock.ts"

// The lock file every sync command shares (the run lock, the connection's refresh lock, the T3 lock): one holder at a
// time, also when several takers find a dead holder at once. Real processes race here, since the steps of a takeover
// run without a pause inside one process.

const dir = mkdtempSync(join(tmpdir(), "adiutor-sync-lock-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A process id no process has: above the largest one Linux and Windows hand out. */
const DEAD_PID = 2 ** 22 + 1234
const deadLock = () =>
  JSON.stringify({ pid: DEAD_PID, host: hostname(), token: randomBytes(16).toString("hex"), startedAt: 1 })

const options = { waitMs: 0, busy: () => new Error("busy"), cannotCreate: () => new Error("cannot create") }
const deps = { platform: process.platform, env: process.env, now: () => Date.now(), sleep: async () => {} }

describe("the lock", () => {
  it("is taken over from a dead holder, and never from a live one", async () => {
    const work = mkdtempSync(join(dir, "one-"))
    const file = join(work, "run.lock")
    writeFileSync(file, deadLock())
    const lock = fileLock(file, deps)
    const token = await lock.acquire(options)
    expect(lock.mine(token)).toBe(true)
    await expect(fileLock(file, deps).acquire(options)).rejects.toThrow("busy")
    lock.release(token)
    expect(lock.holder()).toBeNull()
  })

  it("lets a taker that saw the dead holder late leave the new holder's lock alone", async () => {
    const work = mkdtempSync(join(dir, "late-"))
    const file = join(work, "run.lock")
    writeFileSync(file, deadLock())
    let newHolder: Holder | null = null
    // Between this taker's read of the dead holder and its takeover, another taker took over and runs.
    const late = fileLock(file, {
      ...deps,
      beforeBreak: async () => {
        const other = fileLock(file, deps)
        rmSync(file)
        await other.acquire(options)
        newHolder = other.holder()
      },
    })
    await expect(late.acquire(options)).rejects.toThrow("busy")
    expect(fileLock(file, deps).holder()).toEqual(newHolder)
  })

  it("gives two spellings of the same lock file the same guard, so only one taker removes the dead lock", async () => {
    // Two spellings of one folder, as Windows allows by case, separators or a short name: here a link to the folder.
    const work = mkdtempSync(join(dir, "spellings-"))
    const real = join(work, "data")
    mkdirSync(real)
    const alias = join(work, "alias")
    symlinkSync(real, alias, "junction")
    writeFileSync(join(real, "run.lock"), deadLock())
    const b = fileLock(join(alias, "run.lock"), deps)
    let bResult: string | Error | undefined
    // A checked the dead lock under its guard; before it removes the lock, B tries through the other spelling.
    const a = fileLock(join(real, "run.lock"), {
      ...deps,
      beforeRemove: async () => {
        bResult = await b.acquire(options).catch((error: Error) => error)
      },
    })
    const aResult = await a.acquire(options).catch((error: Error) => error)
    const holders = [aResult, bResult].filter((r) => typeof r === "string")
    expect(holders).toHaveLength(1)
    expect(a.holder()?.token).toBe(holders[0])
  })

  it("recovers from a chain of guards that takers left when they died one after another", async () => {
    const work = mkdtempSync(join(dir, "chain-"))
    const file = join(work, "run.lock")
    const deadHolder = (): Holder => ({
      pid: DEAD_PID,
      host: hostname(),
      token: randomBytes(16).toString("hex"),
      startedAt: 1,
    })
    // A dead holder's lock, its takeover guard of a taker that died, that guard's guard of another, and so on.
    let below = file
    let held = deadHolder()
    writeFileSync(file, JSON.stringify(held))
    for (let level = 0; level < 8; level++) {
      const guard = takeoverGuard(file, below, held)
      held = deadHolder()
      writeFileSync(guard, JSON.stringify(held))
      below = guard
    }
    const lock = fileLock(file, deps)
    const token = await lock.acquire(options)
    expect(lock.mine(token)).toBe(true)
    lock.release(token)
    expect(readdirSync(work)).toEqual([])
  })

  it("keeps one holder at a time while several processes take a dead holder's lock over at once", async () => {
    const work = mkdtempSync(join(dir, "race-"))
    const entry = join(work, "taker.ts")
    const lockPath = fileURLToPath(new URL("./lock.ts", import.meta.url))
    // Each taker holds the lock for a moment, checks that nobody else holds it (an exclusive marker file), then dies
    // as a holder: it leaves a dead holder's lock behind, which the next taker must take over.
    writeFileSync(
      entry,
      `import { appendFileSync, closeSync, openSync, rmSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { hostname } from "node:os"
import { join } from "node:path"
import { fileLock } from ${JSON.stringify(lockPath)}
const [work, deadPid, until] = process.argv.slice(2)
const file = join(work, "run.lock")
const marker = join(work, "inside")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const lock = fileLock(file, { platform: process.platform, env: process.env, now: Date.now, sleep })
let held = 0
let overlaps = 0
while (Date.now() < Number(until)) {
  let token
  try {
    token = await lock.acquire({ waitMs: 0, busy: () => new Error("busy"), cannotCreate: () => new Error("create") })
  } catch {
    await sleep(Math.random() * 2)
    continue
  }
  held++
  let inside = false
  try {
    closeSync(openSync(marker, "wx"))
    inside = true
  } catch {
    overlaps++
  }
  await sleep(1)
  if (inside) rmSync(marker, { force: true })
  if (lock.mine(token))
    writeFileSync(file, JSON.stringify({ pid: Number(deadPid), host: hostname(), token: randomBytes(16).toString("hex"), startedAt: 1 }))
}
appendFileSync(join(work, "log"), JSON.stringify({ held, overlaps }) + "\\n")
`,
    )
    const bundle = join(work, "taker.mjs")
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bundle,
      logLevel: "silent",
    })
    writeFileSync(join(work, "run.lock"), deadLock())
    const until = Date.now() + 4_000
    const takers = Array.from(
      { length: 8 },
      () =>
        new Promise<number | null>((resolve) => {
          const child = spawn(process.execPath, [bundle, work, String(DEAD_PID), String(until)], { stdio: "ignore" })
          child.on("exit", resolve)
        }),
    )
    expect(await Promise.all(takers)).toEqual(Array(8).fill(0))
    const results = readFileSync(join(work, "log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { held: number; overlaps: number })
    // Many takeovers happened, and never two holders at once.
    expect(results.reduce((sum, r) => sum + r.held, 0)).toBeGreaterThan(50)
    expect(results.reduce((sum, r) => sum + r.overlaps, 0)).toBe(0)
  }, 60_000)
})
