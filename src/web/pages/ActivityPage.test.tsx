// @vitest-environment happy-dom
// The Activity page's filters under StrictMode, against a stand-in server that filters and counts as docs/api.md
// says (v3 MP-6, TB-7, TB-17, TB-18, SR-10, NL-3; R1 to R6 of the partner review): the address holds the filters
// and drops what the API would refuse; the count line shows the server's total, not the rows loaded; a Who count
// is what choosing it lists; a change of filters starts from the first page and the first row, while a refresh
// keeps the place; an answer for older filters never shows; the search waits for a pause, and Back or Clear drop
// a search still on its way; a failed refresh shows no counts. The data is invented.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ACTOR_KINDS, type ActorKind } from "../../shared/enums.ts"
import en from "../../shared/locales/en.json"
import { setTransport, type TransportRequest, type TransportResponse } from "../api/client.ts"
import { qk } from "../api/endpoints.ts"
import type { AuditCounts, AuditEntry } from "../api/types.ts"
import { I18nProvider } from "../i18n/i18n.tsx"
import { ConfirmHost } from "../ui/confirm.tsx"
import { ToastHost } from "../ui/Toast.tsx"
import { UnsavedProvider } from "../ui/unsaved.tsx"
import { ActivityPage, filtersFromParams } from "./ActivityPage.tsx"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ITEM = "0b9f3c1e-5a2d-4c8e-9f1a-2b3c4d5e6f70"
const PROJECT = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
const actors: { kind: ActorKind; label: string }[] = [
  { kind: "owner", label: "owner.name" },
  { kind: "agent", label: "agent:codex" },
  { kind: "agent", label: "agent:claude" },
  { kind: "sync", label: "sync" },
]
/** 120 changes, newest first: four actors in turn, every third one a creation. */
const ROWS: AuditEntry[] = Array.from({ length: 120 }, (_, index) => {
  const actor = actors[index % actors.length] ?? { kind: "owner", label: "owner.name" }
  return {
    id: 120 - index,
    at: new Date(Date.UTC(2026, 10, 2, 7, 0) - index * 60_000).toISOString(),
    actorKind: actor.kind,
    actorLabel: actor.label,
    action: index % 3 === 0 ? "item.create" : "item.update",
    entityType: "item",
    entityId: index % 10 === 0 ? ITEM : `item-${index}`,
    before: null,
    after: { title: `Bed ${index}` },
    source: "ui",
  }
})

type Facet = "actorKind" | "agent" | "action"
function matches(params: URLSearchParams, omit: Facet[] = []) {
  const get = (key: string) => params.get(key) ?? undefined
  return (row: AuditEntry) =>
    (!get("actorKind") || omit.includes("actorKind") || row.actorKind === get("actorKind")) &&
    (!get("agent") || omit.includes("agent") || (row.actorKind === "agent" && row.actorLabel === get("agent"))) &&
    (!get("action") || omit.includes("action") || row.action === get("action")) &&
    (!get("itemId") || row.entityId === get("itemId")) &&
    (!get("q") ||
      String(row.after?.title)
        .toLowerCase()
        .includes(String(get("q")).toLowerCase()))
}

/** The stand-in server: the list, and on the first page the total and each facet without its own filters. */
function serve(path: string): TransportResponse {
  const url = new URL(path, "http://test.invalid")
  const params = url.searchParams
  const rows = ROWS.filter(matches(params))
  const start = Number(params.get("cursor") ?? 0)
  const limit = Number(params.get("limit") ?? 50)
  const body: Record<string, unknown> = {
    data: rows.slice(start, start + limit),
    nextCursor: start + limit < rows.length ? String(start + limit) : null,
  }
  if (!params.get("cursor")) {
    const tally = (omit: Facet[], key: (row: AuditEntry) => string | null) => {
      const counts = new Map<string, number>()
      for (const row of ROWS.filter(matches(params, omit))) {
        const value = key(row)
        if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
      }
      return counts
    }
    const kinds = tally(["actorKind", "agent"], (row) => row.actorKind)
    const counts: AuditCounts = {
      actorKind: Object.fromEntries(ACTOR_KINDS.map((kind) => [kind, kinds.get(kind) ?? 0])) as Record<
        ActorKind,
        number
      >,
      agents: [...tally(["agent"], (row) => (row.actorKind === "agent" ? row.actorLabel : null))].map(
        ([label, count]) => ({
          label,
          count,
        }),
      ),
      actions: [...tally(["action"], (row) => row.action)].map(([action, count]) => ({ action, count })),
      projects: [],
    }
    Object.assign(body, { total: rows.length, counts })
  }
  return { status: 200, body }
}

