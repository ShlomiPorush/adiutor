import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { audit, comments, goals, items, itemThreads, projects, suppressions } from "../db/schema.ts"
import { agent, bot, createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import {
  getSettings,
  listSuppressions,
  pairDevice,
  removeSuppression,
  revokeAllDevices,
  updateSettings,
} from "./admin.ts"
import type { By } from "./context.ts"
import { addComment, captureItem, createItem, deleteItem, linkThread, updateItem } from "./items.ts"
import { createProject, decideProposal, deleteProject, proposeStage, updateProject } from "./projects.ts"
import { listProjects } from "./reads.ts"

let t: TestDatabase
const sync: By = { actor: { kind: "sync", label: "sync" }, source: "sync" }

beforeAll(async () => {
  t = await createTestDatabase("services", ["corp.example"])
})
afterAll(async () => {
  await t?.close()
})
beforeEach(async () => {
  await t.reset()
})

/** Runs a call that must fail with the given error code. */
async function refused(code: string, run: () => Promise<unknown>) {
  await expect(run()).rejects.toMatchObject({ code })
}

const auditRows = (entityId: string) => t.ctx.db.select().from(audit).where(eq(audit.entityId, entityId))

describe("items", () => {
  it("creates an item with an audit row in the same transaction", async () => {
    const project = await createProject(t.ctx, owner, { name: "Lighthouse" })
    const item = await createItem(t.ctx, agent, { projectId: project.id, type: "task", title: " Write  the plan " })
    expect(item).toMatchObject({ title: "Write the plan", status: "todo", version: 1, createdBy: "agent" })
    const rows = await auditRows(item.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: "item.create", actorKind: "agent", source: "mcp", before: null })
    expect((rows[0]?.after as { title?: string } | undefined)?.title).toBe("Write the plan")
  })

  it("rolls the item back when its audit row cannot be written", async () => {
    const before = await t.ctx.db.select().from(items)
    const broken = { actor: { kind: "agent", label: "agent" }, source: "nowhere" } as unknown as By
    await expect(createItem(t.ctx, broken, { type: "task", title: "Never stored" })).rejects.toThrow()
    expect(await t.ctx.db.select().from(items)).toHaveLength(before.length)
  })

  it("refuses a stale version with version_conflict and the current version", async () => {
    const item = await createItem(t.ctx, owner, { type: "task", title: "Concurrent" })
    await updateItem(t.ctx, owner, item.id, 1, { title: "First" })
    await expect(updateItem(t.ctx, agent, item.id, 1, { title: "Second" })).rejects.toMatchObject({
      code: "version_conflict",
      details: { currentVersion: 2 },
    })
    const updated = await updateItem(t.ctx, agent, item.id, 2, { status: "in_progress" })
    expect(updated).toMatchObject({ version: 3, status: "in_progress", statusSetBy: "agent" })
  })

  it("sets closed_at entering done or not_relevant and clears it on reopening", async () => {
    const item = await createItem(t.ctx, agent, { type: "bug", title: "Crash" })
    const done = await updateItem(t.ctx, agent, item.id, 1, { status: "done" })
    expect(done.closedAt).toBeInstanceOf(Date)
    const notRelevant = await updateItem(t.ctx, agent, item.id, 2, { status: "not_relevant" })
    expect(notRelevant.closedAt?.getTime()).toBe(done.closedAt?.getTime())
    const reopened = await updateItem(t.ctx, owner, item.id, 3, { status: "todo" })
    expect(reopened.closedAt).toBeNull()
    expect(reopened.statusSetBy).toBe("owner")
  })

  it("keeps severity on security items only", async () => {
    await refused("validation_failed", () => createItem(t.ctx, agent, { type: "bug", title: "Leak", severity: "high" }))
    const item = await createItem(t.ctx, agent, { type: "security", title: "Leak", severity: "high" })
    const retyped = await updateItem(t.ctx, agent, item.id, 1, { type: "bug" })
    expect(retyped.severity).toBeNull()
  })

  it("refuses an agent delete and lets the owner delete, suppressing the item's threads", async () => {
    const item = await createItem(t.ctx, agent, { type: "task", title: "Delete me" })
    await linkThread(t.ctx, agent, item.id, { threadId: "thread-a" })
    await linkThread(t.ctx, agent, item.id, { threadId: "thread-b" })
    for (const by of [agent, bot, sync]) await refused("forbidden", () => deleteItem(t.ctx, by, item.id))
    await refused("version_conflict", () => deleteItem(t.ctx, owner, item.id, 7))
    await deleteItem(t.ctx, owner, item.id, 1)
    expect(await t.ctx.db.select().from(items).where(eq(items.id, item.id))).toHaveLength(0)
    expect(await t.ctx.db.select().from(itemThreads)).toHaveLength(0)
    const s = await t.ctx.db.select().from(suppressions)
    expect(s.map((r) => [r.kind, r.externalId, r.label]).sort()).toEqual([
      ["thread", "thread-a", "Delete me"],
      ["thread", "thread-b", "Delete me"],
    ])
    expect((await auditRows(item.id)).map((r) => r.action)).toContain("item.delete")
  })

  it("refuses agent text that looks like a secret, naming the rule and never the text", async () => {
    const secret = `password=${"Winter"}2026!`
    const error = await createItem(t.ctx, agent, { type: "task", title: "Fix", body: `use ${secret}` }).catch((e) => e)
    expect(error).toMatchObject({ code: "secret_suspected", details: { rule: "secret_assignment", field: "body" } })
    expect(JSON.stringify(error)).not.toContain("Winter")
    expect(String(error.message)).not.toContain("Winter")
    const item = await createItem(t.ctx, agent, { type: "task", title: "Fix" })
    await refused("secret_suspected", () => addComment(t.ctx, agent, item.id, { text: "on app01.corp.example" }))
    await refused("secret_suspected", () => updateItem(t.ctx, agent, item.id, 1, { title: secret }))
    // The owner's own text is not refused.
    await addComment(t.ctx, owner, item.id, { text: "on app01.corp.example" })
  })

  it("captures quick notes as future ideas in the inbox", async () => {
    const item = await captureItem(t.ctx, bot, { text: "Try a dark theme\nwith larger type" })
    expect(item).toMatchObject({
      projectId: null,
      type: "idea",
      status: "future",
      title: "Try a dark theme",
      body: "Try a dark theme\nwith larger type",
      createdBy: "bot",
    })
  })

  it("links threads: idempotent for the same item, conflict for another, refused for a child thread", async () => {
    const a = await createItem(t.ctx, agent, { type: "task", title: "A" })
    const b = await createItem(t.ctx, agent, { type: "task", title: "B" })
    expect((await linkThread(t.ctx, agent, a.id, { threadId: "t-1" })).created).toBe(true)
    expect((await linkThread(t.ctx, agent, a.id, { threadId: "t-1" })).created).toBe(false)
    await refused("conflict", () => linkThread(t.ctx, agent, b.id, { threadId: "t-1" }))
    await refused("not_top_level", () => linkThread(t.ctx, agent, b.id, { threadId: "t-2", parentThreadId: "t-1" }))
  })

  it("refuses an agent linking a suppressed thread; the owner linking it removes the suppression", async () => {
    const item = await createItem(t.ctx, agent, { type: "task", title: "Gone" })
    await linkThread(t.ctx, agent, item.id, { threadId: "t-9" })
    await deleteItem(t.ctx, owner, item.id)
    const next = await createItem(t.ctx, agent, { type: "task", title: "Again" })
    await refused("suppressed", () => linkThread(t.ctx, agent, next.id, { threadId: "t-9" }))
    await linkThread(t.ctx, owner, next.id, { threadId: "t-9" })
    expect(await t.ctx.db.select().from(suppressions)).toHaveLength(0)
  })

  it("stores comments with their author", async () => {
    const item = await createItem(t.ctx, agent, { type: "task", title: "Commented" })
    const c = await addComment(t.ctx, agent, item.id, { text: "Done: the plan. Left: tests.", threadId: "t-1" })
    expect(c).toMatchObject({ authorKind: "agent", threadId: "t-1" })
    expect(await t.ctx.db.select().from(comments)).toHaveLength(1)
    await refused("not_found", () => addComment(t.ctx, agent, "00000000-0000-4000-8000-000000000000", { text: "x" }))
  })
})

