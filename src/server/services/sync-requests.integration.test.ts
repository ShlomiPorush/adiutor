import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { SyncCheckin } from "../../shared/api.ts"
import { audit, syncRequests } from "../db/schema.ts"
import { AppError } from "../errors.ts"
import { addSyncConnection } from "../testing/agents.ts"
import { agent, createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import {
  cancelSyncRequest,
  checkIn,
  finishedState,
  requestSync,
  SYNC_LEASE_MS,
  SYNC_SILENT_AFTER_MS,
  syncRequestsView,
} from "./sync-requests.ts"

/*
 * Sync requests and the check-in (the sync tray plan, section 4, "Adiutor server and UI"): the claim bound to the
 * connection that checks in, a lost answer delivered again, the lease and `unknown` with a late result, pause, local
 * runs, cancel, one request at a time, and the view Settings, Sync reads.
 */

let t: TestDatabase

beforeAll(async () => {
  t = await createTestDatabase("sync_requests")
})
afterAll(async () => {
  await t?.close()
})
beforeEach(async () => {
  await t.reset()
})

const MINUTE = 60_000

/** A check-in with nothing running, not paused, nothing finished, unless `extra` says otherwise. */
const report = (extra: Partial<SyncCheckin> = {}): SyncCheckin => ({
  version: "0.3.0",
  paused: false,
  pausedUntil: null,
  nextRunAt: null,
  running: null,
  finished: [],
  ...extra,
})

const row = async (id: string) => {
  const [found] = await t.ctx.db.select().from(syncRequests).where(eq(syncRequests.id, id))
  if (!found) throw new Error("no such request")
  return found
}

const auditRows = (action: string) => t.ctx.db.select().from(audit).where(eq(audit.action, action))

const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(AppError)
  return error as AppError
}

describe("Sync now", () => {
  it("makes one waiting request, audited; a second press answers the same request", async () => {
    const first = await requestSync(t.ctx, owner)
    expect(first.created).toBe(true)
    expect(first.request.state).toBe("waiting")
    const second = await requestSync(t.ctx, owner)
    expect(second).toMatchObject({ created: false, request: { id: first.request.id, state: "waiting" } })
    const rows = await auditRows("sync_request.create")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ entityType: "sync_request", entityId: first.request.id, actorKind: "owner" })
  })

  it("keeps one request open when the owner presses twice at once", async () => {
    const [a, b] = await Promise.all([requestSync(t.ctx, owner), requestSync(t.ctx, owner)])
    expect(a.request.id).toBe(b.request.id)
    expect([a.created, b.created].sort()).toEqual([false, true])
    expect(await t.ctx.db.select().from(syncRequests)).toHaveLength(1)
  })

  it("is the owner's alone", async () => {
    expect((await refusal(requestSync(t.ctx, agent))).code).toBe("forbidden")
    expect((await refusal(cancelSyncRequest(t.ctx, agent, randomUUID()))).code).toBe("forbidden")
  })

  it("answers the claimed request while the computer runs it, and makes a new one once it finished", async () => {
    const computer = randomUUID()
    const { request } = await requestSync(t.ctx, owner)
    await checkIn(t.ctx, computer, report())
    expect(await requestSync(t.ctx, owner)).toMatchObject({ created: false, request: { id: request.id } })
    await checkIn(
      t.ctx,
      computer,
      report({ finished: [{ requestId: request.id, result: { t3: "accepted", security: "accepted" } }] }),
    )
    const next = await requestSync(t.ctx, owner)
    expect(next.created).toBe(true)
    expect(next.request.id).not.toBe(request.id)
  })
})