let requests: string[] = []
let hold: ((path: string) => Promise<void> | null) | null = null
let failAudit = false

async function transport({ method, path }: TransportRequest): Promise<TransportResponse> {
  if (method !== "GET") return { status: 404, body: { error: { code: "not_found", message: "Not here." } } }
  if (path.startsWith("/audit")) {
    requests.push(path)
    const wait = hold?.(path)
    if (wait) await wait
    if (failAudit) return { status: 503, body: { error: { code: "unavailable", message: "Down." } } }
    return serve(path)
  }
  if (path === "/projects") return { status: 200, body: { data: [{ id: PROJECT, name: "Moss garden" }] } }
  if (path === `/items/${ITEM}`)
    return { status: 200, body: { data: { item: { id: ITEM, title: "Bed 0" }, audit: [], comments: [], threads: [] } } }
  return { status: 404, body: { error: { code: "not_found", message: "Not here." } } }
}

/** IntersectionObserver as ListEnd uses it: `intersect` brings its sentinel into view. */
const observers = new Set<{ callback: IntersectionObserverCallback }>()
class StandInObserver {
  constructor(readonly callback: IntersectionObserverCallback) {
    observers.add(this)
  }
  observe() {}
  unobserve() {}
  disconnect() {
    observers.delete(this)
  }
  takeRecords() {
    return []
  }
}
async function intersect() {
  await act(async () => {
    for (const observer of observers)
      observer.callback([{ isIntersecting: true } as IntersectionObserverEntry], observer as never)
  })
  await settle()
}

let mounted: { root: Root; host: HTMLElement } | null = null
let router: ReturnType<typeof createMemoryRouter>
let queryClient: QueryClient

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function render(path: string): Promise<void> {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted = { root, host }
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(qk.session, { actor: { kind: "owner", label: "owner.name" } })
  router = createMemoryRouter(
    [
      {
        path: "/activity",
        element: (
          <UnsavedProvider>
            <ActivityPage />
            <ConfirmHost />
            <ToastHost />
          </UnsavedProvider>
        ),
      },
    ],
    { initialEntries: [path] },
  )
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <RouterProvider router={router} />
          </I18nProvider>
        </QueryClientProvider>
      </StrictMode>,
    )
  })
  await settle(60)
}

const plain = (text: string | null | undefined) => (text ?? "").replace(/[⁦-⁩]/g, "").trim()
const search = () => router.state.location.search
const countLine = () => plain(document.querySelector(".ui-list-summary b")?.textContent)
const rows = () => document.querySelectorAll("#activity .ui-item").length
const pill = (name: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".ui-fbar .ui-picker-pill")).find((button) =>
    plain(button.querySelector(".ui-picker-name")?.textContent).startsWith(`${name}:`),
  )
const lastAudit = () => requests.at(-1) ?? ""

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("nothing to click")
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await settle()
}

/** Opens a picker and answers its options as label and count. */
async function options(name: string): Promise<{ label: string; hint: string; element: HTMLElement }[]> {
  await click(pill(name))
  return Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')).map((element) => ({
    label: plain(element.querySelector(".ui-picker-opt-label")?.textContent),
    hint: plain(element.querySelector("small")?.textContent),
    element,
  }))
}

async function choose(name: string, label: string) {
  const option = (await options(name)).find((entry) => entry.label === label)
  await click(option?.element)
}

