// @vitest-environment happy-dom
// The shared picker and the Sort button under React's StrictMode, as `main.tsx` runs them in development
// (MP-1, MP-4, TB-28, R4): the keyboard opens, moves, jumps by type-ahead and picks; a search narrows a long
// list; Escape and Back with a picker inside a dialog close only the picker; the focus comes back to the
// button; and the Projects page's Sort button and its column headers show and set one order.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, type ReactNode, StrictMode, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import en from "../../shared/locales/en.json"
import { api, qk } from "../api/endpoints.ts"
import type { ProjectListEntry } from "../api/types.ts"
import { I18nProvider } from "../i18n/i18n.tsx"
import { ProjectsPage } from "../pages/ProjectsPage.tsx"
import { Dialog } from "./Dialog.tsx"
import { layerCount } from "./layers.ts"
import { filterOptions, Picker, type PickerOption, typeAhead } from "./Picker.tsx"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let mounted: { root: Root; host: HTMLElement } | null = null

async function render(ui: ReactNode, queryClient = new QueryClient()): Promise<void> {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted = { root, host }
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <I18nProvider>{ui}</I18nProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    )
  })
  await frames()
}

/** Lets the layer's focus move, which waits for the next frame. */
async function frames(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

async function press(key: string, target: Element | null = document.activeElement): Promise<void> {
  await act(async () => {
    target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  })
  await frames()
}

async function click(target: Element | null | undefined): Promise<void> {
  await act(async () => {
    ;(target as HTMLElement | null)?.click()
  })
  await frames()
}

/** Text without the isolates that wrap each filled value. */
const plain = (text: string | null | undefined) => text?.replace(/[\u2068\u2069]/g, "")
const fill = (text: string, vars: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? "")

const focused = () => document.activeElement as HTMLElement | null
const listbox = () => document.body.querySelector('[role="listbox"]')
const options = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))

beforeEach(() => {
  localStorage.setItem("mikud.language", "en")
})

afterEach(async () => {
  if (mounted) {
    const { root, host } = mounted
    mounted = null
    await act(async () => root.unmount())
    host.remove()
  }
  await frames()
  localStorage.clear()
  vi.restoreAllMocks()
})

const STAGES: PickerOption[] = [
  { value: "all", label: "All", hint: "9" },
  { value: "idea", label: "Idea", hint: "2" },
  { value: "poc", label: "POC", hint: "1" },
  { value: "development", label: "Development", hint: "3" },
  { value: "production", label: "Production", hint: "2" },
  { value: "frozen", label: "Frozen", hint: "1" },
]

/** Invented project names, more than ten, so the picker shows its search. */
const GARDENS = [
  "Apple orchard",
  "Bamboo grove",
  "Cedar hedge",
  "Daisy border",
  "Elm avenue",
  "Fern corner",
  "Garden shed",
  "Herb spiral",
  "Iris pond",
  "Juniper path",
  "Kale bed",
  "Lavender row",
].map((name, index) => ({ value: `p${index}`, label: name }))

