// The activity search in words (docs/api.md, Audit filters): besides the stored fields, a search matches the
// labels the owner reads in the request's language. The map goes from the code lists to their locale keys
// (dots written as underscores), never back by splitting a key, so a key always names its own code.

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, type Language } from "./enums.ts"
import en from "./locales/en.json"
import he from "./locales/he.json"

type AuditLabels = { action: Record<string, string>; entity: Record<string, string> }
const LABELS: Record<Language, AuditLabels> = { en: en.audit, he: he.audit }

/** The locale key of an action code: `item.create` is `item_create`. */
export const actionKey = (code: string) => code.replace(/\./g, "_")

const fold = (language: Language, text: string) => text.trim().toLocaleLowerCase(language)

/**
 * The action codes and entity types whose label in `language` contains `text`, case-insensitive. Empty text
 * matches nothing: a search with no words is no search.
 */
export function auditCodesMatching(language: Language, text: string): { actions: string[]; entityTypes: string[] } {
  const wanted = fold(language, text)
  if (!wanted) return { actions: [], entityTypes: [] }
  const labels = LABELS[language]
  const matches = (label: string | undefined) => label !== undefined && fold(language, label).includes(wanted)
  return {
    actions: AUDIT_ACTIONS.filter((code) => matches(labels.action[actionKey(code)])),
    entityTypes: AUDIT_ENTITY_TYPES.filter((type) => matches(labels.entity[type])),
  }
}