async function type(text: string) {
  const input = document.querySelector<HTMLInputElement>(".ui-search input")
  if (!input) throw new Error("no search")
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    setter?.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

beforeEach(() => {
  localStorage.setItem("mikud.language", "en")
  requests = []
  hold = null
  failAudit = false
  observers.clear()
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = StandInObserver
  setTransport(transport)
})

afterEach(() => {
  if (mounted) {
    const { root, host } = mounted
    act(() => root.unmount())
    host.remove()
    mounted = null
  }
  localStorage.clear()
})

describe("the address", () => {
  it("reads every filter as the API checks it, and names the ones to drop", () => {
    const read = filtersFromParams(
      new URLSearchParams(`actorKind=owner&agent=agent:codex&action=DROP&projectId=1&q=%20bed%20&itemId=${ITEM}`),
    )
    expect(read.filters).toEqual({ actorKind: "owner", q: "bed", itemId: ITEM })
    expect(read.dropped.sort()).toEqual(["action", "agent", "projectId"])
  })

  it("drops a value the API would refuse, in place, and asks only for what is left", async () => {
    await render("/activity?actorKind=owner&action=BAD&q=%20%20")
    expect(search()).toBe("?actorKind=owner")
    expect(router.state.historyAction).toBe("REPLACE")
    expect(lastAudit()).toBe("/audit?actorKind=owner&limit=50")
  })
})

describe("the count line", () => {
  it("shows the server's total, not the rows loaded", async () => {
    await render("/activity")
    expect(rows()).toBe(50)
    expect(countLine()).toBe("120 changes")
    expect(document.querySelector(".ui-clear-filters")).toBeNull()
  })

  it("Who shows what choosing it lists, also while an agent is chosen (R1)", async () => {
    await render("/activity?agent=agent:codex")
    expect(countLine()).toBe("30 changes")
    const you = (await options("Who")).find((option) => option.label === en.activity.actorKind.owner)
    expect(you?.hint).toBe("30")
    await click(you?.element)
    expect(search()).toBe("?actorKind=owner")
    await settle()
    expect(countLine()).toBe(`${you?.hint} changes`)
    const everyone = (await options("Who")).find((option) => option.label === en.activity.everyone)
    await click(everyone?.element)
    await settle()
    expect(countLine()).toBe(`${everyone?.hint} changes`)
  })

  it("Clear filters shows only while a filter is in use, and puts every filter back", async () => {
    await render("/activity?actorKind=owner&q=bed")
    await click(document.querySelector(".ui-clear-filters"))
    expect(search()).toBe("")
    expect(lastAudit()).toBe("/audit?limit=50")
    expect(document.querySelector(".ui-clear-filters")).toBeNull()
  })

  it("says when nothing matches, and how to go on", async () => {
    await render("/activity?q=zzz")
    expect(plain(document.querySelector("#activity .ui-empty b")?.textContent)).toBe('No changes match "zzz".')
    expect(countLine()).toBe("0 changes")
    expect(document.querySelector(".ui-clear-filters")).not.toBeNull()
  })
})

describe("the Filters button", () => {
  it("counts the hidden filters in use and moves the focus into them when it opens (MP-6, R5)", async () => {
    await render("/activity?action=item.create&agent=agent:codex")
    const toggle = document.querySelector<HTMLButtonElement>(".ui-filters-toggle")
    expect(plain(toggle?.getAttribute("aria-label"))).toBe("Filters, 2 in use")
    expect(toggle?.querySelector(".ui-filters-n")?.textContent).toBe("2")
    expect(document.querySelector<HTMLElement>(".ui-fbar-more")?.hidden).toBe(true)
    await click(toggle)
    expect(toggle?.getAttribute("aria-expanded")).toBe("true")
    expect(document.activeElement).toBe(document.querySelector(".ui-fbar-more .ui-picker-pill"))
  })

  it("keeps a chosen value the counts leave out, named and counted 0 (R3)", async () => {
    await render("/activity?action=proposal.reject")
    await click(document.querySelector(".ui-filters-toggle"))
    expect(plain(pill("Action")?.querySelector(".ui-picker-value")?.textContent)).toBe(en.audit.action.proposal_reject)
    const chosen = (await options("Action")).find((option) => option.label === en.audit.action.proposal_reject)
    expect(chosen?.hint).toBe("0")
  })

  it("names a project an address gives in capitals by its name, not as deleted (R3)", async () => {
    await render(`/activity?projectId=${PROJECT.toUpperCase()}`)
    expect(lastAudit()).toContain(`projectId=${PROJECT}`)
    await click(document.querySelector(".ui-filters-toggle"))
    expect(plain(pill("Project")?.querySelector(".ui-picker-value")?.textContent)).toBe("Moss garden")
    const labels = (await options("Project")).map((option) => option.label)
    expect(labels).not.toContain(en.activity.deletedProject)
    expect(labels.filter((label) => label === "Moss garden")).toHaveLength(1)
  })

  it("names the item a link narrowed the list to, and removes it", async () => {
    await render(`/activity?itemId=${ITEM}`)
    const tag = document.querySelector<HTMLButtonElement>(".ui-fbar-tag")
    expect(plain(tag?.textContent)).toContain("Bed 0")
    expect(countLine()).toBe("12 changes")
    await click(tag)
    expect(search()).toBe("")
  })
})

describe("paging and stale answers", () => {
  it("starts new filters from the first page and the first row; a refresh keeps the place (TB-7, R4)", async () => {
    await render("/activity")
    await intersect()
    expect(requests).toContain("/audit?cursor=50&limit=50")
    expect(rows()).toBe(100)
    const page = document.querySelector<HTMLElement>(".ui-page")
    const bar = document.querySelector<HTMLElement>(".ui-fbar")
    if (!page || !bar) throw new Error("no page")
    page.scrollTop = 900
    // The bar sits 100px down the page's content: on screen it moves up as the page scrolls.
    page.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    bar.getBoundingClientRect = () => ({ top: 100 - page.scrollTop }) as DOMRect

    requests = []
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["audit"] })
    })
    await settle()
    expect(requests).toEqual(["/audit?limit=50", "/audit?cursor=50&limit=50"])
    expect(page.scrollTop).toBe(900)

    requests = []
    await choose("Who", en.activity.actorKind.agent)
    expect(requests[0]).toBe("/audit?actorKind=agent&limit=50")
    expect(requests.some((path) => path.includes("cursor="))).toBe(false)
    expect(page.scrollTop).toBe(100)
  })

  it("never shows an answer for older filters", async () => {
    let release = () => {}
    hold = (path) =>
      path.includes("actorKind=sync")
        ? new Promise<void>((resolve) => {
            release = resolve
          })
        : null
    await render("/activity?actorKind=sync")
    expect(countLine()).toBe(en.activity.counting)
    await act(async () => {
      await router.navigate("/activity?actorKind=owner")
    })
    await settle()
    expect(countLine()).toBe("30 changes")
    await act(async () => release())
    await settle()
    expect(countLine()).toBe("30 changes")
    const labels = Array.from(document.querySelectorAll("#activity .ui-actor")).map((tag) => plain(tag.textContent))
    expect(new Set(labels)).toEqual(new Set(["owner.name"]))
  })

  it("shows no counts after a failed refresh, with the stale note, and keeps the rows (R6)", async () => {
    await render("/activity?actorKind=owner")
    expect(countLine()).toBe("30 changes")
    failAudit = true
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["audit"] }).catch(() => {})
    })
    await settle()
    expect(document.querySelector(".ui-stale-note")).not.toBeNull()
    expect(document.querySelector(".ui-list-summary b")).toBeNull()
    expect(rows()).toBe(30)
    expect((await options("Who")).every((option) => option.hint === "")).toBe(true)
  })

  it("claims no 0 for a chosen value the counts leave out once a refresh failed (R6)", async () => {
    await render("/activity?action=proposal.reject")
    await click(document.querySelector(".ui-filters-toggle"))
    failAudit = true
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["audit"] }).catch(() => {})
    })
    await settle()
    expect(document.querySelector(".ui-stale-note")).not.toBeNull()
    const chosen = (await options("Action")).find((option) => option.label === en.audit.action.proposal_reject)
    expect(chosen, "still named").toBeDefined()
    expect(chosen?.hint).toBe("")
  })
})