function StagePicker({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("all")
  return (
    <Picker
      label="Stage"
      value={value}
      defaultValue="all"
      options={STAGES}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

describe("the picker by keyboard", () => {
  it("opens on ArrowDown, moves, stops at the ends, picks with Enter and gives the focus back", async () => {
    const picked = vi.fn()
    await render(<StagePicker onChange={picked} />)
    const button = document.body.querySelector<HTMLButtonElement>("button.ui-picker-btn")
    expect(button?.textContent).toContain("Stage:")
    expect(button?.getAttribute("aria-haspopup")).toBe("listbox")
    button?.focus()

    await press("ArrowDown", button)
    expect(listbox()).not.toBeNull()
    expect(button?.getAttribute("aria-expanded")).toBe("true")
    expect(button?.getAttribute("aria-controls")).toBe(listbox()?.id)
    // The chosen option takes the focus.
    expect(focused()?.textContent).toContain("All")
    expect(focused()?.getAttribute("aria-selected")).toBe("true")

    await press("ArrowUp")
    expect(focused()?.textContent).toContain("All")
    await press("ArrowDown")
    expect(focused()?.textContent).toContain("Idea")
    await press("End")
    expect(focused()?.textContent).toContain("Frozen")
    await press("ArrowDown")
    expect(focused()?.textContent).toContain("Frozen")
    await press("Home")
    expect(focused()?.textContent).toContain("All")
    await press("ArrowDown")
    await press("ArrowDown")

    await press("Enter")
    expect(picked).toHaveBeenCalledWith("poc")
    expect(listbox()).toBeNull()
    expect(layerCount()).toBe(0)
    expect(focused()).toBe(button)
    expect(button?.textContent).toContain("POC")
    // Not at its default: the pill is drawn set.
    expect(button?.hasAttribute("data-set")).toBe(true)
  })

  it("jumps to the next option that starts with the typed letters", async () => {
    await render(<StagePicker onChange={() => {}} />)
    const button = document.body.querySelector<HTMLButtonElement>("button.ui-picker-btn")
    await click(button)
    await press("p")
    expect(focused()?.textContent).toContain("POC")
    // The same letter again moves on to the next match.
    await press("p")
    expect(focused()?.textContent).toContain("Production")
    await press("f")
    expect(focused()?.textContent).toContain("Frozen")
    await press(" ")
    expect(button?.textContent).toContain("Frozen")
  })

  it("closes on a second click of its button and on Tab, with the focus on the button", async () => {
    await render(<StagePicker onChange={() => {}} />)
    const button = document.body.querySelector<HTMLButtonElement>("button.ui-picker-btn")
    await click(button)
    expect(listbox()).not.toBeNull()
    await press("Tab")
    expect(listbox()).toBeNull()
    expect(focused()).toBe(button)
  })

  it("type-ahead and the search compare loosely", () => {
    expect(typeAhead(["Idea", "POC", "Production"], "p", 0)).toBe(1)
    expect(typeAhead(["Idea", "POC", "Production"], "p", 1)).toBe(2)
    expect(typeAhead(["Idea", "POC", "Production"], "pr", 1)).toBe(2)
    expect(typeAhead(["Idea", "POC", "Production"], "pp", 1)).toBe(2)
    expect(typeAhead(["Idea", "POC"], "x", 0)).toBe(-1)
    expect(filterOptions([{ value: "1", label: "New_York" }], "new york")).toHaveLength(1)
    expect(filterOptions(GARDENS, "  ")).toHaveLength(GARDENS.length)
  })
})

describe("the picker's search (MP-4)", () => {
  it("shows above more than ten choices, narrows them, picks the first match on Enter, and clears on close", async () => {
    const picked = vi.fn()
    await render(
      <>
        <span id="field-label">Project</span>
        <Picker
          variant="field"
          labelledBy="field-label"
          label="Project"
          searchLabel="Search projects"
          value="p0"
          options={GARDENS}
          onChange={picked}
        />
      </>,
    )
    const button = document.body.querySelector<HTMLButtonElement>("button.ui-select-btn")
    expect(button?.getAttribute("aria-labelledby")).toMatch(/^field-label /)
    await click(button)
    const search = document.body.querySelector<HTMLInputElement>('input[type="search"]')
    expect(search).not.toBeNull()
    expect(focused()).toBe(search)
    expect(search?.getAttribute("aria-label")).toBe("Search projects")
    expect(options()).toHaveLength(GARDENS.length)

    const type = async (text: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
        setter?.call(search, text)
        search?.dispatchEvent(new Event("input", { bubbles: true }))
      })
    }
    await type("GAR")
    expect(options().map((option) => option.textContent)).toEqual(["Garden shed"])
    await type("zzz")
    expect(options()).toHaveLength(0)
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe(en.picker.noMatches)
    // With nothing left Enter does nothing.
    await press("Enter", search)
    expect(picked).not.toHaveBeenCalled()
    expect(listbox()).not.toBeNull()

    await type("e")
    await press("ArrowDown", search)
    expect(focused()?.getAttribute("role")).toBe("option")
    // Up from the first option goes back to the search.
    await press("ArrowUp")
    expect(focused()).toBe(search)
    await press("Enter", search)
    expect(picked).toHaveBeenCalledWith("p0")
    expect(listbox()).toBeNull()
    expect(focused()).toBe(button)

    await click(button)
    expect(document.body.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("")
    expect(options()).toHaveLength(GARDENS.length)
  })

  it("has no search with ten choices or fewer", async () => {
    await render(<StagePicker onChange={() => {}} />)
    await click(document.body.querySelector("button.ui-picker-btn"))
    expect(document.body.querySelector('input[type="search"]')).toBeNull()
  })
})

function DialogWithPicker({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState("p1")
  return (
    <Dialog title="Quick add" size="sm" onClose={onClose}>
      <span id="dialog-field">Project</span>
      <Picker
        variant="field"
        labelledBy="dialog-field"
        label="Project"
        value={value}
        options={GARDENS}
        onChange={setValue}
      />
    </Dialog>
  )
}

describe("a picker inside a dialog (DS-8, DS-10, R4)", () => {
  it("Escape closes only the picker, and the dialog keeps the focus on its button", async () => {
    const closeDialog = vi.fn()
    await render(<DialogWithPicker onClose={closeDialog} />)
    const button = document.body.querySelector<HTMLButtonElement>("button.ui-select-btn")
    await click(button)
    expect(layerCount()).toBe(2)
    // The dialog behind the open picker is inert.
    expect(document.body.querySelector<HTMLElement>(".ui-dialog-backdrop")?.inert).toBe(true)

    await press("Escape")
    expect(listbox()).toBeNull()
    expect(closeDialog).not.toHaveBeenCalled()
    expect(layerCount()).toBe(1)
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.querySelector<HTMLElement>(".ui-dialog-backdrop")?.inert).toBeFalsy()
    expect(focused()).toBe(button)

    // A second Escape closes the dialog.
    await press("Escape")
    expect(closeDialog).toHaveBeenCalledTimes(1)
  })

  it("Back closes only the picker, and the dialog keeps its history entry", async () => {
    const closeDialog = vi.fn()
    const back = vi.spyOn(history, "back").mockImplementation(() => {})
    await render(<DialogWithPicker onClose={closeDialog} />)
    const button = document.body.querySelector<HTMLButtonElement>("button.ui-select-btn")
    await click(button)
    expect(listbox()).not.toBeNull()

    const push = vi.spyOn(history, "pushState")
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }))
    })
    await frames()
    expect(listbox()).toBeNull()
    expect(closeDialog).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    // The dialog still holds an entry, so the next Back closes it rather than leaving the page.
    expect(push).toHaveBeenCalledTimes(1)
    expect(back).not.toHaveBeenCalled()
    expect(focused()).toBe(button)

    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }))
    })
    expect(closeDialog).toHaveBeenCalledTimes(1)
  })

  it("a press beside the picker closes the picker, not the dialog", async () => {
    const closeDialog = vi.fn()
    await render(<DialogWithPicker onClose={closeDialog} />)
    await click(document.body.querySelector("button.ui-select-btn"))
    const backdrop = document.body.querySelector<HTMLElement>(".ui-picker-backdrop")
    await act(async () => {
      backdrop?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
      backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }))
    })
    await frames()
    expect(listbox()).toBeNull()
    expect(closeDialog).not.toHaveBeenCalled()
    expect(layerCount()).toBe(1)
  })
})