describe("the check-in", () => {
  it("claims the oldest waiting request for the connection that checks in, with a lease", async () => {
    const computer = randomUUID()
    const { request } = await requestSync(t.ctx, owner)
    const answer = await checkIn(t.ctx, computer, report())
    expect(answer.claim?.requestId).toBe(request.id)
    const claimed = await row(request.id)
    expect(claimed).toMatchObject({ state: "claimed", claimedBy: computer })
    expect(claimed.leaseUntil?.getTime()).toBe((claimed.claimedAt as Date).getTime() + SYNC_LEASE_MS)
  })

  it("answers a claim whose answer was lost again, to the same connection only", async () => {
    const computer = randomUUID()
    const { request } = await requestSync(t.ctx, owner)
    const first = await checkIn(t.ctx, computer, report())
    // The answer was lost: the same report again gets the same claim, and nothing else changed.
    const again = await checkIn(t.ctx, computer, report())
    expect(again.claim?.requestId).toBe(first.claim?.requestId)
    expect((await row(request.id)).claimedBy).toBe(computer)
    expect((await checkIn(t.ctx, randomUUID(), report())).claim).toBeNull()
  })

  it("gives a request to exactly one of two check-ins at once", async () => {
    await requestSync(t.ctx, owner)
    for (let round = 0; round < 5; round++) {
      await t.reset()
      const { request } = await requestSync(t.ctx, owner)
      const [a, b] = [randomUUID(), randomUUID()]
      const answers = await Promise.all([checkIn(t.ctx, a, report()), checkIn(t.ctx, b, report())])
      const claims = answers.filter((x) => x.claim !== null)
      expect(claims).toHaveLength(1)
      expect(claims[0]?.claim?.requestId).toBe(request.id)
      const holder = answers[0]?.claim ? a : b
      expect((await row(request.id)).claimedBy).toBe(holder)
    }
  })

  it("claims nothing while the computer is paused, until resumed or the pause ends", async () => {
    const computer = randomUUID()
    const { request } = await requestSync(t.ctx, owner)
    expect((await checkIn(t.ctx, computer, report({ paused: true, pausedUntil: null }))).claim).toBeNull()
    const later = new Date(t.ctx.clock().getTime() + 30 * MINUTE)
    expect((await checkIn(t.ctx, computer, report({ paused: true, pausedUntil: later }))).claim).toBeNull()
    expect((await row(request.id)).state).toBe("waiting")
    const ended = new Date(t.ctx.clock().getTime() - MINUTE)
    expect((await checkIn(t.ctx, computer, report({ paused: true, pausedUntil: ended }))).claim?.requestId).toBe(
      request.id,
    )
  })

  it("claims nothing while a run of the computer's own is going", async () => {
    const computer = randomUUID()
    const { request } = await requestSync(t.ctx, owner)
    const local = report({ running: { kind: "local", startedAt: t.ctx.clock() } })
    expect((await checkIn(t.ctx, computer, local)).claim).toBeNull()
    expect((await row(request.id)).state).toBe("waiting")
    expect((await checkIn(t.ctx, computer, report())).claim?.requestId).toBe(request.id)
  })

  it("claims nothing while the computer reports another request running", async () => {
    const computer = randomUUID()
    const { request } = await requestSync(t.ctx, owner)
    const busy = report({ running: { kind: "request", requestId: randomUUID() } })
    expect((await checkIn(t.ctx, computer, busy)).claim).toBeNull()
    expect((await row(request.id)).state).toBe("waiting")
  })

  it("applies a finished result once, from the claim holder only; the final states ignore later reports", async () => {
    const [computer, other] = [randomUUID(), randomUUID()]
    const { request } = await requestSync(t.ctx, owner)
    await checkIn(t.ctx, computer, report())
    const failed = { requestId: request.id, result: { t3: "failed" as const, security: "not_run" as const } }
    await checkIn(t.ctx, other, report({ finished: [failed] }))
    expect((await row(request.id)).state).toBe("claimed")
    const done = { requestId: request.id, result: { t3: "accepted" as const, security: "accepted" as const } }
    await checkIn(t.ctx, computer, report({ finished: [done] }))
    const finished = await row(request.id)
    expect(finished).toMatchObject({ state: "done", result: done.result })
    // The same report again (its answer was lost), then a different one: nothing changes.
    t.clock.travel(MINUTE)
    await checkIn(t.ctx, computer, report({ finished: [done] }))
    await checkIn(t.ctx, computer, report({ finished: [failed] }))
    expect(await row(request.id)).toEqual(finished)
  })

  it("renews the lease of the running request at every check-in", async () => {
    const computer = randomUUID()
    const { request } = await requestSync(t.ctx, owner)
    await checkIn(t.ctx, computer, report())
    const running = report({ running: { kind: "request", requestId: request.id } })
    for (let i = 0; i < 3; i++) {
      t.clock.travel(SYNC_LEASE_MS - MINUTE)
      await checkIn(t.ctx, computer, running)
      expect((await row(request.id)).state).toBe("claimed")
    }
    // The test clock is the real time moved: a few milliseconds pass between the check-in and this read.
    const lease = (await row(request.id)).leaseUntil?.getTime() ?? 0
    expect(t.ctx.clock().getTime() + SYNC_LEASE_MS - lease).toBeLessThan(5_000)
  })

  it("makes a claim whose lease passed unknown, and still takes its late result", async () => {
    const computer = randomUUID()
    const { request } = await requestSync(t.ctx, owner)
    await checkIn(t.ctx, computer, report())
    t.clock.travel(SYNC_LEASE_MS + MINUTE)
    // Read before any check-in wrote it: unknown already.
    expect((await syncRequestsView(t.ctx)).request?.state).toBe("unknown")
    // A check-in of another computer writes it, and never takes it.
    expect((await checkIn(t.ctx, randomUUID(), report())).claim).toBeNull()
    expect((await row(request.id)).state).toBe("unknown")
    // The press after it makes a new request: an unknown one holds nothing.
    const next = await requestSync(t.ctx, owner)
    expect(next.created).toBe(true)
    // The late result of the computer that held it lands.
    const late = { requestId: request.id, result: { t3: "accepted" as const, security: "partial" as const } }
    await checkIn(t.ctx, computer, report({ running: { kind: "local", startedAt: t.ctx.clock() }, finished: [late] }))
    expect(await row(request.id)).toMatchObject({ state: "partial", result: late.result, claimedBy: computer })
    expect((await row(next.request.id)).state).toBe("waiting")
  })

  it("keeps the old connection's claim until its lease passes after the sync connected again", async () => {
    const [old, renewed] = [randomUUID(), randomUUID()]
    const { request } = await requestSync(t.ctx, owner)
    await checkIn(t.ctx, old, report())
    expect((await checkIn(t.ctx, renewed, report())).claim).toBeNull()
    t.clock.travel(SYNC_LEASE_MS + MINUTE)
    expect((await checkIn(t.ctx, renewed, report())).claim).toBeNull()
    expect((await row(request.id)).state).toBe("unknown")
    const next = await requestSync(t.ctx, owner)
    expect((await checkIn(t.ctx, renewed, report())).claim?.requestId).toBe(next.request.id)
  })
})