describe("the search", () => {
  it("asks once typing pauses, and replaces its own address step", async () => {
    await render("/activity")
    await type("bed 1")
    expect(lastAudit()).toBe("/audit?limit=50")
    await settle(400)
    expect(search()).toBe("?q=bed+1")
    expect(router.state.historyAction).toBe("REPLACE")
    expect(lastAudit()).toBe("/audit?q=bed+1&lang=en&limit=50")
  })

  it("drops a search still on its way when Back or Clear changes the address, and Forward brings filters back (R6)", async () => {
    await render("/activity?actorKind=owner")
    await choose("Who", en.activity.actorKind.agent)
    expect(search()).toBe("?actorKind=agent")

    await type("bed")
    await act(async () => {
      await router.navigate(-1)
    })
    await settle(400)
    expect(search()).toBe("?actorKind=owner")
    expect(document.querySelector<HTMLInputElement>(".ui-search input")?.value).toBe("")
    expect(requests.some((path) => path.includes("q="))).toBe(false)

    await act(async () => {
      await router.navigate(1)
    })
    await settle()
    expect(search()).toBe("?actorKind=agent")
    expect(plain(pill("Who")?.querySelector(".ui-picker-value")?.textContent)).toBe(en.activity.actorKind.agent)

    await type("bed")
    await click(document.querySelector(".ui-clear-filters"))
    await settle(400)
    expect(search()).toBe("")
    expect(document.querySelector<HTMLInputElement>(".ui-search input")?.value).toBe("")
    expect(requests.some((path) => path.includes("q="))).toBe(false)
  })
})
