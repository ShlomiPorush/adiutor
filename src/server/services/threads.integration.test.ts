import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { items, itemThreads } from "../db/schema.ts"
import { agent, createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import { createItem, deleteItem, linkThread, updateItem } from "./items.ts"
import { createProject } from "./projects.ts"
import { startThread } from "./threads.ts"

let t: TestDatabase

beforeAll(async () => {
  t = await createTestDatabase("threads")
})
afterAll(async () => {
  await t?.close()
})
beforeEach(async () => {
  await t.reset()
})

const start = (threadId: string, extra: Partial<Parameters<typeof startThread>[2]> = {}) =>
  startThread(t.ctx, agent, { threadId, parentThreadId: null, title: "Build the importer", ...extra })

describe("startThread", () => {
  it("creates an in_progress task in the project mapped from the T3 project, linked to the thread", async () => {
    const project = await createProject(t.ctx, owner, { name: "Lantern", t3ProjectId: "t3-lantern" })
    const result = await start("thread-1", { t3ProjectId: "t3-lantern" })
    expect(result).toMatchObject({ created: true, linked: true })
    expect(result.item).toMatchObject({
      projectId: project.id,
      type: "task",
      status: "in_progress",
      createdBy: "agent",
    })
    const [link] = await t.ctx.db.select().from(itemThreads).where(eq(itemThreads.threadId, "thread-1"))
    expect(link).toMatchObject({ itemId: result.item.id, t3ProjectId: "t3-lantern" })
  })

  it("returns the same item when called again", async () => {
    const first = await start("thread-1")
    const second = await start("thread-1", { title: "Another title" })
    expect(second).toMatchObject({ created: false, linked: false })
    expect(second.item.id).toBe(first.item.id)
    expect(await t.ctx.db.select().from(items)).toHaveLength(1)
  })

  it("creates one item when calls race", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => start("thread-race")))
    const ids = new Set(results.map((r) => r.item.id))
    expect(ids.size).toBe(1)
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(await t.ctx.db.select().from(items)).toHaveLength(1)
  })

  it("links the given item and sets it in_progress", async () => {
    const item = await createItem(t.ctx, owner, { type: "bug", title: "Login loop" })
    const result = await start("thread-2", { itemId: item.id })
    expect(result).toMatchObject({ created: false, linked: true })
    expect(result.item).toMatchObject({ id: item.id, status: "in_progress", statusSetBy: "agent", version: 2 })
  })

  it("reopens a closed item when its thread starts again", async () => {
    const first = await start("thread-3")
    await updateItem(t.ctx, agent, first.item.id, first.item.version, { status: "done" })
    const again = await start("thread-3")
    expect(again.item).toMatchObject({ status: "in_progress", closedAt: null })
  })

  it("refuses a child thread with not_top_level", async () => {
    await expect(start("child", { parentThreadId: "parent" })).rejects.toMatchObject({ code: "not_top_level" })
    expect(await t.ctx.db.select().from(items)).toHaveLength(0)
  })

  it("refuses a thread whose item the owner deleted with suppressed", async () => {
    const first = await start("thread-4")
    await deleteItem(t.ctx, owner, first.item.id)
    await expect(start("thread-4")).rejects.toMatchObject({ code: "suppressed" })
  })

  it("refuses a thread linked to another item when itemId is given", async () => {
    await start("thread-5")
    const other = await createItem(t.ctx, owner, { type: "task", title: "Other" })
    await expect(start("thread-5", { itemId: other.id })).rejects.toMatchObject({ code: "conflict" })
    await expect(linkThread(t.ctx, agent, other.id, { threadId: "thread-5" })).rejects.toMatchObject({
      code: "conflict",
    })
  })

  it("refuses a title that looks like a secret", async () => {
    const title = `Rotate ${"AK"}IA${"Q2W3E4R5T6Y7U8I9"}`
    await expect(start("thread-6", { title })).rejects.toMatchObject({
      code: "secret_suspected",
      details: { rule: "aws_access_key" },
    })
  })
})
