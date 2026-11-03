// Audit entries in words: the action by its locale label (or its code when the UI does not know
// it yet) and each changed field as "field: before -> after", with codes written as their labels.

import { AGENT_LABEL } from "../../shared/api.ts"
import { actionKey } from "../../shared/audit-search.ts"
import type { ActorKind } from "../../shared/enums.ts"
import type { AuditEntry } from "../api/types.ts"
import { hasKey, type Language, translate } from "../i18n/i18n.tsx"

const CODED: Record<string, string> = { status: "itemStatus", stage: "stage", type: "itemType", severity: "severity" }
const SHOWN = [
  "status",
  "stage",
  "type",
  "severity",
  "title",
  "projectName",
  "whereWeAre",
  "goal",
  "name",
  "language",
  "closedItemDays",
  "label",
]
const MAX_TEXT = 80

export type Change = { field: string; before: string; after: string }

function valueText(language: Language, field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "-"
  const group = CODED[field]
  if (group && typeof value === "string" && hasKey(language, `${group}.${value}`))
    return translate(language, `${group}.${value}`)
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value)
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text
}

/** An action code in words, or the code itself when the UI does not know it. */
export function actionLabel(language: Language, action: string): string {
  const key = `audit.action.${actionKey(action)}`
  return hasKey(language, key) ? translate(language, key) : action
}

export function actionText(language: Language, entry: AuditEntry): string {
  return actionLabel(language, entry.action)
}

/**
 * The Activity list of one actor, for a link from where the actor shows (audit A-2, NL-12, NL-13): an agent's
 * own rows by its label, the sync's by its kind. A drill-down sets only that filter. Null for anyone else.
 */
export function actorActivity(kind: ActorKind, label: string): string | null {
  if (kind === "agent" && AGENT_LABEL.test(label)) return `/activity?${new URLSearchParams({ agent: label })}`
  if (kind === "sync") return "/activity?actorKind=sync"
  return null
}

/** The Activity list of one item (the item dialog's history). */
export const itemActivity = (itemId: string) => `/activity?${new URLSearchParams({ itemId })}`

export function changesOf(language: Language, entry: AuditEntry): Change[] {
  // A creation or a deletion has one side only: the entry's name says what it was, not a change.
  if (!entry.before || !entry.after) return []
  const before = entry.before
  const after = entry.after
  const fields = SHOWN.filter((field) => field in before || field in after)
  const changes: Change[] = []
  for (const field of fields) {
    const from = before[field]
    const to = after[field]
    if (JSON.stringify(from) === JSON.stringify(to)) continue
    const label = hasKey(language, `audit.field.${field}`) ? translate(language, `audit.field.${field}`) : field
    changes.push({ field: label, before: valueText(language, field, from), after: valueText(language, field, to) })
  }
  return changes
}
