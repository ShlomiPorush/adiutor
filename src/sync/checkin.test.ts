import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { CLAIM_FILE, parseReport } from "./checkin.ts"
import { type MainDeps, main } from "./cli.ts"
import type { CheckinReport, Result, RunReport } from "./contract.ts"
import type { Runner } from "./exec.ts"
import { type FakeAdiutor, startFakeAdiutor } from "./fake-adiutor.ts"
import { syncClient } from "./oauth.ts"

// The check-in (`checkin --json`) against a stand-in Adiutor (src/sync/fake-adiutor.ts), the sync connected in a home
// folder of its own before each test: the report the tray gives on stdin, the claim kept before the answer, a lost
// answer, a finished request, an older Adiutor, and `run --request`. Every token is new on every run.

let fake: FakeAdiutor
let home: string

beforeAll(async () => {
  fake = await startFakeAdiutor()
})
afterAll(async () => {
  await fake.close()
})
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "adiutor-checkin-"))
  fake.grantScope = "sync"
  await connectSync()
})

/** Connects the sync in this home folder, the owner approving at once; again: connect --replace. */
async function connectSync() {
  const client = syncClient(fake.issuer, {
    fetch: (input: string, init: RequestInit) => fetch(input, init),
    runner: (async () => ({ code: 1, stdout: "", stderr: "" })) as Runner,
    systemCommand: async () => undefined,
    platform: "linux",
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    now: () => Date.now(),
    sleep: async () => {
      fake.approve()
      await new Promise((resolve) => setTimeout(resolve, 1))
    },
  })
  await client.prepare()
  await client.waitForApproval(await client.deviceCode("Test sync"), "Test sync")
}
afterEach(() => {
  Object.assign(fake, {
    checkins: [],
    claim: null,
    afterCheckin: [],
    checkinGates: [],
    offersCheckin: true,
    pushes: [],
  })
  rmSync(home, { recursive: true, force: true })
})

const data = () => join(home, ".config", "adiutor")

const REPORT: CheckinReport = {
  version: "0.3.0",
  paused: false,
  pausedUntil: null,
  nextRunAt: "2026-11-17T06:00:00.000Z",
  running: null,
  finished: [],
}

