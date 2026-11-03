// @vitest-environment happy-dom
// Settings in sections with one draft (R2, R10; v3 FS-8, FS-10, NL-3, SV-1): changes in two sections survive moves
// between them, Back and Forward; one Save and one Discard cover both; a refused field in a hidden section, by the
// page's own check or by the server, opens that section and takes the focus; /settings and an unknown section
// replace the address with the first section; a deep link opens its section; the links and the browser title
// name the exact section.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, type ReactNode, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import en from "../../../shared/locales/en.json"
import he from "../../../shared/locales/he.json"
import { setTransport, type TransportRequest } from "../../api/client.ts"
import { qk } from "../../api/endpoints.ts"
import type { Settings, SettingsPatch, Suppression } from "../../api/types.ts"
import { I18nProvider } from "../../i18n/i18n.tsx"
import { ConfirmHost } from "../../ui/confirm.tsx"
import { ToastHost } from "../../ui/Toast.tsx"
import { UnsavedProvider } from "../../ui/unsaved.tsx"
import { forgetSettingsVisit, RESTORE_FOR_MS, SettingsPage } from "../SettingsPage.tsx"
import {
  changedSections,
  FIELD_SECTION,
  refusedField,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  settingsPath,
} from "./sections.ts"

vi.mock("../../api/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/auth.ts")>()
  return { ...real, authClient: {} }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SAVED: Settings = {
  id: "s1",
  closedItemDays: 7,
  dateFormat: "dd/MM/yyyy",
  timeFormat: "HH:mm",
  language: "en",
  sessionIdleDays: 30,
  otpViaTelegram: false,
  updatedAt: "2026-11-01T08:00:00.000Z",
  telegram: {
    botToken: { set: false, readable: true, locked: false, variable: null },
    chatId: { value: "4242", locked: false, variable: null },
    state: "incomplete",
    missing: ["botToken"],
  },
  privateDomains: { value: ["corp.example"], locked: false, variable: null },
}

let saved: Settings
let patches: SettingsPatch[]
/** The answer to the next PATCH, when it is refused. */
let refusal: { status: number; body: unknown } | null

async function transport({ method, path, body }: TransportRequest) {
  if (path === "/settings" && method === "GET") return { status: 200, body: { data: saved } }
  if (path === "/settings" && method === "PATCH") {
    patches.push(body as SettingsPatch)
    if (refusal) return refusal
    const patch = body as SettingsPatch
    saved = {
      ...saved,
      ...(patch.closedItemDays !== undefined ? { closedItemDays: patch.closedItemDays } : {}),
      ...(patch.sessionIdleDays !== undefined ? { sessionIdleDays: patch.sessionIdleDays } : {}),
      telegram: {
        ...saved.telegram,
        chatId: { ...saved.telegram.chatId, value: patch.telegramChatId ?? saved.telegram.chatId.value },
      },
    }
    return { status: 200, body: { data: saved } }
  }
  if (path === "/suppressions" && method === "GET") {
    await suppressionsAnswer
    return { status: 200, body: { data: SUPPRESSIONS } }
  }
  // The morning view and the Telegram status are read after a save; nothing else is asked for here.
  return { status: 404, body: { error: { code: "not_found", message: "Not here." } } }
}

/** A long Suppressions list, so the section scrolls far; its answer waits for `suppressionsAnswer`. */
const SUPPRESSIONS: Suppression[] = Array.from({ length: 40 }, (_, index) => ({
  id: `s${index}`,
  kind: "thread",
  externalId: `thread-${index}`,
  label: `Invented thread ${index}`,
  createdAt: "2026-10-01T08:00:00.000Z",
}))
let suppressionsAnswer: Promise<void> = Promise.resolve()

let queryClient: QueryClient | null = null
let mounted: { root: Root; host: HTMLElement } | null = null
let router: ReturnType<typeof createMemoryRouter> | null = null

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>
}
const where = () => document.querySelector('[data-testid="where"]')?.textContent

