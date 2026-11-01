import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { T3Snapshot } from "../../shared/api.ts"
import { audit, items, itemThreads, projects, suppressions } from "../db/schema.ts"
import { agent, createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import { expectLinkLockFirst } from "../testing/locks.ts"
import { listSuppressions, removeSuppression } from "./admin.ts"
import { createItem, deleteItem, linkThread } from "./items.ts"
import { createProject, deleteProject } from "./projects.ts"
import { applyT3Snapshot } from "./sync.ts"
import { startThread } from "./threads.ts"

// Every transaction that changes the structure of thread links and suppressions takes the one link
// structure lock as its first statement (LINK_STRUCTURE_LOCK_KEY in context.ts).

let t: TestDatabase

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  t = await createTestDatabase("locks")
})
afterAll(async () => {
  await t?.close()
  vi.restoreAllMocks()
})
beforeEach(async () => {
  await t.reset()
})

type Thread = T3Snapshot["threads"][number]

function thread(threadId: string, extra: Partial<Thread> = {}): Thread {
  return {
    threadId,
    t3ProjectId: null,
    title: `Thread ${threadId}`,
    status: "running",
    settled: false,
    settledAt: null,
    parentThreadId: null,
    updatedAt: new Date(t.ctx.clock().getTime() - 60_000),
    ...extra,
  }
}

/** A snapshot without projects, so the sync's first transaction is the first thread record's. */
const threadsOnly = (threads: Thread[]): T3Snapshot => ({ collectedAt: t.ctx.clock(), projects: [], threads })
/** A child thread whose top-level thread is not in the snapshot: the sync only folds its link. */
const foldOnly = (child: string, root: string) => threadsOnly([thread(child, { parentThreadId: root })])

async function linkedItem(threadIds: string[]) {
  const item = await createItem(t.ctx, agent, { type: "task", title: "Linked", status: "in_progress" })
  for (const threadId of threadIds) await linkThread(t.ctx, agent, item.id, { threadId })
  return item
}

const linksOf = async (itemId: string) =>
  (await t.ctx.db.select().from(itemThreads).where(eq(itemThreads.itemId, itemId))).map((l) => l.threadId).sort()

describe("the link structure lock comes before any row lock", () => {
  it("startThread creating an item", async () => {
    const result = await expectLinkLockFirst(t, () =>
      startThread(t.ctx, agent, { threadId: "new-1", parentThreadId: null, title: "Build" }),
    )
    expect(result).toMatchObject({ created: true, linked: true })
  })

  it("startThread linking a given item", async () => {
    const item = await createItem(t.ctx, owner, { type: "task", title: "Given" })
    const result = await expectLinkLockFirst(t, () =>
      startThread(t.ctx, agent, { threadId: "given-1", parentThreadId: null, title: "Build", itemId: item.id }),
    )
    expect(result).toMatchObject({ created: false, linked: true })
  })

  it("linkThread", async () => {
    const item = await createItem(t.ctx, owner, { type: "task", title: "Link me" })
    await expectLinkLockFirst(t, () => linkThread(t.ctx, agent, item.id, { threadId: "link-1" }))
    expect(await linksOf(item.id)).toEqual(["link-1"])
  })

  it("deleteItem", async () => {
    const item = await linkedItem(["del-1", "del-2"])
    await expectLinkLockFirst(t, () => deleteItem(t.ctx, owner, item.id))
    expect(await t.ctx.db.select().from(items)).toHaveLength(0)
  })

  it("deleteProject", async () => {
    const p = await createProject(t.ctx, owner, { name: "Lantern", t3ProjectId: "t3-lantern" })
    await expectLinkLockFirst(t, () => deleteProject(t.ctx, owner, p.id))
    expect(await t.ctx.db.select().from(projects)).toHaveLength(0)
  })

  it("removeSuppression", async () => {
    await deleteItem(t.ctx, owner, (await linkedItem(["gone-1"])).id)
    const [s] = await listSuppressions(t.ctx, owner)
    await expectLinkLockFirst(t, () => removeSuppression(t.ctx, owner, s?.id ?? ""))
    expect(await t.ctx.db.select().from(suppressions)).toHaveLength(0)
  })

  it("the sync's project step", async () => {
    const snap: T3Snapshot = {
      collectedAt: t.ctx.clock(),
      projects: [{ t3ProjectId: "t3-garden", title: "Garden" }],
      threads: [],
    }
    const result = await expectLinkLockFirst(t, () => applyT3Snapshot(t.ctx, snap))
    expect(result.counts).toMatchObject({ projectsCreated: 1 })
  })

  it("the sync's creation of an item for a thread", async () => {
    const result = await expectLinkLockFirst(t, () => applyT3Snapshot(t.ctx, threadsOnly([thread("sync-1")])))
    expect(result.counts).toMatchObject({ itemsCreated: 1 })
  })

  it("the sync's folding of a child thread's link", async () => {
    const item = await linkedItem(["child-1"])
    const result = await expectLinkLockFirst(t, () => applyT3Snapshot(t.ctx, foldOnly("child-1", "root-1")))
    expect(result.counts).toMatchObject({ childLinksFolded: 1 })
    expect(await linksOf(item.id)).toEqual(["root-1"])
  })
})

