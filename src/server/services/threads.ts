import { eq } from "drizzle-orm"
import { itemThreads, projects } from "../db/schema.ts"
import { AppError } from "../errors.ts"
import { type By, type Ctx, checkAgentText, inLinkTx, type Tx } from "./context.ts"
import {
  cleanTitle,
  createItemTx,
  getItemRow,
  type ItemRow,
  insertLinkTx,
  isSuppressed,
  refuseChildThread,
  updateItemTx,
} from "./items.ts"

export type StartThreadInput = {
  threadId: string
  parentThreadId: string | null | undefined
  projectId?: string | null
  t3ProjectId?: string | null
  title: string
  itemId?: string | null
}

export type StartThreadResult = { item: ItemRow; created: boolean; linked: boolean }

/** Thrown inside the transaction when another call linked the thread first; the retry finds that link. */
class LostRace extends Error {}

/**
 * Start of a T3 thread, in one transaction: finds the item linked to the thread, or links the given
 * item, or creates one; then sets it in_progress. The unique thread id makes a retry or a race return the
 * existing item. A child thread is refused with `not_top_level`; a thread whose item the owner deleted
 * with `suppressed`.
 */
export async function startThread(ctx: Ctx, by: By, input: StartThreadInput): Promise<StartThreadResult> {
  refuseChildThread(input.parentThreadId)
  checkAgentText(ctx, by, { title: input.title })
  const title = cleanTitle(input.title)
  for (let attempt = 0; ; attempt++) {
    try {
      return await inLinkTx(ctx, (tx) => startOnce(ctx, tx, by, input, title))
    } catch (error) {
      if (error instanceof LostRace && attempt < 2) continue
      if (error instanceof LostRace) throw new AppError("conflict", "The thread was linked at the same time. Retry.")
      throw error
    }
  }
}

async function startOnce(ctx: Ctx, tx: Tx, by: By, input: StartThreadInput, title: string) {
  const [existing] = await tx.select().from(itemThreads).where(eq(itemThreads.threadId, input.threadId))
  if (existing) {
    if (input.itemId && input.itemId !== existing.itemId)
      throw new AppError("conflict", "This thread is linked to another item.", { itemId: existing.itemId })
    const item = await inProgress(ctx, tx, by, await getItemRow(tx, existing.itemId))
    return { item, created: false, linked: false }
  }
  if (await isSuppressed(tx, "thread", input.threadId))
    throw new AppError("suppressed", "The owner deleted the item of this thread; it is not tracked again.")

  const link = { threadId: input.threadId, parentThreadId: null, t3ProjectId: input.t3ProjectId ?? null, title }
  if (input.itemId) {
    const item = await getItemRow(tx, input.itemId)
    if (!(await insertLinkTx(ctx, tx, by, item.id, link))) throw new LostRace()
    return { item: await inProgress(ctx, tx, by, item), created: false, linked: true }
  }

  const projectId = input.projectId ?? (await projectForT3(tx, input.t3ProjectId))
  const item = await createItemTx(ctx, tx, by, { projectId, type: "task", status: "in_progress", title })
  // Another call linked the thread between our read and our insert: undo this item and use theirs.
  if (!(await insertLinkTx(ctx, tx, by, item.id, link))) throw new LostRace()
  return { item, created: true, linked: true }
}

async function projectForT3(tx: Tx, t3ProjectId: string | null | undefined): Promise<string | null> {
  if (!t3ProjectId) return null
  const [row] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.t3ProjectId, t3ProjectId))
  return row?.id ?? null
}

/** The agent starts work: the item is in_progress (reopened when it was closed). */
async function inProgress(ctx: Ctx, tx: Tx, by: By, item: ItemRow): Promise<ItemRow> {
  if (item.status === "in_progress") return item
  return updateItemTx(ctx, tx, by, item.id, item.version, { status: "in_progress" })
}