describe("cancel", () => {
  it("cancels a waiting request, audited", async () => {
    const { request } = await requestSync(t.ctx, owner)
    const cancelled = await cancelSyncRequest(t.ctx, owner, request.id)
    expect(cancelled.state).toBe("cancelled")
    expect(await auditRows("sync_request.cancel")).toHaveLength(1)
    expect((await checkIn(t.ctx, randomUUID(), report())).claim).toBeNull()
  })

  it("refuses a claimed or finished request with conflict, and an unknown id with not_found", async () => {
    const { request } = await requestSync(t.ctx, owner)
    await checkIn(t.ctx, randomUUID(), report())
    const claimed = await refusal(cancelSyncRequest(t.ctx, owner, request.id))
    expect(claimed.code).toBe("conflict")
    expect(claimed.details).toMatchObject({ state: "claimed" })
    expect((await refusal(cancelSyncRequest(t.ctx, owner, randomUUID()))).code).toBe("not_found")
    expect(await auditRows("sync_request.cancel")).toHaveLength(0)
  })
})

describe("the view", () => {
  it("says no computer ever checked in, or that the sync there takes no requests", async () => {
    expect(await syncRequestsView(t.ctx)).toEqual({ request: null, client: null, unavailable: "no_client" })
    await addSyncConnection(t.ctx)
    expect((await syncRequestsView(t.ctx)).unavailable).toBe("older_client")
  })

  it("shows the computer that checked in last, its pause, and silence after three missed check-ins", async () => {
    const until = new Date(t.ctx.clock().getTime() + 60 * MINUTE)
    await checkIn(t.ctx, randomUUID(), report({ version: "0.3.0" }))
    t.clock.travel(MINUTE)
    await checkIn(t.ctx, randomUUID(), report({ version: "0.3.1", paused: true, pausedUntil: until }))
    const view = await syncRequestsView(t.ctx)
    expect(view.unavailable).toBeNull()
    expect(view.client).toMatchObject({ version: "0.3.1", paused: true, pausedUntil: until, silent: false })
    t.clock.travel(SYNC_SILENT_AFTER_MS + 1)
    expect((await syncRequestsView(t.ctx)).client?.silent).toBe(true)
    // The pause ended meanwhile.
    t.clock.travel(60 * MINUTE)
    expect((await syncRequestsView(t.ctx)).client?.paused).toBe(false)
  })
})

describe("finishedState", () => {
  it("is done when both parts were accepted, failed when neither got through, partial otherwise", () => {
    expect(finishedState({ t3: "accepted", security: "accepted" })).toBe("done")
    expect(finishedState({ t3: "accepted", security: "not_run" })).toBe("partial")
    expect(finishedState({ t3: "partial", security: "failed" })).toBe("partial")
    expect(finishedState({ t3: "outcome_unknown", security: "failed" })).toBe("failed")
    expect(finishedState({ t3: "not_run", security: "not_run" })).toBe("failed")
  })
})
