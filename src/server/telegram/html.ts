// Telegram HTML (parse mode HTML). Only `html`, `fill` and `TelegramHtml.join` make it, so every value from
// outside was escaped on the way in. The sender accepts nothing else.

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/**
 * Bidirectional controls (embeddings, overrides, isolates, marks) and other control characters. In a title
 * they could reorder the rest of the line; line breaks would add lines.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]+/g

/** A value from outside as one line of plain text: controls removed, spaces collapsed, at most `max` characters. */
export function oneLine(text: string, max = 80): string {
  const clean = text.replace(UNSAFE, " ").replace(/\s+/g, " ").trim()
  const chars = [...clean]
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join("")}…`
}

export class TelegramHtml {
  private constructor(private readonly text: string) {}

  toString() {
    return this.text
  }

  static template(strings: readonly string[], values: readonly unknown[]) {
    return new TelegramHtml(strings.reduce((out, s, i) => out + s + (i < values.length ? part(values[i]) : ""), ""))
  }

  static join(parts: readonly TelegramHtml[], separator = "\n") {
    return new TelegramHtml(parts.map((p) => p.text).join(escapeHtml(separator)))
  }
}

function part(value: unknown): string {
  return value instanceof TelegramHtml ? String(value) : escapeHtml(String(value))
}

/** Builds Telegram HTML: the template's own text is markup, every value is escaped unless it is TelegramHtml. */
export const html = (strings: TemplateStringsArray, ...values: unknown[]) => TelegramHtml.template(strings, values)

/** A link. The URL is one this server built from its public URL; the label is escaped. */
export const link = (href: string, label: unknown) => html`<a href="${href}">${label}</a>`

/**
 * A locale text with `{name}` placeholders. The text itself is escaped too: locale files hold plain text,
 * never markup. An unknown placeholder stays as written, so a missing value shows instead of vanishing.
 */
export function fill(template: string, values: Record<string, unknown> = {}): TelegramHtml {
  const strings: string[] = []
  const parts: unknown[] = []
  let last = 0
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const name = match[1] ?? ""
    if (!(name in values)) continue
    strings.push(escapeHtml(template.slice(last, match.index)))
    parts.push(values[name])
    last = match.index + match[0].length
  }
  strings.push(escapeHtml(template.slice(last)))
  return TelegramHtml.template(strings, parts)
}
