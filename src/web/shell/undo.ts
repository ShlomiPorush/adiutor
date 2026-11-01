// What Undo sends after a one-click item change: every field the change altered, back to its value
// before. The server may change more than was asked (a type other than security drops the severity,
// a move to another project drops the goal), so the patch comes from comparing before and after.

import type { Item, ItemPatch } from "../api/types.ts"

export const UNDO_FIELDS = ["status", "type", "severity", "projectId", "goalId"] as const

export type UndoState = Pick<Item, (typeof UNDO_FIELDS)[number]>

export function undoPatch(before: UndoState, after: UndoState): ItemPatch {
  const patch: Record<string, unknown> = {}
  for (const field of UNDO_FIELDS) if (before[field] !== after[field]) patch[field] = before[field]
  return patch as ItemPatch
}
