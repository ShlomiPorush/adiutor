// Guard tests of the v3 style, adapted to this UI (skill v3-ui-style, references/v3-code/tests):
// - every popup comes from its shared builder (DS-24): a dialog, sheet, toast or other layer made
//   anywhere else fails, as does a CSS rule that floats a selector not listed here;
// - every page has a refresh of its own (SV-10), or is listed with the reason it has none;
// - no page formats a date itself (FW-9);
// - every text key the code uses exists in both locale files.
// Each check is a function over file texts, so the self-tests can show it catches a planted bypass.

import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import en from "../shared/locales/en.json"
import he from "../shared/locales/he.json"

const WEB = fileURLToPath(new URL(".", import.meta.url))

function sources(dir = WEB): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "public") continue
      Object.assign(out, sources(full))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
      out[relative(WEB, full).replaceAll("\\", "/")] = readFileSync(full, "utf8")
    }
  }
  return out
}

/** Source text without comments, so a rule explained in a comment does not count as code. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
}

// --- Popups (DS-24) ---

/** The files that may build a layer over the page, each with its reason. */
const BUILDERS: Record<string, string> = {
  "ui/Dialog.tsx": "the one dialog builder; on phones every dialog is a bottom sheet (DS-1, DS-24)",
  "ui/Toast.tsx": "the one toast (FB-2)",
  "ui/layers.ts":
    "creates the body-level root each layer renders into and owns Escape, Back and focus (DS-8, DS-10, DS-15)",
  "shell/MoreSheet.tsx": "the phone More sheet above the tab bar, which stays usable beside it (NL-9)",
  "shell/Bell.tsx":
    "the Needs attention window anchored under the bell on wide screens; a dialog-builder sheet on phones (NL-19)",
}

/** CSS selectors that may float above the page, each with its reason. */
const FLOATING_CSS: Record<string, string> = {
  ".ui-dialog-backdrop": "every dialog and phone sheet",
  ".ui-toast": "the toast",
  ".ui-attn-win": "the Needs attention window",
  ".ui-attn-backdrop": "the click-outside area of the Needs attention window",
  ".ui-moresheet": "the phone More sheet",
  ".ui-tabbar": "the phone tab bar, part of the frame",
  ".ui-savebar": "the save bar, part of the page",
}

