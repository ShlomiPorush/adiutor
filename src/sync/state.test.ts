import { randomBytes } from "node:crypto"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { processCreation } from "./process-info.ts"
import { readProjectList, readStatus, runningSince, saveProjectList, takeRunLock, writeStatus } from "./state.ts"

// The run lock, the status file and the last good project list, in a data folder of their own.

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "adiutor-sync-state-"))
  temps.push(dir)
  return dir
}
const deps = { platform: "linux" as const, env: {}, now: () => Date.now(), sleep: async () => {} }

describe("the run lock", () => {
  it("lets one run hold it; a second answers busy at once with the holder's start time", async () => {
    const dir = folder()
    const first = await takeRunLock(dir, deps)
    expect(first.busy).toBe(false)
    const started = Date.now()
    const second = await takeRunLock(dir, deps)
    expect(Date.now() - started).toBeLessThan(500)
    expect(second).toEqual({ busy: true, startedAt: expect.any(String) })
    expect(runningSince(dir, deps)).toEqual({ startedAt: (second as { startedAt: string }).startedAt })
    if (!first.busy) first.release()
    expect(runningSince(dir, deps)).toBeNull()
    expect((await takeRunLock(dir, deps)).busy).toBe(false)
  })

  it("is taken over from a holder that died, which status does not show as running", async () => {
    const dir = folder()
    const dead = { pid: 2 ** 22 + 4321, host: hostname(), token: randomBytes(16).toString("hex"), startedAt: 1 }
    writeFileSync(join(dir, "run.lock"), JSON.stringify(dead))
    expect(runningSince(dir, deps)).toBeNull()
    const held = await takeRunLock(dir, deps)
    expect(held.busy).toBe(false)
    if (!held.busy) held.release()
    expect(readdirSync(dir)).toEqual([])
  })
})

describe("the status file", () => {
  it("is written in one step and read back; a missing or damaged one reads as empty", async () => {
    const dir = folder()
    expect(readStatus(dir)).toEqual({ v: 1, lastRun: null, lastGoodSyncAt: null })
    const at = "2026-11-16T10:00:00.000Z"
    await writeStatus(dir, { v: 1, lastRun: null, lastGoodSyncAt: at }, deps)
    expect(readStatus(dir).lastGoodSyncAt).toBe(at)
    expect(readdirSync(dir)).toEqual(["status.json"])
    writeFileSync(join(dir, "status.json"), "{")
    expect(readStatus(dir).lastGoodSyncAt).toBeNull()
  })
})

describe("the last good project list", () => {
  it("keeps the projects with their time and environment, and drops unusable records", async () => {
    const dir = folder()
    expect(readProjectList(dir)).toBeUndefined()
    const savedAt = "2026-11-16T10:00:00.000Z"
    await saveProjectList(dir, { savedAt, environmentId: "env-1", projects: [{ id: "p-1", title: "One" }] }, deps)
    expect(readProjectList(dir)).toEqual({
      savedAt,
      environmentId: "env-1",
      projects: [{ id: "p-1", title: "One", repositoryIdentity: undefined }],
    })
    writeFileSync(
      join(dir, "t3-projects.json"),
      JSON.stringify({ savedAt, environmentId: "env-1", projects: [{ id: "a b" }] }),
    )
    expect(readProjectList(dir)?.projects).toEqual([])
  })
})

describe("processCreation", () => {
  it.runIf(process.platform === "linux")("tells a running process by its creation time, and a gone one", async () => {
    const info = {
      platform: "linux" as const,
      runner: async () => ({ code: 1, stdout: "", stderr: "" }),
      systemCommand: async () => undefined,
    }
    const mine = await processCreation(process.pid, info)
    expect(mine).toMatch(/^linux:[0-9]+$/)
    expect(await processCreation(process.pid, info)).toBe(mine)
    expect(await processCreation(2 ** 22 + 9876, info)).toBeNull()
    expect(await processCreation(0, info)).toBeNull()
  })
})
