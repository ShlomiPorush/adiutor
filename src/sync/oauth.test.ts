import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type FakeAdiutor, startFakeAdiutor } from "./fake-adiutor.ts"
import { type ClientDeps, credentialsDir, issuerOf, othersAllowed, syncClient } from "./oauth.ts"

// The sync's OAuth client (client-contract.md, in the sync's shape) against a strict stand-in Adiutor over real HTTP:
// connecting, the policy headers, the refresh under the lock, and pushes that are never sent twice.

let fake: FakeAdiutor
const temps: string[] = []
beforeAll(async () => {
  fake = await startFakeAdiutor()
})
afterAll(() => fake.close())
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
  Object.assign(fake, {
    beforePush: [],
    afterPush: [],
    beforeListing: [],
    dropNextRefresh: false,
    dropNextPoll: false,
    listingStatus: 0,
  })
  fake.grantScope = "sync"
  fake.pushes.length = 0
})

/** A computer user of its own: a home folder; `offset` moves this client's clock (seconds). */
function user() {
  const home = mkdtempSync(join(tmpdir(), "adiutor-sync-client-"))
  temps.push(home)
  const clock = { offset: 0 }
  const deps: ClientDeps = {
    fetch: (input, init) => fetch(input, init),
    runner: async () => ({ code: 1, stdout: "", stderr: "", error: "no runner here" }),
    systemCommand: async () => undefined,
    platform: "linux",
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    now: () => Date.now() + clock.offset * 1000,
    // Short, but a real wait: a lock's waiter must let the holder's request go on.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
  }
  return { home, clock, deps, client: () => syncClient(fake.issuer, deps) }
}

/** Connects through the device grant, the owner approving after one pending poll. */
async function connected(u: ReturnType<typeof user>, label = "Sync on the laptop") {
  const client = u.client()
  await client.prepare()
  const device = await client.deviceCode(label)
  let polls = 0
  const waiting = syncClient(fake.issuer, {
    ...u.deps,
    sleep: async () => {
      if (++polls === 2) fake.approve()
      await new Promise((resolve) => setTimeout(resolve, 1))
    },
  })
  const done = await waiting.waitForApproval(device, label)
  return { client, done, device }
}

const record = (u: ReturnType<typeof user>) => {
  const dir = credentialsDir("linux", u.deps.env)
  const file = readdirSync(dir).find((f) => f.endsWith(".json")) ?? ""
  return { dir, file: join(dir, file), json: JSON.parse(readFileSync(join(dir, file), "utf8")) }
}

describe("connecting", () => {
  it("asks for the sync area alone on the REST resource with its name, and keeps the connection owner-only", async () => {
    const u = user()
    const { done } = await connected(u)
    expect(fake.last).toEqual({
      label: "Sync on the laptop",
      scope: "sync",
      resource: `${fake.issuer}/api/v1`,
      clientId: "adiutor-agent",
    })
    expect(done.scope).toBe("sync")
    const r = record(u)
    expect(r.dir).toBe(join(u.home, ".config", "adiutor", "connection"))
    expect(statSync(r.dir).mode & 0o777).toBe(0o700)
    expect(statSync(r.file).mode & 0o777).toBe(0o600)
    expect(r.json).toMatchObject({ issuer: fake.issuer, label: "Sync on the laptop", scope: "sync" })
    expect(await u.client().status()).toEqual({ connected: true, label: "Sync on the laptop", scope: "sync" })
  })

  it("never presents a code again when the answer to a poll was lost", async () => {
    const u = user()
    const client = u.client()
    await client.prepare()
    const device = await client.deviceCode("Sync")
    fake.approve()
    fake.dropNextPoll = true
    await expect(client.waitForApproval(device, "Sync")).rejects.toMatchObject({ code: "unreachable" })
    expect(fake.counts.reuse).toBe(0)
    expect(await client.status()).toEqual({ connected: false })
  })

  it("polls only under the connection's lock: while another command holds it, the code is not spent", async () => {
    const u = user()
    const client = u.client()
    await client.prepare()
    const device = await client.deviceCode("Sync")
    fake.approve()
    const lock = join(
      credentialsDir("linux", u.deps.env),
      `${createHash("sha256").update(fake.issuer).digest("hex").slice(0, 32)}.lock`,
    )
    // A live holder: this very process, under another token.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: "another", startedAt: 1 }))
    const polls = fake.counts.poll
    // The lock's wait runs on this client's clock: each wait moves it on, so the 20 seconds pass at once.
    const waiting = syncClient(fake.issuer, {
      ...u.deps,
      sleep: async (ms) => {
        u.clock.offset += ms / 1000
        await new Promise((resolve) => setTimeout(resolve, 1))
      },
    })
    await expect(waiting.waitForApproval(device, "Sync")).rejects.toMatchObject({ code: "busy" })
    expect(fake.counts.poll).toBe(polls)
    // Once the lock is free, the same code is collected and the connection kept.
    rmSync(lock)
    expect(await waiting.waitForApproval(device, "Sync")).toMatchObject({ scope: "sync" })
    expect(await client.status()).toMatchObject({ connected: true })
  })

  it("stops when the owner denies", async () => {
    const u = user()
    const client = u.client()
    await client.prepare()
    const device = await client.deviceCode("Sync")
    fake.deny()
    await expect(client.waitForApproval(device, "Sync")).rejects.toMatchObject({ code: "denied" })
  })

  it("refuses a folder others can open, and an address that is not a plain origin", async () => {
    const u = user()
    await connected(u)
    chmodSync(record(u).dir, 0o755)
    const pushed = await u.client().push("/api/v1/sync/t3", {})
    expect(pushed).toMatchObject({ kind: "failed", code: "insecure_credentials" })
    expect(fake.pushes).toHaveLength(0)
    for (const bad of ["http://adiutor.example.com", "https://a$(id).example.com", "https://x.example.com/path"])
      expect(() => issuerOf(bad)).toThrow()
    expect(issuerOf("https://adiutor.example.com/")).toBe("https://adiutor.example.com")
  })
})