const LAYER_PATTERNS: [string, RegExp][] = [
  ["a portal", /\bcreatePortal\s*\(/],
  ["a dialog role", /role\s*[=:]\s*\{?\s*["'](?:alert)?dialog["']/],
  ["a <dialog> element", /<dialog\b/],
  ["showModal()", /\.showModal\s*\(/],
  ["a popover attribute", /\bpopover\s*[=:]/],
  ["a layer frame class", /["'`\s]ui-(?:dialog|toast|attn-win|attn-backdrop|moresheet)(?:[-\s"'`]|$)/m],
  ["fixed positioning", /position\s*:\s*["']fixed["']|\.position\s*=\s*["']fixed["']/],
  ["the browser's alert, confirm or prompt", /(?<![\w.$])(?:window\.)?(?:alert|confirm|prompt)\s*\(/],
]

function popupViolations(files: Record<string, string>): string[] {
  const found: string[] = []
  for (const [file, text] of Object.entries(files)) {
    if (file in BUILDERS || file.startsWith("api/mock/")) continue
    // A <Dialog ...> call is the builder itself: its role and props are not a layer made by hand.
    let plain = code(text)
    for (let start = plain.indexOf("<Dialog"); start !== -1; start = plain.indexOf("<Dialog")) {
      plain = plain.slice(0, start) + plain.slice(start + openingTag(plain, start).length)
    }
    for (const [name, pattern] of LAYER_PATTERNS) {
      if (pattern.test(plain)) found.push(`${file}: ${name} outside the shared builders`)
    }
  }
  return found
}

/** The opening tag of a JSX element at `start`, braces balanced, so `() =>` inside a value does not end it. */
function openingTag(text: string, start: number): string {
  let depth = 0
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (char === "{") depth++
    else if (char === "}") depth--
    else if (char === ">" && depth === 0) return text.slice(start, index + 1)
  }
  return text.slice(start)
}

function dialogCallViolations(files: Record<string, string>): string[] {
  const found: string[] = []
  for (const [file, text] of Object.entries(files)) {
    for (const match of code(text).matchAll(/<Dialog\b/g)) {
      const tag = openingTag(code(text), match.index ?? 0)
      if (!/\bsize=/.test(tag)) found.push(`${file}: a Dialog without a size`)
      const question = /role="alertdialog"/.test(tag)
      if (question ? !/\bonCancel=/.test(tag) : !/\bonClose=/.test(tag))
        found.push(`${file}: a Dialog without its close function`)
    }
  }
  return found
}

function floatingCssViolations(css: string): string[] {
  const found: string[] = []
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "")
  for (const match of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? "").trim()
    const body = match[2] ?? ""
    const fixed = /position\s*:\s*fixed/.test(body)
    const zIndex = Number(/z-index\s*:\s*(\d+)/.exec(body)?.[1] ?? 0)
    const absoluteHigh = /position\s*:\s*absolute/.test(body) && zIndex >= 20
    if (!fixed && !absoluteHigh) continue
    for (const selector of selectors.split(",").map((part) => part.trim())) {
      const head = /^\.[\w-]+/.exec(selector)?.[0] ?? selector
      if (!(head in FLOATING_CSS)) found.push(`ui.css: ${selector} floats but is not a listed layer`)
    }
  }
  return found
}

// --- Page refresh (SV-10) ---

/** Pages without a refresh of their own, each with its reason. */
const NO_REFRESH: Record<string, string> = {
  NotFoundPage: "says the address names no page; it reads nothing",
  PairPage: "sends the owner token once; there is nothing to read before pairing",
}
/** Route elements that are not pages (Component is the element of each PAGES entry, checked by name above). */
const NOT_PAGES = new Set(["Root", "Shell", "ItemLink", "Component"])

function routedPages(routes: string): Record<string, string> {
  const imports = new Map<string, string>()
  for (const match of routes.matchAll(/import \{ (\w+) \} from "\.\/(pages\/\w+)\.tsx"/g))
    imports.set(match[1] ?? "", `${match[2]}.tsx`)
  const names = new Set<string>()
  for (const match of routes.matchAll(/Component: ([A-Z]\w*Page)\b/g)) names.add(match[1] ?? "")
  for (const match of routes.matchAll(/element: <(\w+) \/>/g)) names.add(match[1] ?? "")
  const pages: Record<string, string> = {}
  for (const name of names) {
    if (NOT_PAGES.has(name)) continue
    pages[name] = imports.get(name) ?? `missing import for ${name}`
  }
  return pages
}

const REFRESH = /\busePage(?:Infinite)?Query\(\s*\{[\s\S]*?\bevery:/

function refreshViolations(routes: string, files: Record<string, string>): string[] {
  const found: string[] = []
  for (const [name, file] of Object.entries(routedPages(routes))) {
    const text = files[file]
    if (text === undefined) {
      found.push(`${name}: ${file}`)
      continue
    }
    const refreshes = REFRESH.test(code(text))
    if (!refreshes && !(name in NO_REFRESH))
      found.push(`${name} (${file}) has no refresh of its own and is not listed in NO_REFRESH`)
    if (refreshes && name in NO_REFRESH) found.push(`${name} refreshes now: take it off NO_REFRESH`)
  }
  return found
}

// --- Dates (FW-9) ---

const DATE_HELPERS = new Set(["format/datetime.ts"])
const OWN_DATES =
  /\.toLocale(?:Date|Time)String\(|Intl\.DateTimeFormat|\.get(?:Hours|Minutes|Seconds|Date|Day|Month|FullYear)\(|\bhour12\b|\bhourCycle\b|\bdateStyle\b|\btimeStyle\b|new Date\([^)]*\)\.toLocaleString\(/

function dateViolations(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([file, text]) => !DATE_HELPERS.has(file) && OWN_DATES.test(code(text)))
    .map(([file]) => `${file} formats a date itself; use src/web/format/datetime.ts`)
}

// --- Locale keys ---

function hasKey(tree: unknown, key: string): boolean {
  let node: unknown = tree
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return false
    node = (node as Record<string, unknown>)[part]
  }
  return node !== undefined
}

function usedKeys(files: Record<string, string>): { plain: Set<string>; counted: Set<string> } {
  const plain = new Set<string>()
  const counted = new Set<string>()
  for (const text of Object.values(files)) {
    for (const match of text.matchAll(/\bt\(\s*"([\w.]+)"/g)) plain.add(match[1] ?? "")
    for (const match of text.matchAll(/\btc\(\s*"([\w.]+)"/g)) counted.add(match[1] ?? "")
    for (const match of text.matchAll(/allShownKey="([\w.]+)"/g)) counted.add(match[1] ?? "")
  }
  return { plain, counted }
}

// --- The tests ---

const files = sources()
const css = readFileSync(join(WEB, "styles/ui.css"), "utf8")
const routes = readFileSync(join(WEB, "routes.tsx"), "utf8")

describe("popups come from their shared builders (DS-24)", () => {
  it("no layer is built outside the builders, and every Dialog names its size and close", () => {
    expect(popupViolations(files)).toEqual([])
    expect(dialogCallViolations(files)).toEqual([])
  })

  it("only listed selectors float above the page", () => {
    expect(floatingCssViolations(css)).toEqual([])
  })

  it("every listed builder and floating selector still exists", () => {
    for (const file of Object.keys(BUILDERS)) expect(files[file], file).toBeDefined()
    for (const selector of Object.keys(FLOATING_CSS)) expect(css.includes(`${selector} {`), selector).toBe(true)
  })

  it("catches a planted bypass of each kind", () => {
    const page = (body: string) => ({ "pages/Planted.tsx": body })
    expect(popupViolations(page(`return <div role="dialog" aria-modal="true">x</div>`))).toHaveLength(1)
    expect(popupViolations(page(`return createPortal(<div />, document.body)`))).toHaveLength(1)
    expect(popupViolations(page(`if (window.confirm("Delete?")) remove()`))).toHaveLength(1)
    expect(popupViolations(page(`return <div className="ui-dialog-backdrop" />`))).toHaveLength(1)
    expect(popupViolations(page(`const style = { position: "fixed", inset: 0 }`))).toHaveLength(1)
    expect(popupViolations(page(`return <dialog open>x</dialog>`))).toHaveLength(1)
    expect(popupViolations(page(`await confirmDialog({ title: "x" })`))).toEqual([])
    expect(popupViolations(page(`<Dialog role="alertdialog" size="sm" onCancel={f}>x</Dialog>`))).toEqual([])
    expect(dialogCallViolations(page(`<Dialog title="x" onClose={() => close()}>body</Dialog>`))).toEqual([
      "pages/Planted.tsx: a Dialog without a size",
    ])
    expect(dialogCallViolations(page(`<Dialog size="sm" title="x">body</Dialog>`))).toEqual([
      "pages/Planted.tsx: a Dialog without its close function",
    ])
    expect(floatingCssViolations(`.ui-new-layer { position: fixed; inset: 0; }`)).toHaveLength(1)
    expect(floatingCssViolations(`.ui-tip { position: absolute; z-index: 40; }`)).toHaveLength(1)
    expect(floatingCssViolations(`.ui-pip { position: absolute; }`)).toEqual([])
  })
})

describe("every page has a refresh of its own (SV-10)", () => {
  it("each routed page reads with a pace, or is listed with its reason", () => {
    expect(refreshViolations(routes, files)).toEqual([])
  })

  it("every page listed without a refresh is still a page", () => {
    const pages = routedPages(routes)
    for (const name of Object.keys(NO_REFRESH)) expect(pages[name], name).toBeDefined()
  })

  it("catches a page without a refresh", () => {
    const plantedRoutes = `import { PlantedPage } from "./pages/PlantedPage.tsx"\nconst PAGES = [{ id: "x", path: "/x", Component: PlantedPage }]`
    expect(
      refreshViolations(plantedRoutes, { "pages/PlantedPage.tsx": "export function PlantedPage() { return null }" }),
    ).toHaveLength(1)
    expect(
      refreshViolations(plantedRoutes, {
        "pages/PlantedPage.tsx": "usePageQuery({ queryKey: k, queryFn: f, every: EVERY.live })",
      }),
    ).toEqual([])
  })
})

describe("dates go through the format helpers (FW-9)", () => {
  it("no page formats a date itself", () => {
    expect(dateViolations(files)).toEqual([])
  })

  it("catches a page that formats a date itself", () => {
    expect(dateViolations({ "pages/Planted.tsx": "new Date(at).toLocaleDateString()" })).toHaveLength(1)
    expect(dateViolations({ "pages/Planted.tsx": "new Intl.DateTimeFormat('en').format(d)" })).toHaveLength(1)
  })
})

describe("locale keys", () => {
  const { plain, counted } = usedKeys(files)

  it("every key the code uses exists in both languages", () => {
    const missing = [...plain].filter((key) => !hasKey(en, key) || !hasKey(he, key))
    expect(missing).toEqual([])
  })

  it("every counted key has one and other forms in both languages", () => {
    const missing = [...counted].filter(
      (key) =>
        !hasKey(en, `${key}.one`) ||
        !hasKey(en, `${key}.other`) ||
        !hasKey(he, `${key}.one`) ||
        !hasKey(he, `${key}.other`),
    )
    expect(missing).toEqual([])
  })

  it("finds the keys in the sources (the scan itself works)", () => {
    expect(plain.has("morning.title")).toBe(true)
    expect(counted.has("savebar.count")).toBe(true)
  })
})
