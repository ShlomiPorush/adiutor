import { type ActorKind, CLOSED_STATUSES, type ItemStatus } from "../../shared/enums.ts"

// The status rules of "Agent and sync rules" in docs/project-foundation.md, as pure functions.

/** T3 statuses that mean an agent works in the thread now. */
export const ACTIVE_T3_STATUSES = ["running", "starting", "queued", "preparing"] as const
export const WAITING_T3_STATUS = "waiting"

/** A settled thread without an item gets one only when it settled this recently. */
export const SETTLED_IMPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export type LinkState = { lastStatus: string | null; settled: boolean; lastActivityAt: Date | null }
export type ItemState = { status: ItemStatus; statusSetBy: ActorKind; statusSetAt: Date }

const isActive = (status: string | null) => (ACTIVE_T3_STATUSES as readonly string[]).includes(status ?? "")
const isClosed = (status: ItemStatus) => (CLOSED_STATUSES as readonly ItemStatus[]).includes(status)

/**
 * What all of an item's linked threads say together: any active → in_progress; otherwise any waiting →
 * waiting_on_you; otherwise all settled → done; otherwise nothing (a completed but unsettled thread
 * changes nothing).
 */
export function threadsVerdict(links: readonly LinkState[]): ItemStatus | null {
  if (links.length === 0) return null
  if (links.some((l) => isActive(l.lastStatus))) return "in_progress"
  if (links.some((l) => l.lastStatus === WAITING_T3_STATUS)) return "waiting_on_you"
  if (links.every((l) => l.settled)) return "done"
  return null
}

/**
 * The status the sync sets on an item, or null for no change. The owner wins: an owner's status set at
 * or after the latest activity of the item's threads stays. The sync never moves an item out of done or
 * not_relevant, and never sets done on an item in future or todo.
 */
export function syncDecision(item: ItemState, links: readonly LinkState[]): ItemStatus | null {
  const target = threadsVerdict(links)
  if (!target || target === item.status) return null
  if (isClosed(item.status)) return null
  if (target === "done" && (item.status === "future" || item.status === "todo")) return null
  if (item.statusSetBy === "owner") {
    const latest = Math.max(...links.map((l) => l.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY))
    if (!Number.isFinite(latest) || item.statusSetAt.getTime() >= latest) return null
  }
  return target
}

/** The status of an item the sync creates for a thread that has none. */
export function newItemStatus(thread: { status: string; settled: boolean }): ItemStatus {
  if (thread.settled) return "done"
  if (thread.status === WAITING_T3_STATUS) return "waiting_on_you"
  return "in_progress"
}

/**
 * Whether a thread without an item gets one: every unsettled thread does, whatever its age; a settled
 * one only when it settled in the last 7 days before the snapshot was collected.
 */
export function wantsItem(
  thread: { settled: boolean; settledAt?: Date | null; updatedAt: Date },
  collectedAt: Date,
): boolean {
  if (!thread.settled) return true
  const settledAt = thread.settledAt ?? thread.updatedAt
  return collectedAt.getTime() - settledAt.getTime() <= SETTLED_IMPORT_WINDOW_MS
}

/**
 * The top-level thread a child thread folds into: its parent's parent, and so on, as far as the snapshot
 * knows. A parent outside the snapshot is the answer itself.
 */
export function rootThreadId(
  threadId: string,
  parentOf: ReadonlyMap<string, string | null | undefined>,
): string | null {
  let current = parentOf.get(threadId)
  if (!current) return null
  for (let hops = 0; hops < 50; hops++) {
    const next = parentOf.get(current)
    if (!next) return current
    current = next
  }
  return current
}