describe("pushing", () => {
  it("sends the policy revision and the kind from the listing, and the listing once per run", async () => {
    const u = user()
    const { client } = await connected(u)
    const listings = fake.counts.listing
    expect(await client.push("/api/v1/sync/t3", { a: 1 })).toMatchObject({ kind: "answer", status: 200 })
    expect(await client.push("/api/v1/sync/security", { b: 2 })).toMatchObject({ kind: "answer", status: 200 })
    expect(fake.counts.listing - listings).toBe(1)
    expect(fake.pushes.map((p) => [p.path, p.policy, p.kind])).toEqual([
      ["/api/v1/sync/t3", fake.revision, "act"],
      ["/api/v1/sync/security", fake.revision, "act"],
    ])
  })

  it("never sends a push twice: a lost answer or a server failure is outcome_unknown", async () => {
    const u = user()
    const { client } = await connected(u)
    fake.afterPush.push("drop")
    expect(await client.push("/api/v1/sync/t3", {})).toEqual({ kind: "outcome_unknown" })
    fake.afterPush.push(500)
    expect(await client.push("/api/v1/sync/t3", {})).toEqual({ kind: "outcome_unknown", status: 500 })
    expect(fake.pushes).toHaveLength(2)
  })

  it("answers the reserved refusals once each: a refresh after invalid_token, a wait after busy, the list again after policy_changed", async () => {
    const u = user()
    const { client } = await connected(u)
    const refreshes = fake.counts.refresh
    fake.beforePush.push("invalid_token", "busy", "policy_changed")
    expect(await client.push("/api/v1/sync/t3", {})).toMatchObject({ kind: "answer", status: 200 })
    expect(fake.counts.refresh - refreshes).toBe(1)
    expect(fake.pushes).toHaveLength(1)
    // A second policy_changed in a row ends the push; nothing ran.
    fake.beforePush.push("policy_changed", "policy_changed")
    expect(await client.push("/api/v1/sync/t3", {})).toMatchObject({ kind: "failed", code: "policy_changed" })
    // A second invalid_token is passed back as the answer, not refreshed again.
    fake.beforePush.push("invalid_token", "invalid_token")
    expect(await client.push("/api/v1/sync/t3", {})).toMatchObject({ kind: "answer", status: 401 })
    expect(fake.pushes).toHaveLength(1)
  })

  it("reads the list once more after a lost answer or busy, as the skill reads it, and no more", async () => {
    const u = user()
    const { client } = await connected(u)
    fake.beforeListing.push("drop")
    expect(await client.push("/api/v1/sync/t3", {})).toMatchObject({ kind: "answer", status: 200 })
    const busy = (await connected(user())).client
    fake.beforeListing.push("busy")
    expect(await busy.push("/api/v1/sync/t3", {})).toMatchObject({ kind: "answer", status: 200 })
    const twice = (await connected(user())).client
    fake.beforeListing.push("drop", "drop")
    expect(await twice.push("/api/v1/sync/t3", {})).toMatchObject({ kind: "failed", code: "endpoints_unavailable" })
    expect(fake.pushes).toHaveLength(2)
  })

  it("sends nothing when the list of calls cannot be read, or does not hold the push", async () => {
    const u = user()
    fake.grantScope = "read"
    const { client } = await connected(u)
    expect(await client.push("/api/v1/sync/t3", {})).toMatchObject({ kind: "failed", code: "not_allowed" })
    const v = user()
    fake.grantScope = "sync"
    const other = (await connected(v)).client
    fake.listingStatus = 500
    expect(await other.push("/api/v1/sync/t3", {})).toMatchObject({ kind: "failed", code: "endpoints_unavailable" })
    expect(fake.pushes).toHaveLength(0)
  })
})