async function render(entries: string[]): Promise<void> {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted = { root, host }
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(qk.session, { actor: { kind: "owner", label: "owner.name" } })
  const frame = (page: ReactNode) => (
    <UnsavedProvider>
      <Where />
      {page}
      <ConfirmHost />
      <ToastHost />
    </UnsavedProvider>
  )
  router = createMemoryRouter(
    [
      { path: "/settings/:section?", element: frame(<SettingsPage />) },
      { path: "/projects", element: frame(null) },
    ],
    { initialEntries: entries, initialIndex: entries.length - 1 },
  )
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient as QueryClient}>
          <I18nProvider>
            <RouterProvider router={router as ReturnType<typeof createMemoryRouter>} />
          </I18nProvider>
        </QueryClientProvider>
      </StrictMode>,
    )
  })
  await settle()
}

async function settle(ms = 40): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => {
    ;(element as HTMLElement).focus()
    ;(element as HTMLElement).click()
  })
  await settle()
}

/** Types into a controlled input as the browser does: the value, then an input event. */
async function type(input: HTMLInputElement | null | undefined, value: string): Promise<void> {
  expect(input).toBeTruthy()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    setter?.call(input, value)
    input?.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

async function go(to: string | number): Promise<void> {
  await act(async () => {
    await (typeof to === "number" ? router?.navigate(to) : router?.navigate(to))
  })
  await settle()
}

const button = (name: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("button")).find((element) => element.textContent?.trim() === name)
const navLink = (section: string) =>
  document.querySelector<HTMLAnchorElement>(`.ui-set-nav a[href="/settings/${section}"]`)
const closedDays = () => document.querySelector<HTMLInputElement>("#general input[type=number]")
const idleDays = () => document.querySelectorAll<HTMLInputElement>("#general input[type=number]")[1]
const chatId = () => document.querySelector<HTMLInputElement>('#telegram input[inputmode="numeric"]')
const dots = () =>
  Array.from(document.querySelectorAll(".ui-set-nav .ui-set-dot")).map((dot) => dot.closest("a")?.getAttribute("href"))
const saveBar = () => document.querySelector(".ui-savebar")
const question = () => document.querySelector('[role="alertdialog"]')

/** Changes the closed-item days in General and the chat id in Telegram; ends on Telegram. */
async function changeTwoSections(): Promise<void> {
  await type(closedDays(), "9")
  await click(navLink("telegram"))
  expect(where()).toBe("/settings/telegram")
  await type(chatId(), "5151")
}

beforeEach(() => {
  forgetSettingsVisit()
  localStorage.clear()
  localStorage.setItem("mikud.language", "en")
  saved = structuredClone(SAVED)
  patches = []
  refusal = null
  setTransport(transport)
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query === "(min-width: 761px)",
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
})

afterEach(async () => {
  if (mounted) {
    const { root, host } = mounted
    mounted = null
    await act(async () => root.unmount())
    host.remove()
  }
  router = null
  vi.restoreAllMocks()
})

describe("the catalogue", () => {
  it("holds the owner's groups and sections, each with a title and a paragraph in both languages", () => {
    expect(SETTINGS_GROUPS.map((group) => [group.id, [...group.sections]])).toEqual([
      ["general", ["general"]],
      ["security", ["agents", "secret-check"]],
      ["integrations", ["telegram"]],
      ["sync", ["status", "suppressions"]],
    ])
    for (const locale of [en, he]) {
      for (const group of SETTINGS_GROUPS) expect(locale.settings.groups[group.id]).toBeTruthy()
      for (const section of SETTINGS_SECTIONS) {
        expect(locale.settings.sections[section].title).toBeTruthy()
        expect(locale.settings.sections[section].hint).toBeTruthy()
      }
    }
    // Section ids are addresses: lower case, digits and dashes only (no underscores, the FS-10 pitfall).
    for (const section of SETTINGS_SECTIONS) expect(section).toMatch(/^[a-z0-9-]+$/)
  })

  it("maps every field of the save request to its section, and a refusal to its field", () => {
    expect(
      [...changedSections({ closedItemDays: 3, telegramChatId: "1", privateDomains: [], otpViaTelegram: true })].sort(),
    ).toEqual(["general", "secret-check", "telegram"])
    expect(FIELD_SECTION.botToken).toBe("telegram")
    expect(refusedField("setting_locked", { variable: "MIKUD_TELEGRAM_CHAT_ID" })).toBe("chatId")
    expect(refusedField("setting_locked", { variable: "MIKUD_PRIVATE_DOMAINS" })).toBe("privateDomains")
    expect(refusedField("validation_failed", { field: "otpViaTelegram" })).toBe("otpViaTelegram")
    expect(refusedField("validation_failed", { issues: [{ path: "telegramBotToken", message: "x" }] })).toBe("botToken")
    expect(refusedField("validation_failed", { issues: [{ path: "", message: "x" }] })).toBeNull()
    expect(refusedField("internal_error", { field: "closedItemDays" })).toBeNull()
  })
})

describe("one draft across the sections (R2)", () => {
  it("keeps changes in two sections through moves, Back and Forward, with a dot on each", async () => {
    await render(["/settings/general"])
    await changeTwoSections()
    expect(saveBar()?.textContent).toContain("2")
    expect(dots()).toEqual(["/settings/general", "/settings/telegram"])
    expect(document.querySelector(`.ui-set-nav .ui-set-dot`)?.getAttribute("aria-label")).toBe(en.settings.unsavedHere)
    // The picker of narrow screens says the same in its options.
    const options = Array.from(document.querySelectorAll(".ui-set-picker option")).map((o) => o.textContent)
    expect(options[0]).toBe(en.settings.unsavedOption.replace("{name}", `⁨${en.settings.sections.general.title}⁩`))
    expect(options[4]).toContain(en.settings.unsavedOption.replace("{name}", "").trim())
    expect(options[1]).toBe(en.settings.sections.account.title)

    await go(-1)
    expect(where()).toBe("/settings/general")
    expect(closedDays()?.value).toBe("9")
    await go(1)
    expect(where()).toBe("/settings/telegram")
    expect(chatId()?.value).toBe("5151")
    // A section outside the draft, then back: still both.
    await click(navLink("status"))
    expect(where()).toBe("/settings/status")
    expect(dots()).toEqual(["/settings/general", "/settings/telegram"])
    await go(-1)
    expect(chatId()?.value).toBe("5151")
    expect(question()).toBeNull()

    // Leaving Settings asks; Stay keeps the page and both changes.
    await go("/projects")
    expect(question()?.textContent).toContain(en.unsaved.leaveTitle)
    await click(button(en.unsaved.stay))
    expect(where()).toBe("/settings/telegram")
    expect(chatId()?.value).toBe("5151")
    expect(saveBar()?.textContent).toContain("2")
  })

  it("saves both sections with one Save, and drops both with one Discard", async () => {
    await render(["/settings/general"])
    await changeTwoSections()
    await click(button(en.savebar.save))
    await settle()
    expect(patches).toEqual([{ closedItemDays: 9, telegramChatId: "5151" }])
    expect(saveBar()).toBeNull()
    expect(dots()).toEqual([])

    await type(chatId(), "6161")
    await click(navLink("general"))
    await type(closedDays(), "11")
    expect(saveBar()?.textContent).toContain("2")
    await click(button(en.savebar.discard))
    expect(saveBar()).toBeNull()
    expect(dots()).toEqual([])
    expect(closedDays()?.value).toBe("9")
    await click(navLink("telegram"))
    expect(chatId()?.value).toBe("5151")
    expect(patches).toHaveLength(1)
  })

  it("a field the page refuses in a hidden section opens that section and takes the focus", async () => {
    await render(["/settings/general"])
    await type(idleDays(), "500")
    await click(navLink("telegram"))
    await type(chatId(), "5151")
    await click(button(en.savebar.save))
    expect(patches).toEqual([])
    expect(where()).toBe("/settings/general")
    expect(document.activeElement).toBe(idleDays())
    expect(idleDays()?.getAttribute("aria-invalid")).toBe("true")
    expect(document.getElementById(idleDays()?.getAttribute("aria-describedby") ?? "")?.textContent).toContain("1")
    // The other change is still there.
    expect(dots()).toEqual(["/settings/general", "/settings/telegram"])
  })

  it("a field the server refuses opens its section and takes the focus", async () => {
    await render(["/settings/telegram"])
    await type(chatId(), "5151")
    await click(navLink("general"))
    refusal = {
      status: 409,
      body: {
        error: {
          code: "setting_locked",
          message: "Set by MIKUD_TELEGRAM_CHAT_ID.",
          variable: "MIKUD_TELEGRAM_CHAT_ID",
        },
      },
    }
    await click(button(en.savebar.save))
    await settle()
    expect(patches).toHaveLength(1)
    expect(where()).toBe("/settings/telegram")
    expect(document.activeElement).toBe(chatId())
    expect(chatId()?.getAttribute("aria-invalid")).toBe("true")

    // A schema failure names its path: the closed-item days, from Telegram.
    await click(navLink("general"))
    await type(closedDays(), "9")
    await click(navLink("telegram"))
    refusal = {
      status: 400,
      body: {
        error: {
          code: "validation_failed",
          message: "The request body is not valid.",
          issues: [{ path: "closedItemDays", message: "Too big" }],
        },
      },
    }
    await click(button(en.savebar.save))
    await settle()
    expect(where()).toBe("/settings/general")
    expect(document.activeElement).toBe(closedDays())
    expect(saveBar()?.textContent).toContain("2")
  })
})

/**
 * The page scroll area as a browser lays it out in a 500px window: 800px of head and section, then 60px a list row.
 * Its position is clamped to what that allows (300 while the list loads), and its height grows with the rows. A
 * position the owner scrolls to is kept from its scroll event.
 */
function layOutPage(): HTMLElement {
  const page = document.querySelector<HTMLElement>(".ui-set-page") as HTMLElement
  const height = () => 800 + page.querySelectorAll(".ui-item").length * 60
  let top = 0
  Object.defineProperty(page, "scrollHeight", { configurable: true, get: height })
  Object.defineProperty(page, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.min(Math.max(0, value), height() - 500)
    },
  })
  return page
}