function project(name: string, fields: Partial<ProjectListEntry>): ProjectListEntry {
  return {
    id: `id-${name}`,
    name,
    slug: name.toLowerCase(),
    t3ProjectId: null,
    githubRepo: null,
    stage: "development",
    whereWeAre: null,
    openIssuesCount: null,
    openIssuesAsOf: null,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    goal: null,
    openItems: 0,
    openProposals: 0,
    ...fields,
  }
}

describe("the Projects page's Sort button and headers share one order (TB-1, TB-28)", () => {
  it("a header click shows in the Sort menu, and a choice in the menu shows in the headers", async () => {
    const projects = [
      project("Birch walk", { openItems: 2 }),
      project("Aster bed", { openItems: 5 }),
      project("Clover lawn", { openItems: 1 }),
    ]
    vi.spyOn(api, "projects").mockResolvedValue(projects)
    const queryClient = new QueryClient()
    queryClient.setQueryData(qk.projects, projects)
    await render(<ProjectsPage />, queryClient)

    const names = () => Array.from(document.body.querySelectorAll(".ui-td-first b")).map((cell) => cell.textContent)
    const sortButton = () => document.body.querySelector<HTMLButtonElement>(".ui-list-summary .ui-sort-btn-icon")
    const header = (label: string) =>
      Array.from(document.body.querySelectorAll<HTMLButtonElement>(".ui-tr-head .ui-sort")).find((button) =>
        button.textContent?.startsWith(label),
      )
    const state = (label: string) => header(label)?.parentElement?.getAttribute("data-sort-state")

    // The default order: most open items first, and the button has no dot.
    expect(names()).toEqual(["Aster bed", "Birch walk", "Clover lawn"])
    expect(plain(sortButton()?.getAttribute("aria-label"))).toBe(
      fill(en.sort.button, { column: en.projects.colOpen, order: en.sort.words.number.desc }),
    )
    expect(sortButton()?.hasAttribute("data-set")).toBe(false)

    // A header click: the button names the new order and shows its dot.
    await click(header(en.projects.colName))
    expect(state(en.projects.colName)).toBe("ascending")
    expect(names()).toEqual(["Aster bed", "Birch walk", "Clover lawn"])
    expect(sortButton()?.getAttribute("aria-label")).toContain(en.sort.words.text.asc)
    expect(sortButton()?.hasAttribute("data-set")).toBe(true)

    // The menu opens on the checked column, the one the header chose.
    await click(sortButton())
    const panel = document.body.querySelector<HTMLElement>('.ui-picker-panel[role="dialog"]')
    expect(plain(panel?.getAttribute("aria-label"))).toBe(fill(en.sort.panel, { name: en.projects.sortName }))
    expect((focused() as HTMLInputElement | null)?.checked).toBe(true)
    expect(focused()?.parentElement?.textContent).toBe(en.projects.colName)

    // A choice in the menu applies at once, the menu stays open, and the headers follow.
    const order = Array.from(panel?.querySelectorAll<HTMLLabelElement>("label") ?? []).find(
      (label) => label.textContent === en.sort.words.text.desc,
    )
    await click(order?.querySelector("input"))
    expect(document.body.querySelector('.ui-picker-panel[role="dialog"]')).not.toBeNull()
    expect(state(en.projects.colName)).toBe("descending")
    expect(names()).toEqual(["Clover lawn", "Birch walk", "Aster bed"])

    const open = Array.from(panel?.querySelectorAll<HTMLLabelElement>("label") ?? []).find(
      (label) => label.textContent === en.projects.colOpen,
    )
    await click(open?.querySelector("input"))
    expect(state(en.projects.colOpen)).toBe("descending")
    expect(state(en.projects.colName)).toBe("none")
    expect(sortButton()?.hasAttribute("data-set")).toBe(false)

    await press("Escape")
    expect(document.body.querySelector(".ui-picker-panel")).toBeNull()
    expect(focused()).toBe(sortButton())
  })
})
