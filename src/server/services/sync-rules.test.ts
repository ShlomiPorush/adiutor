import { describe, expect, it } from "vitest"
import {
  type ItemState,
  type LinkState,
  newItemStatus,
  rootThreadId,
  syncDecision,
  threadsVerdict,
  wantsItem,
} from "./sync-rules.ts"

const t0 = new Date("2026-10-01T08:00:00Z")
const later = (minutes: number) => new Date(t0.getTime() + minutes * 60_000)
const link = (lastStatus: string, settled = false, at = t0): LinkState => ({ lastStatus, settled, lastActivityAt: at })
const item = (status: ItemState["status"], statusSetBy: ItemState["statusSetBy"] = "agent", at = t0): ItemState => ({
  status,
  statusSetBy,
  statusSetAt: at,
})

describe("threadsVerdict", () => {
  it.each(["running", "starting", "queued", "preparing"])("%s means in_progress", (status) => {
    expect(threadsVerdict([link(status)])).toBe("in_progress")
  })

  it("decides over all linked threads together: one running wins over waiting and settled", () => {
    expect(threadsVerdict([link("completed", true), link("waiting"), link("running")])).toBe("in_progress")
    expect(threadsVerdict([link("completed", true), link("waiting")])).toBe("waiting_on_you")
    expect(threadsVerdict([link("completed", true), link("completed", true)])).toBe("done")
  })

  it("changes nothing for a completed but unsettled thread", () => {
    expect(threadsVerdict([link("completed", false)])).toBeNull()
    expect(threadsVerdict([link("completed", true), link("completed", false)])).toBeNull()
    expect(threadsVerdict([])).toBeNull()
  })
})

describe("syncDecision", () => {
  it("moves an agent's item to what the threads say", () => {
    expect(syncDecision(item("in_progress"), [link("waiting")])).toBe("waiting_on_you")
    expect(syncDecision(item("waiting_on_you"), [link("completed", true)])).toBe("done")
    expect(syncDecision(item("todo"), [link("running")])).toBe("in_progress")
  })

  it("never moves an item out of done or not_relevant", () => {
    expect(syncDecision(item("done"), [link("running")])).toBeNull()
    expect(syncDecision(item("not_relevant"), [link("waiting")])).toBeNull()
  })

  it("never sets done on an item in future or todo", () => {
    expect(syncDecision(item("future"), [link("completed", true)])).toBeNull()
    expect(syncDecision(item("todo"), [link("completed", true)])).toBeNull()
  })

  it("lets the owner win when the owner set the status after the threads' last activity", () => {
    expect(syncDecision(item("todo", "owner", later(10)), [link("running", false, later(5))])).toBeNull()
    expect(syncDecision(item("todo", "owner", later(10)), [link("running", false, later(10))])).toBeNull()
    expect(syncDecision(item("todo", "owner", later(10)), [link("running", false, later(11))])).toBe("in_progress")
    expect(
      syncDecision(item("todo", "owner"), [{ lastStatus: "running", settled: false, lastActivityAt: null }]),
    ).toBeNull()
  })

  it("changes nothing when the item already agrees", () => {
    expect(syncDecision(item("in_progress"), [link("running")])).toBeNull()
  })
})

describe("missing items", () => {
  const collectedAt = new Date("2026-11-01T07:30:00Z")
  const daysAgo = (d: number) => new Date(collectedAt.getTime() - d * 24 * 60 * 60 * 1000)

  it("creates one for every unsettled thread, whatever its age", () => {
    expect(wantsItem({ settled: false, updatedAt: daysAgo(400) }, collectedAt)).toBe(true)
  })

  it("creates one for a settled thread only within 7 days", () => {
    expect(wantsItem({ settled: true, settledAt: daysAgo(6.9), updatedAt: daysAgo(30) }, collectedAt)).toBe(true)
    expect(wantsItem({ settled: true, settledAt: daysAgo(7.1), updatedAt: daysAgo(1) }, collectedAt)).toBe(false)
    expect(wantsItem({ settled: true, settledAt: null, updatedAt: daysAgo(8) }, collectedAt)).toBe(false)
  })

  it("gives the new item the status its thread says", () => {
    expect(newItemStatus({ status: "completed", settled: true })).toBe("done")
    expect(newItemStatus({ status: "waiting", settled: false })).toBe("waiting_on_you")
    expect(newItemStatus({ status: "running", settled: false })).toBe("in_progress")
    expect(newItemStatus({ status: "completed", settled: false })).toBe("in_progress")
  })
})

describe("rootThreadId", () => {
  it("follows parents as far as the snapshot knows", () => {
    const parents = new Map<string, string | null>([
      ["top", null],
      ["child", "top"],
      ["grandchild", "child"],
      ["orphan", "outside"],
    ])
    expect(rootThreadId("grandchild", parents)).toBe("top")
    expect(rootThreadId("child", parents)).toBe("top")
    expect(rootThreadId("orphan", parents)).toBe("outside")
    expect(rootThreadId("top", parents)).toBeNull()
  })
})