/** Scrolls as the owner does: the input, the new position, then its scroll event. */
async function ownerScrolls(page: HTMLElement, to: number): Promise<void> {
  await act(async () => {
    page.dispatchEvent(new Event("wheel", { bubbles: true }))
    page.scrollTop = to
    page.dispatchEvent(new Event("scroll"))
  })
}

/** Suppressions scrolled far down, Telegram, the list's cache gone, its next answer held, then Back. */
async function backToAnEvictedList(): Promise<{ page: HTMLElement; answer: () => Promise<void> }> {
  await render(["/settings/suppressions"])
  const page = layOutPage()
  expect(page.querySelectorAll(".ui-item")).toHaveLength(40)
  await ownerScrolls(page, 1500)
  expect(page.scrollTop).toBe(1500)
  await click(navLink("telegram"))
  queryClient?.removeQueries({ queryKey: qk.suppressions })
  let release = () => {}
  suppressionsAnswer = new Promise((resolve) => {
    release = resolve
  })
  await go(-1)
  expect(where()).toBe("/settings/suppressions")
  // Loading: the section is short, so the position is clamped for now.
  expect(page.querySelectorAll(".ui-item")).toHaveLength(0)
  expect(page.scrollTop).toBe(300)
  return {
    page,
    answer: async () => {
      release()
      await settle(120)
    },
  }
}