describe("concurrent link changes never deadlock", () => {
  const ROUNDS = 40

  /**
   * Runs both, one of them up to 7 milliseconds after the other, alternating by round (the sync runs a few
   * statements before its first transaction, so delays on both sides reach other interleavings). Neither
   * may fail: a deadlock aborts one with SQLSTATE 40P01.
   */
  async function together<A, B>(round: number, a: () => Promise<A>, b: () => Promise<B>): Promise<[A, B]> {
    const later = <T>(run: () => Promise<T>) =>
      new Promise((resolve) => setTimeout(resolve, (round >> 1) % 8)).then(run)
    const first = round % 2 === 0
    const [ra, rb] = await Promise.allSettled([first ? a() : later(a), first ? later(b) : b()])
    for (const r of [ra, rb]) if (r.status === "rejected") throw r.reason
    return [(ra as PromiseFulfilledResult<A>).value, (rb as PromiseFulfilledResult<B>).value]
  }

  it("an owner delete while the sync folds the item's child link (R16)", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const [child, other, root] = [`child-${round}`, `other-${round}`, `root-${round}`]
      const item = await linkedItem([child, other])
      const [, sync] = await together(
        round,
        () => deleteItem(t.ctx, owner, item.id),
        () => applyT3Snapshot(t.ctx, foldOnly(child, root)),
      )
      expect(sync.errors).toEqual([])
      expect(await t.ctx.db.select().from(items).where(eq(items.id, item.id))).toHaveLength(0)
      const folded = (await t.ctx.db.select().from(audit).where(eq(audit.action, "thread.move"))).some(
        (a) => (a.after as { threadId?: string } | null)?.threadId === root,
      )
      const suppressed = (await t.ctx.db.select().from(suppressions))
        .map((s) => s.externalId)
        .filter((id) => id.endsWith(`-${round}`))
        .sort()
      // The delete suppresses the thread ids the item had when it ran: the child's, or the moved one.
      expect(suppressed).toEqual(folded ? [other, root] : [child, other])
    }
    expect(await t.ctx.db.select().from(itemThreads)).toHaveLength(0)
  })

  it("an agent starts the top-level thread on the item while the sync folds its child link into it (R17)", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const [child, root] = [`child-${round}`, `root-${round}`]
      const item = await linkedItem([child])
      const [started, sync] = await together(
        round,
        () => startThread(t.ctx, agent, { threadId: root, parentThreadId: null, title: "Build", itemId: item.id }),
        () => applyT3Snapshot(t.ctx, foldOnly(child, root)),
      )
      expect(sync.errors).toEqual([])
      expect(started.item.id).toBe(item.id)
      // Either order ends with the one top-level link on the item.
      expect(await linksOf(item.id)).toEqual([root])
    }
  })
})
