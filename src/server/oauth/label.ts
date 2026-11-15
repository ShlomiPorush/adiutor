/**
 * A script's name for itself, sent with its device code request (`client_label`, S7): kept only when it is plain text
 * (letters, marks, digits, spaces and . _ - ( ) @ : /), 1 to 60 characters after NFC normalization and trimming.
 * Anything else (control or direction marks, quotes, markup) drops it, and the caller names it "Script". It is the
 * agent's own word, never proof of what it is.
 */
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const label = raw.normalize("NFC").trim()
  const length = [...label].length
  if (length < 1 || length > 60) return null
  return /^[\p{L}\p{M}\p{N} ._\-()@:/]+$/u.test(label) ? label : null
}
