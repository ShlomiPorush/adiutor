// Audit entries in words: the action by its locale label (or its code when the UI does not know
// it yet) and each changed field as "field: before -> after", with codes written as their labels.

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

export function actionText(language: Language, entry: AuditEntry): string {
  const key = `audit.action.${entry.action.replace(/\./g, "_")}`
  return hasKey(language, key) ? translate(language, key) : entry.action
}

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