function deps(stdin: string) {
  const lines: string[] = []
  const value: MainDeps = {
    env: { ADIUTOR_URL: fake.issuer, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    platform: "linux",
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    runner: (async () => ({ code: 1, stdout: "", stderr: "", error: "not here" })) as Runner,
    fetch: (input, init) => fetch(input, init),
    out: (line) => lines.push(line),
    now: () => new Date(),
    nodePath: "/fake/node",
    stdin: async () => stdin,
  }
  return { deps: value, lines }
}

/** Runs a command with --json: every line JSON, exactly one result, last. */
async function json(argv: string[], stdin = "") {
  const { deps: d, lines } = deps(stdin)
  const exit = await main([...argv, "--json"], d)
  const parsed = lines.map((line) => JSON.parse(line) as { type: string })
  expect(parsed.filter((p) => p.type === "result")).toHaveLength(1)
  expect(parsed.at(-1)?.type).toBe("result")
  // No token reaches the output.
  for (const secret of fake.secrets()) expect(lines.join("\n")).not.toContain(secret)
  return { exit, result: parsed.at(-1) as Result & Record<string, unknown> }
}

const checkin = (report: unknown = REPORT) => json(["checkin"], JSON.stringify(report))
/** The claim kept on disk, as the result shows it (the file also names its connection). */
const kept = () => {
  if (!existsSync(join(data(), CLAIM_FILE))) return null
  const { requestId, receivedAt } = JSON.parse(readFileSync(join(data(), CLAIM_FILE), "utf8"))
  return { requestId, receivedAt }
}

describe("checkin --json", () => {
  it("sends the tray's report with the policy headers and answers that nothing waits", async () => {
    const { exit, result } = await checkin()
    expect([exit, result.ok, result.command, result.claim]).toEqual([0, true, "checkin", null])
    expect(fake.checkins).toEqual([REPORT])
    expect(kept()).toBeNull()
  })

  it("keeps a claim before it answers, shows it in status, and keeps it until a check-in reports it finished", async () => {
    const requestId = randomUUID()
    fake.claim = requestId
    const first = await checkin()
    expect(first.result).toMatchObject({ ok: true, claim: { requestId, receivedAt: expect.any(String) } })
    expect(kept()).toEqual(first.result.claim)
    expect((await json(["status"])).result.claim).toEqual(first.result.claim)
    // Running it: the same claim comes back, and the kept one stays as it was.
    const running = await checkin({ ...REPORT, running: { kind: "request", requestId } })
    expect(running.result.claim).toEqual(first.result.claim)
    // Finished, but the answer was lost: still kept, to report again.
    fake.claim = null
    fake.afterCheckin = ["drop"]
    const done = { ...REPORT, finished: [{ requestId, result: { t3: "accepted", security: "partial" } }] }
    const lost = await checkin(done)
    expect([lost.exit, lost.result.ok, (lost.result.error as { code: string }).code]).toEqual([
      1,
      false,
      "outcome_unknown",
    ])
    expect(lost.result.claim).toEqual(first.result.claim)
    expect(kept()).toEqual(first.result.claim)
    // Sent again and answered: cleared.
    const answered = await checkin(done)
    expect([answered.result.ok, answered.result.claim, kept()]).toEqual([true, null, null])
    expect(fake.checkins.at(-1)).toEqual(done)
  })

  it("takes turns with another check-in, so a late answer never writes back a claim reported finished", async () => {
    const requestId = randomUUID()
    fake.claim = requestId
    await checkin()
    // The first check-in's answer (holding the claim) is held back; the second reports the request finished.
    let open = () => {}
    fake.checkinGates.push(
      new Promise<void>((resolve) => {
        open = resolve
      }),
    )
    const first = checkin({ ...REPORT, running: { kind: "request", requestId } })
    await vi.waitFor(() => expect(fake.checkins).toHaveLength(2))
    fake.claim = null
    const done = { ...REPORT, finished: [{ requestId, result: { t3: "accepted", security: "accepted" } }] }
    const second = checkin(done)
    await new Promise((resolve) => setTimeout(resolve, 200))
    open()
    expect((await first).result.ok).toBe(true)
    expect((await second).result).toMatchObject({ ok: true, claim: null })
    expect(kept()).toBeNull()
    expect((await json(["status"])).result.claim).toBeNull()
  })

  it("never runs a claim kept for another connection or address: dropped after connect --replace", async () => {
    fake.claim = randomUUID()
    await checkin()
    expect(kept()).not.toBeNull()
    // Another address's claim is not this connection's.
    const file = join(data(), CLAIM_FILE)
    const stored = JSON.parse(readFileSync(file, "utf8"))
    writeFileSync(
      file,
      JSON.stringify({ ...stored, connection: stored.connection.replace(fake.issuer, "https://other.example.com") }),
    )
    expect((await json(["status"])).result.claim).toBeNull()
    writeFileSync(file, JSON.stringify(stored))
    expect((await json(["status"])).result.claim).not.toBeNull()
    // The sync connects again: the old connection's claim is never shown or run, and the next check-in drops it.
    await connectSync()
    fake.claim = null
    expect((await json(["status"])).result.claim).toBeNull()
    expect((await checkin()).result).toMatchObject({ ok: true, claim: null })
    expect(kept()).toBeNull()
  })

  it("drops an answer that arrives after the sync connected again: its claim is the old connection's", async () => {
    const requestId = randomUUID()
    fake.claim = requestId
    let open = () => {}
    fake.checkinGates.push(
      new Promise<void>((resolve) => {
        open = resolve
      }),
    )
    const pending = checkin()
    await vi.waitFor(() => expect(fake.checkins).toHaveLength(1))
    // connect --replace while the answer, claiming the request for the old connection, is on its way.
    await connectSync()
    open()
    const { exit, result } = await pending
    expect([exit, result.ok, (result.error as { code: string }).code, result.claim]).toEqual([
      1,
      false,
      "connection_changed",
      null,
    ])
    expect(kept()).toBeNull()
    expect((await json(["status"])).result.claim).toBeNull()
  })

  it("keeps the next claim when the answer to a finished report hands one", async () => {
    const [first, next] = [randomUUID(), randomUUID()]
    fake.claim = first
    await checkin()
    fake.claim = next
    const { result } = await checkin({
      ...REPORT,
      finished: [{ requestId: first, result: { t3: "accepted", security: "accepted" } }],
    })
    expect(result.claim).toMatchObject({ requestId: next })
    expect(kept()).toMatchObject({ requestId: next })
  })

  it("says when Adiutor is older and takes no check-in, and sends nothing", async () => {
    fake.offersCheckin = false
    const older = await checkin()
    expect([older.exit, older.result.ok, (older.result.error as { code: string }).code]).toEqual([
      1,
      false,
      "server_older",
    ])
    expect(fake.checkins).toEqual([])
  })

  it("passes on Adiutor's refusal with its code", async () => {
    fake.afterCheckin = [400]
    const { exit, result } = await checkin()
    expect([exit, result.ok, (result.error as { code: string }).code]).toEqual([1, false, "validation_failed"])
  })

  it("refuses a report that is not valid before anything is sent", async () => {
    const { version: _, ...noVersion } = REPORT
    for (const bad of [
      "not json",
      JSON.stringify([REPORT]),
      JSON.stringify(noVersion),
      JSON.stringify({ ...REPORT, version: "1.0 && calc" }),
      JSON.stringify({ ...REPORT, paused: "yes" }),
      // Paused needs pausedUntil, a time or null.
      JSON.stringify({ ...REPORT, paused: true, pausedUntil: undefined }),
      JSON.stringify({ ...REPORT, running: { kind: "request" } }),
      JSON.stringify({ ...REPORT, running: undefined }),
      JSON.stringify({ ...REPORT, finished: [{ requestId: randomUUID(), result: { t3: "accepted" } }] }),
    ]) {
      const { exit, result } = await json(["checkin"], bad)
      expect([bad, exit, result.ok, (result.error as { code: string }).code]).toEqual([bad, 2, false, "invalid_report"])
    }
    expect(fake.checkins).toEqual([])
  })
})

describe('the stored endpoints listing (client-contract.md, "Kind from the server")', () => {
  const listingFile = () => {
    const name = readdirSync(data()).find((f) => f.startsWith("endpoints-") && f.endsWith(".json"))
    if (!name) throw new Error("no stored listing")
    return join(data(), name)
  }

  it("is kept after the first check-in, so a later check-in sends one request", async () => {
    const listings = fake.counts.listing
    expect((await checkin()).result.ok).toBe(true)
    expect(fake.counts.listing - listings).toBe(1)
    expect(JSON.parse(readFileSync(listingFile(), "utf8"))).toMatchObject({
      issuer: fake.issuer,
      revision: fake.revision,
    })
    expect((await checkin()).result.ok).toBe(true)
    expect(fake.counts.listing - listings).toBe(1)
    expect(fake.checkins).toHaveLength(2)
  })

  it("is fetched once more after policy_changed, and the check-in sent again", async () => {
    await checkin()
    const before = fake.revision
    fake.revision = randomBytes(8).toString("hex")
    try {
      const listings = fake.counts.listing
      expect((await checkin()).result.ok).toBe(true)
      expect(fake.counts.listing - listings).toBe(1)
      expect(fake.checkins).toHaveLength(2)
      expect(JSON.parse(readFileSync(listingFile(), "utf8")).revision).toBe(fake.revision)
    } finally {
      fake.revision = before
    }
  })

  it("is not used for another address, nor when it cannot be read", async () => {
    await checkin()
    const stored = JSON.parse(readFileSync(listingFile(), "utf8"))
    writeFileSync(listingFile(), JSON.stringify({ ...stored, issuer: "https://other.example.com" }))
    const listings = fake.counts.listing
    expect((await checkin()).result.ok).toBe(true)
    expect(fake.counts.listing - listings).toBe(1)
    writeFileSync(listingFile(), "not json")
    expect((await checkin()).result.ok).toBe(true)
    expect(fake.counts.listing - listings).toBe(2)
  })

  it("is fetched again when it does not hold the check-in, before the sync says Adiutor is older", async () => {
    fake.offersCheckin = false
    expect(((await checkin()).result.error as { code: string }).code).toBe("server_older")
    // Adiutor was updated: the stored listing has no check-in, so a fresh one is read.
    fake.offersCheckin = true
    const listings = fake.counts.listing
    expect((await checkin()).result.ok).toBe(true)
    expect(fake.counts.listing - listings).toBe(1)
  })
})

describe("parseReport", () => {
  it("normalizes times and ids, and keeps no time on a pause it does not have", () => {
    const id = randomUUID().toUpperCase()
    const parsed = parseReport(
      JSON.stringify({
        ...REPORT,
        pausedUntil: "2026-11-17T08:00:00+02:00",
        running: { kind: "local", startedAt: "2026-11-16T21:00:00Z" },
        finished: [{ requestId: id, result: { t3: "not_run", security: "outcome_unknown" } }],
      }),
    )
    expect(parsed).toEqual({
      ...REPORT,
      pausedUntil: null,
      running: { kind: "local", startedAt: "2026-11-16T21:00:00.000Z" },
      finished: [{ requestId: id.toLowerCase(), result: { t3: "not_run", security: "outcome_unknown" } }],
    })
    expect(parseReport(JSON.stringify({ ...REPORT, paused: true, pausedUntil: "2026-11-17T08:00:00+02:00" }))).toEqual({
      ...REPORT,
      paused: true,
      pausedUntil: "2026-11-17T06:00:00.000Z",
    })
  })

  it("refuses more than 20 finished requests", () => {
    const finished = Array.from({ length: 21 }, () => ({
      requestId: randomUUID(),
      result: { t3: "accepted", security: "accepted" },
    }))
    expect(() => parseReport(JSON.stringify({ ...REPORT, finished }))).toThrow(/at most 20/)
  })
})

describe("run --request", () => {
  it("names the request it served in its report and in the status file", async () => {
    const requestId = randomUUID()
    fake.claim = requestId
    await checkin()
    const { result } = await json(["run", "--no-collect", "--request", requestId.toUpperCase()])
    const report = (result as { report?: RunReport }).report
    expect(report?.requestId).toBe(requestId)
    const status = JSON.parse(readFileSync(join(data(), "status.json"), "utf8"))
    expect(status.lastRun.requestId).toBe(requestId)
    const plain = await json(["run", "--no-collect"])
    expect((plain.result as { report?: RunReport }).report?.requestId).toBeNull()
  })

  it("runs nothing for a request that is not this connection's kept claim", async () => {
    const other = randomUUID()
    const refused = await json(["run", "--no-collect", "--request", other])
    expect([refused.exit, refused.result.ok, (refused.result.error as { code: string }).code]).toEqual([
      1,
      false,
      "request_not_claimed",
    ])
    // A claim of the connection before connect --replace is not this connection's either.
    fake.claim = other
    await checkin()
    await connectSync()
    const replaced = await json(["run", "--no-collect", "--request", other])
    expect((replaced.result.error as { code: string }).code).toBe("request_not_claimed")
    expect(existsSync(join(data(), "status.json"))).toBe(false)
    expect(fake.pushes).toHaveLength(0)
  })

  it("refuses a request id that is not one", async () => {
    const { exit, result } = await json(["run", "--request", "not-an-id"])
    expect([exit, (result.error as { code: string }).code]).toEqual([2, "usage"])
  })
})