describe("the refresh", () => {
  it("reuses the access token until a minute before its end, then refreshes it once", async () => {
    const u = user()
    await connected(u)
    const refreshes = fake.counts.refresh
    expect(await u.client().push("/api/v1/sync/t3", {})).toMatchObject({ status: 200 })
    expect(fake.counts.refresh).toBe(refreshes)
    u.clock.offset = 850
    expect(await u.client().push("/api/v1/sync/t3", {})).toMatchObject({ status: 200 })
    expect(fake.counts.refresh - refreshes).toBe(1)
    expect(fake.counts.reuse).toBe(0)
  })

  it("refreshes once when several runs find the token ended at the same time", async () => {
    const u = user()
    await connected(u)
    u.clock.offset = 900
    const refreshes = fake.counts.refresh
    const all = await Promise.all(Array.from({ length: 6 }, () => u.client().push("/api/v1/sync/t3", {})))
    for (const one of all) expect(one).toMatchObject({ kind: "answer", status: 200 })
    expect(fake.counts.refresh - refreshes).toBe(1)
    expect(fake.counts.reuse).toBe(0)
  })

  it("takes over the lock of a holder that died, never one that lives", async () => {
    const u = user()
    await connected(u)
    const lock = record(u).file.replace(/\.json$/, ".lock")
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 17, host: hostname(), token: "dead", startedAt: 1 }))
    u.clock.offset = 900
    expect(await u.client().push("/api/v1/sync/t3", {})).toMatchObject({ status: 200 })
  })

  it("after a lost refresh answer: never resends within the grace, tries once more after it, and that ends the connection", async () => {
    const u = user()
    await connected(u)
    const alive = fake.aliveGrants()
    u.clock.offset = 900
    fake.dropNextRefresh = true
    expect(await u.client().push("/api/v1/sync/t3", {})).toMatchObject({ kind: "failed", code: "unreachable" })
    expect(record(u).json.refreshStartedAt).toBeGreaterThan(0)
    expect(await u.client().push("/api/v1/sync/t3", {})).toMatchObject({ kind: "failed", code: "busy" })
    u.clock.offset = 960
    // The token the lost answer spent comes back: Adiutor ends the whole connection, and the sync says so.
    expect(await u.client().push("/api/v1/sync/t3", {})).toMatchObject({ kind: "failed", code: "connection_ended" })
    expect(fake.aliveGrants()).toBe(alive - 1)
    expect(readdirSync(credentialsDir("linux", u.deps.env)).filter((f) => f.endsWith(".json"))).toHaveLength(0)
    expect(fake.pushes).toHaveLength(0)
  })

  it("forgets a connection Adiutor ended (invalid_grant) and says it ended", async () => {
    const u = user()
    await connected(u)
    fake.endAllGrants()
    expect(await u.client().push("/api/v1/sync/t3", {})).toMatchObject({ kind: "failed", code: "connection_ended" })
    expect(await u.client().status()).toEqual({ connected: false })
    expect(await u.client().push("/api/v1/sync/t3", {})).toMatchObject({ kind: "failed", code: "not_connected" })
  })

  it("never writes a token anywhere but its own file", async () => {
    const u = user()
    await connected(u)
    await u.client().push("/api/v1/sync/t3", {})
    const files = readdirSync(credentialsDir("linux", u.deps.env))
    expect(files.filter((f) => !f.endsWith(".json"))).toEqual([])
  })
})

describe("the Windows access list read back", () => {
  it("allows only the user, SYSTEM and Administrators, as plain entries", () => {
    const sid = "S-1-5-21-1-2-3-1001"
    expect(othersAllowed(`dir\r\nD:PAI(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)\r\n`, sid)).toBeNull()
    expect(othersAllowed(`dir\r\nD:PAI(A;OICI;FA;;;${sid})(A;;FR;;;WD)\r\n`, sid)).toBe("WD")
    expect(othersAllowed(`dir\r\nD:PAI(XA;;FA;;;${sid};(x))\r\n`, sid)).toBe("a conditional entry")
    expect(othersAllowed(`dir\r\nD:PAI(D;;FA;;;WD)(A;;FA;;;${sid})\r\n`, sid)).toBeNull()
  })

  it("keeps the connection inside the user profile", () => {
    expect(credentialsDir("win32", { USERPROFILE: "C:\\Users\\a", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" })).toBe(
      "C:\\Users\\a\\AppData\\Local\\adiutor\\connection",
    )
    expect(() => credentialsDir("win32", { USERPROFILE: "C:\\Users\\a", LOCALAPPDATA: "D:\\shared" })).toThrow(
      /inside your user profile/,
    )
  })
})