describe("Back to a list read again (NL-3, a cache that went)", () => {
  afterEach(() => {
    suppressionsAnswer = Promise.resolve()
  })

  it("brings the position back once the list arrives", async () => {
    const { page, answer } = await backToAnEvictedList()
    await settle(100)
    expect(page.scrollTop).toBe(300)
    await answer()
    expect(page.querySelectorAll(".ui-item")).toHaveLength(40)
    expect(page.scrollTop).toBe(1500)
  })

  it("leaves the position to the owner who scrolls while the list loads", async () => {
    const { page, answer } = await backToAnEvictedList()
    await ownerScrolls(page, 0)
    await answer()
    expect(page.querySelectorAll(".ui-item")).toHaveLength(40)
    expect(page.scrollTop).toBe(0)
  })

  it("stops at a scroll it saw no input for (a scroll bar dragged off the main thread, assistive technology)", async () => {
    const { page, answer } = await backToAnEvictedList()
    await act(async () => {
      page.scrollTop = 100
    })
    await settle(100)
    await answer()
    expect(page.querySelectorAll(".ui-item")).toHaveLength(40)
    expect(page.scrollTop).toBe(100)
  })

  it("stops when the focus moves into the page", async () => {
    const { page, answer } = await backToAnEvictedList()
    const link = navLink("general")
    await act(async () => link?.focus())
    expect(document.activeElement).toBe(link)
    await answer()
    expect(page.querySelectorAll(".ui-item")).toHaveLength(40)
    expect(page.scrollTop).toBe(300)
  })

  it("stops waiting after RESTORE_FOR_MS, and its frames stop with it", async () => {
    // Only the frames and their clock are fake, from before Back until after the list arrived.
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] })
    try {
      const { page, answer } = await backToAnEvictedList()
      await act(async () => {
        vi.advanceTimersByTime(100)
      })
      // Still waiting: a frame is pending.
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      await act(async () => {
        vi.advanceTimersByTime(RESTORE_FOR_MS)
      })
      await answer()
      expect(page.querySelectorAll(".ui-item")).toHaveLength(40)
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      expect(page.scrollTop).toBe(300)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("addresses and titles (NL-3)", () => {
  it("/settings and an unknown section replace the address with the first section", async () => {
    await render(["/projects", "/settings"])
    expect(where()).toBe("/settings/general")
    expect(router?.state.historyAction).toBe("REPLACE")
    await go(-1)
    expect(where()).toBe("/projects")

    await go("/settings/no_such-section")
    expect(where()).toBe("/settings/general")
    expect(router?.state.historyAction).toBe("REPLACE")
    await go(-1)
    expect(where()).toBe("/projects")
  })

  it("/settings reopens the section last open during the visit; a link and an unknown section do not (NL-4)", async () => {
    await render(["/settings/telegram"])
    await go("/projects")
    await go("/settings")
    expect(where()).toBe("/settings/telegram")
    expect(router?.state.historyAction).toBe("REPLACE")
    expect(document.querySelector(".ui-set-title")?.textContent).toBe(en.settings.sections.telegram.title)
    await go("/settings/status")
    expect(where()).toBe("/settings/status")
    await go("/settings/no-such-section")
    expect(where()).toBe("/settings/general")
    await go("/projects")
    await go("/settings")
    expect(where()).toBe("/settings/general")
  })

  it("an unknown section keeps the draft (the page stays mounted)", async () => {
    await render(["/settings/general"])
    await type(closedDays(), "9")
    await go("/settings")
    expect(where()).toBe("/settings/general")
    expect(closedDays()?.value).toBe("9")
    expect(question()).toBeNull()
  })

  it("a deep link opens its section; the title, the open item and the browser title follow it", async () => {
    await render(["/settings/telegram"])
    expect(document.querySelector(".ui-set-title")?.textContent).toBe(en.settings.sections.telegram.title)
    expect(document.querySelector(".ui-set-tabdesc")?.textContent).toBe(en.settings.sections.telegram.hint)
    expect(navLink("telegram")?.getAttribute("aria-current")).toBe("true")
    expect(navLink("general")?.getAttribute("aria-current")).toBeNull()
    expect(document.querySelector<HTMLSelectElement>(".ui-set-picker select")?.value).toBe("telegram")
    expect(document.title).toBe(`${en.settings.title} · ${en.settings.sections.telegram.title} · ${en.app.name}`)

    await click(navLink("secret-check"))
    expect(document.querySelector(".ui-set-title")?.textContent).toBe(en.settings.sections["secret-check"].title)
    expect(document.title).toBe(`${en.settings.title} · ${en.settings.sections["secret-check"].title} · ${en.app.name}`)
  })

  it("the sidebar links each section to its exact address, in the owner's order, under its group", async () => {
    await render(["/settings/general"])
    const nav = document.querySelector(".ui-set-nav")
    expect(nav?.getAttribute("aria-label")).toBe(en.settings.categories)
    expect(Array.from(nav?.querySelectorAll("a") ?? []).map((a) => a.getAttribute("href"))).toEqual(
      SETTINGS_SECTIONS.map(settingsPath),
    )
    expect(Array.from(nav?.querySelectorAll(".ui-set-navgroup > p") ?? []).map((p) => p.textContent)).toEqual(
      SETTINGS_GROUPS.map((group) => en.settings.groups[group.id]),
    )
    // The picker: a labelled select with the groups as option groups.
    expect(document.querySelector(".ui-set-picker .ui-sr-only")?.textContent).toBe(en.settings.category)
    expect(
      Array.from(document.querySelectorAll(".ui-set-picker optgroup")).map((g) => g.getAttribute("label")),
    ).toEqual(SETTINGS_GROUPS.map((group) => en.settings.groups[group.id]))
    // Choosing in the picker opens the section, with a Back step.
    const select = document.querySelector<HTMLSelectElement>(".ui-set-picker select")
    await act(async () => {
      if (select) select.value = "status"
      select?.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await settle()
    expect(where()).toBe("/settings/status")
    expect(router?.state.historyAction).toBe("PUSH")
  })
})
