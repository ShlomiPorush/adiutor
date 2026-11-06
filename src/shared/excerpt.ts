// The excerpt a notes list shows: the server answers it (docs/api.md, NoteSummary) and the mock builds it the
// same way.

/** The start of a Markdown body as plain text on one line: link and image text kept, markup marks dropped. */
export function plainExcerpt(body: string, max = 240): string {
  const plain = body
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, "")
    .replace(/`{3,}[^\n]*/g, "")
    .replace(/[*~`]+/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}
