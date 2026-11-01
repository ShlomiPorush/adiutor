// The version an unsaved title or body draft is based on. A save sends it, so a change someone else
// made while the owner typed answers version_conflict instead of being overwritten. A background
// refresh never moves it; only the owner's own one-click changes in the same dialog do.

/** The base when the owner starts typing: kept once set, else the version on screen. */
export function draftBase(base: number | null, shownVersion: number): number {
  return base ?? shownVersion
}

/** The version a save sends: the draft's base, or the version on screen when nothing was typed yet. */
export function saveVersion(base: number | null, shownVersion: number): number {
  return base ?? shownVersion
}

/**
 * After the owner's own change in the dialog (status, type, severity, project, goal; never the title
 * or body), from version `before` to `next`: the base follows only when that change started from it.
 */
export function afterOwnChange(base: number | null, before: number, next: number): number | null {
  return base !== null && base === before ? next : base
}