describe("projects", () => {
  it("lets only the owner and the sync create projects; a new project has no stage", async () => {
    await refused("forbidden", () => createProject(t.ctx, agent, { name: "Agent made" }))
    await refused("forbidden", () => createProject(t.ctx, sync, { name: "Staged", stage: "poc" }))
    const p = await createProject(t.ctx, sync, { name: "Orchard Notes", t3ProjectId: "t3-orchard" })
    expect(p).toMatchObject({ slug: "orchard-notes", stage: null })
    const again = await createProject(t.ctx, owner, { name: "Orchard notes" })
    expect(again.slug).toBe("orchard-notes-2")
    await refused("conflict", () => createProject(t.ctx, owner, { name: "Dup", t3ProjectId: "t3-orchard" }))
  })

  it("refuses an agent stage change and other owner fields, and accepts where-we-are and goal", async () => {
    const p = await createProject(t.ctx, owner, { name: "Harbor" })
    await refused("forbidden", () => updateProject(t.ctx, agent, p.id, { stage: "production" }))
    await refused("forbidden", () => updateProject(t.ctx, agent, p.id, { name: "Renamed" }))
    await refused("forbidden", () => updateProject(t.ctx, bot, p.id, { stage: "idea" }))
    const updated = await updateProject(t.ctx, agent, p.id, { whereWeAre: "API done, UI next", goal: "First release" })
    expect(updated.whereWeAre).toBe("API done, UI next")
    expect(updated.stage).toBeNull()
    const staged = await updateProject(t.ctx, owner, p.id, { stage: "development" })
    expect(staged.stage).toBe("development")
  })

  it("closes the previous goal when an agent sets a new one, and counts progress on the current goal", async () => {
    const p = await createProject(t.ctx, owner, { name: "Goals" })
    await updateProject(t.ctx, agent, p.id, { goal: "Beta" })
    const [beta] = await t.ctx.db.select().from(goals).where(eq(goals.projectId, p.id))
    if (!beta) throw new Error("no goal")
    const one = await createItem(t.ctx, agent, { projectId: p.id, type: "task", title: "One", goalId: beta.id })
    await createItem(t.ctx, agent, { projectId: p.id, type: "task", title: "Two", goalId: beta.id })
    await updateItem(t.ctx, agent, one.id, 1, { status: "done" })
    let listed = (await listProjects(t.ctx)).find((x) => x.id === p.id)
    expect(listed?.goal).toMatchObject({ text: "Beta", done: 1, total: 2 })

    await updateProject(t.ctx, agent, p.id, { goal: "Launch" })
    const all = await t.ctx.db.select().from(goals).where(eq(goals.projectId, p.id))
    expect(all.find((g) => g.text === "Beta")?.closedAt).toBeInstanceOf(Date)
    expect(all.find((g) => g.text === "Launch")?.closedAt).toBeNull()
    listed = (await listProjects(t.ctx)).find((x) => x.id === p.id)
    expect(listed?.goal).toMatchObject({ text: "Launch", done: 0, total: 0 })
    await updateProject(t.ctx, agent, p.id, { goal: null })
    expect((await listProjects(t.ctx)).find((x) => x.id === p.id)?.goal).toBeNull()
  })

  it("lets agents propose a stage and only the owner decide it", async () => {
    const p = await createProject(t.ctx, owner, { name: "Proposal" })
    const proposal = await proposeStage(t.ctx, agent, p.id, { stage: "poc", reason: "A demo runs" })
    const same = await proposeStage(t.ctx, agent, p.id, { stage: "poc", reason: "A demo runs end to end" })
    expect(same.id).toBe(proposal.id)
    await refused("forbidden", () => decideProposal(t.ctx, agent, proposal.id, "accept"))
    const { project } = await decideProposal(t.ctx, owner, proposal.id, "accept")
    expect(project.stage).toBe("poc")
    await refused("conflict", () => decideProposal(t.ctx, owner, proposal.id, "reject"))
  })

  it("deletes a project only for the owner, only without items, and suppresses its T3 project", async () => {
    const p = await createProject(t.ctx, sync, { name: "Old", t3ProjectId: "t3-old" })
    const item = await createItem(t.ctx, agent, { projectId: p.id, type: "task", title: "Blocking" })
    await refused("forbidden", () => deleteProject(t.ctx, agent, p.id))
    await refused("conflict", () => deleteProject(t.ctx, owner, p.id))
    await deleteItem(t.ctx, owner, item.id)
    await deleteProject(t.ctx, owner, p.id)
    expect(await t.ctx.db.select().from(projects)).toHaveLength(0)
    const [s] = await listSuppressions(t.ctx, owner)
    expect(s).toMatchObject({ kind: "project", externalId: "t3-old", label: "Old" })
    await refused("forbidden", () => removeSuppression(t.ctx, agent, s?.id ?? ""))
    await removeSuppression(t.ctx, owner, s?.id ?? "")
    expect(await listSuppressions(t.ctx, owner)).toHaveLength(0)
  })
})

describe("settings and devices", () => {
  it("lets only the owner change settings", async () => {
    expect((await getSettings(t.ctx.db)).closedItemDays).toBe(7)
    await refused("forbidden", () => updateSettings(t.ctx, agent, { closedItemDays: 3 }))
    expect((await updateSettings(t.ctx, owner, { closedItemDays: 3 })).closedItemDays).toBe(3)
  })

  it("lets only the owner pair and end devices", async () => {
    await refused("forbidden", () => pairDevice(t.ctx, agent, "Phone"))
    await pairDevice(t.ctx, owner, "Phone")
    await refused("forbidden", () => revokeAllDevices(t.ctx, agent))
    expect(await revokeAllDevices(t.ctx, owner)).toBe(1)
  })
})
