// @vitest-environment happy-dom
// The shell's tools in a DOM (R10, R3, R4): the folded sidebar is remembered and applied before the page draws,
// the theme button walks System, Light and Dark, the account menu closes on Escape and Back through the layer
// owner, signing out asks about unsaved changes first and keeps them when the sign-out fails, and the More sheet
// closes on Escape and Back. Stay in the Leave question keeps the account menu and the bell open when a link in
// them would leave unsaved changes, and the menu and the status card link to their exact Settings section.

import { readFileSync } from "node:fs"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, type ReactNode, StrictMode, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import en from "../../shared/locales/en.json"
import { qk } from "../api/endpoints.ts"
import { I18nProvider } from "../i18n/i18n.tsx"
import { ConfirmHost } from "../ui/confirm.tsx"
import { layerCount } from "../ui/layers.ts"
import { ToastHost } from "../ui/Toast.tsx"
import { UnsavedProvider, useUnsaved } from "../ui/unsaved.tsx"
import { Bell } from "./Bell.tsx"
import { MoreSheet } from "./MoreSheet.tsx"
import { NAV_KEY, useNavFolded } from "./navFold.ts"
import { AccountMenu, NavToggle, nextTheme, SyncStatus, ThemeButton } from "./ShellTools.tsx"

const signOut = vi.fn<() => Promise<{ data: unknown; error: { status?: number; message?: string } | null }>>()
vi.mock("../api/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/auth.ts")>()
  return { ...real, authClient: { signOut: () => signOut() } }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The script index.html runs before the first paint. Vitest runs from the repository root. */
const BOOT = "src/web/public/boot.js"

let mounted: { root: Root; host: HTMLElement } | null = null
let router: ReturnType<typeof createMemoryRouter> | null = null

/** Renders `ui` at `at` ("/" by default) inside the app's providers, with a sign-in page at "/login". */
async function render(ui: ReactNode, at = "/"): Promise<void> {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted = { root, host }
  const queryClient = new QueryClient()
  queryClient.setQueryData(qk.session, { actor: { kind: "owner", label: "owner.name" } })
  router = createMemoryRouter(
    [
      {
        element: (
          <UnsavedProvider>
            <Where />
            {/* biome-ignore lint/complexity/noUselessFragments: the routes render inside */}
            <>{ui}</>
            <ConfirmHost />
            <ToastHost />
          </UnsavedProvider>
        ),
        children: [
          { path: "/", element: null },
          { path: "/projects", element: null },
          { path: "/login", element: null },
          { path: "/projects/:projectId", element: null },
          { path: "/settings/:section?", element: null },
          { path: "/account", element: null },
        ],
      },
    ],
    { initialEntries: [at] },
  )
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <RouterProvider router={router as ReturnType<typeof createMemoryRouter>} />
          </I18nProvider>
        </QueryClientProvider>
      </StrictMode>,
    )
  })
}

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>
}

const where = () => document.querySelector('[data-testid="where"]')?.textContent

/** Lets effects, microtasks and the layer owner's animation frames run. */
async function settle(ms = 40): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  // As a pointer does: the button takes the focus, then the click.
  await act(async () => {
    ;(element as HTMLElement).focus()
    ;(element as HTMLElement).click()
  })
  await settle()
}

async function key(name: string, target: EventTarget = document.activeElement ?? document.body): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }))
  })
  await settle()
}

async function back(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }))
  })
  await settle()
}

const button = (name: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("button")).find(
    (element) => element.getAttribute("aria-label") === name || element.textContent?.trim() === name,
  )

/** matchMedia answering `matches`; `resize()` re-reads every query and tells the listeners whose answer changed. */
function stubMedia(matches: (query: string) => boolean) {
  const lists: { query: string; list: { matches: boolean }; listeners: Set<() => void> }[] = []
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    const listeners = new Set<() => void>()
    const list = {
      matches: matches(query),
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }
    lists.push({ query, list, listeners })
    return list as unknown as MediaQueryList
  })
  return {
    resize() {
      for (const { query, list, listeners } of lists) {
        const next = matches(query)
        if (next === list.matches) continue
        list.matches = next
        for (const listener of listeners) listener()
      }
    },
  }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem("adiutor.language", "en")
  delete document.documentElement.dataset.nav
  document.documentElement.classList.remove("dark")
  signOut.mockReset()
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

function Fold() {
  const nav = useNavFolded()
  return <NavToggle {...nav} />
}

describe("the folded sidebar (NL-7)", () => {
  it("is remembered in this browser and applied by boot.js before the page draws", async () => {
    stubMedia((query) => query === "(min-width: 1101px)")
    await render(<Fold />)
    await click(button(en.shell.collapseMenu))
    expect(document.documentElement.dataset.nav).toBe("rail")
    expect(localStorage.getItem(NAV_KEY)).toBe("rail")
    expect(button(en.shell.expandMenu)?.getAttribute("aria-expanded")).toBe("false")

    // A reload: a fresh document runs boot.js, which reads the choice before anything draws.
    delete document.documentElement.dataset.nav
    new Function(readFileSync(BOOT, "utf8"))()
    expect(document.documentElement.dataset.nav).toBe("rail")

    // Ctrl+B unfolds and folds it where the full sidebar exists; a plain B does nothing.
    await key("b", document)
    expect(document.documentElement.dataset.nav).toBe("rail")
    const ctrlB = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }))
    await act(async () => ctrlB())
    expect(document.documentElement.dataset.nav).toBeUndefined()
    await act(async () => ctrlB())
    expect(document.documentElement.dataset.nav).toBe("rail")
    await click(button(en.shell.expandMenu))
    expect(document.documentElement.dataset.nav).toBeUndefined()
    expect(localStorage.getItem(NAV_KEY)).toBe("side")
    new Function(readFileSync(BOOT, "utf8"))()
    expect(document.documentElement.dataset.nav).toBeUndefined()
  })

  it("Ctrl+B does nothing in the rail range, where there is no full sidebar", async () => {
    stubMedia(() => false)
    await render(<Fold />)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }))
    })
    expect(document.documentElement.dataset.nav).toBeUndefined()
  })
})

describe("the theme lives in the shell, with System (R5, Q-7)", () => {
  it("the button walks System, Light, Dark and back to System, which follows the operating system", async () => {
    let osDark = true
    stubMedia((query) => query === "(prefers-color-scheme: dark)" && osDark)
    await render(<ThemeButton />)
    const theme = () => document.querySelector<HTMLElement>("[data-theme-button]")
    const named = (current: string, next: string) =>
      en.shell.themeButton.replace("{theme}", `⁨${current}⁩`).replace("{next}", `⁨${next}⁩`)

    expect(theme()?.getAttribute("aria-label")).toBe(named(en.theme.system, en.theme.light))
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    await click(theme())
    expect(localStorage.getItem("adiutor.theme")).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    await click(theme())
    expect(localStorage.getItem("adiutor.theme")).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    await click(theme())
    expect(localStorage.getItem("adiutor.theme")).toBe("system")
    expect(theme()?.getAttribute("aria-label")).toBe(named(en.theme.system, en.theme.light))
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    // System with a light operating system is light.
    osDark = false
    await click(theme())
    await click(theme())
    await click(theme())
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(nextTheme("dark")).toBe("system")
  })

  it("the account menu picks Light, Dark or System", async () => {
    stubMedia(() => false)
    await render(<AccountMenu />)
    await click(button(`owner.name, ${en.shell.accountMenu}`))
    const radios = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
    expect(radios().map((radio) => radio.textContent)).toEqual([en.theme.light, en.theme.dark, en.theme.system])
    expect(radios()[2]?.getAttribute("aria-checked")).toBe("true")
    await click(radios()[1])
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(localStorage.getItem("adiutor.theme")).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    await click(button(`owner.name, ${en.shell.accountMenu}`))
    await click(radios()[2])
    expect(localStorage.getItem("adiutor.theme")).toBe("system")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })
})

describe("the account menu is a layer of ui/layers.ts (R4)", () => {
  it("opens on its first item, moves with the arrows, and Escape closes it and returns the focus", async () => {
    stubMedia(() => false)
    await render(<AccountMenu />)
    const trigger = button(`owner.name, ${en.shell.accountMenu}`)
    await click(trigger)
    const menu = document.querySelector('[role="menu"]')
    expect(menu?.getAttribute("aria-label")).toBe(en.shell.accountMenu)
    expect(trigger?.getAttribute("aria-expanded")).toBe("true")
    expect(layerCount()).toBe(1)
    const items = Array.from(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])
    expect(items.map((item) => item.textContent)).toEqual([
      en.theme.light,
      en.theme.dark,
      en.theme.system,
      en.shell.account,
      en.account.signOut,
    ])
    expect(document.activeElement).toBe(items[0])
    await key("ArrowUp")
    expect(document.activeElement).toBe(items[4])
    await key("ArrowDown")
    expect(document.activeElement).toBe(items[0])
    await key("End")
    expect(document.activeElement).toBe(items[4])
    // The page behind is inert while the menu is open.
    expect(mounted?.host.inert).toBe(true)

    await key("Escape")
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(layerCount()).toBe(0)
    expect(mounted?.host.inert).toBe(false)
    expect(document.activeElement).toBe(trigger)
    expect(trigger?.getAttribute("aria-expanded")).toBe("false")
  })

  it("Back closes the menu and stays on the page", async () => {
    stubMedia(() => false)
    await render(<AccountMenu />)
    await click(button(`owner.name, ${en.shell.accountMenu}`))
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    await back()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(layerCount()).toBe(0)
    expect(where()).toBe("/")
  })

  it("Account opens the Account page", async () => {
    stubMedia(() => false)
    await render(<AccountMenu />)
    await click(button(`owner.name, ${en.shell.accountMenu}`))
    await click(button(en.shell.account))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(where()).toBe("/account")
  })

  it("the sync card links to Settings, Status (R11)", async () => {
    stubMedia(() => false)
    await render(<SyncStatus morning={undefined} failed={false} />)
    expect(document.querySelector(".ui-status-card")?.getAttribute("href")).toBe("/settings/status")
  })
})

/** A page with one unsaved change: a typed value and its guard. */
function Draft() {
  const [value, setValue] = useState("A draft the owner typed")
  useUnsaved("draft", { count: 1, kind: "leave" })
  return <input aria-label="Draft" value={value} onChange={(event) => setValue(event.target.value)} />
}

const draft = () => document.querySelector<HTMLInputElement>('input[aria-label="Draft"]')

async function signOutFromMenu(): Promise<void> {
  await click(button(`owner.name, ${en.shell.accountMenu}`))
  await click(button(en.account.signOut))
}

/** A morning view with one project that has a critical security finding: one row in the bell. */
const MORNING = {
  waiting: [],
  security: [{ projectId: "p1", projectName: "Beacon", critical: 2, high: 0, asOf: null }],
} as unknown as Parameters<typeof Bell>[0]["morning"]

describe("Stay keeps the layer a link would have closed (SV-1, the P3 of PR #23)", () => {
  it("the account menu stays open, on the same page, with the draft", async () => {
    stubMedia(() => false)
    await render(
      <>
        <AccountMenu />
        <Draft />
      </>,
    )
    await click(button(`owner.name, ${en.shell.accountMenu}`))
    await click(button(en.shell.account))
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(en.unsaved.leaveTitle)
    await click(button(en.unsaved.stay))
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(where()).toBe("/")
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(layerCount()).toBe(1)
    expect(draft()?.value).toBe("A draft the owner typed")
    // Leave goes on to the section; the menu closes once it shows.
    await click(button(en.shell.account))
    await click(button(en.unsaved.leave))
    expect(where()).toBe("/account")
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(layerCount()).toBe(0)
  })

  it("the bell window stays open when Stay cancels a row's page or its morning view link", async () => {
    stubMedia(() => false)
    await render(
      <>
        <Bell morning={MORNING} failed={false} place="top" />
        <Draft />
      </>,
      "/projects",
    )
    const bell = document.querySelector<HTMLButtonElement>("button.ui-bell")
    await click(bell)
    const win = () => document.querySelector(".ui-attn-win")
    expect(win()).not.toBeNull()

    // A row that opens its project.
    await click(win()?.querySelector("[data-row-open]"))
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(en.unsaved.leaveTitle)
    await click(button(en.unsaved.stay))
    expect(where()).toBe("/projects")
    expect(win()).not.toBeNull()
    expect(layerCount()).toBe(1)

    // The foot's link to the morning view.
    await click(win()?.querySelector(".ui-attn-foot a"))
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(en.unsaved.leaveTitle)
    await click(button(en.unsaved.stay))
    expect(where()).toBe("/projects")
    expect(win()).not.toBeNull()
    expect(draft()?.value).toBe("A draft the owner typed")
  })
})

describe("signing out from the shell (R3, SV-1)", () => {
  it("Stay keeps the page and the draft, and never calls Better Auth", async () => {
    stubMedia(() => false)
    await render(
      <>
        <AccountMenu />
        <Draft />
      </>,
    )
    await signOutFromMenu()
    const question = document.querySelector('[role="alertdialog"]')
    expect(question?.textContent).toContain(en.unsaved.leaveTitle)
    await click(button(en.unsaved.stay))
    expect(signOut).not.toHaveBeenCalled()
    expect(where()).toBe("/")
    expect(draft()?.value).toBe("A draft the owner typed")
  })

  it("a failed sign-out says so and keeps the draft and its guard", async () => {
    stubMedia(() => false)
    signOut.mockResolvedValue({ data: null, error: { status: 503, message: "Service unavailable" } })
    await render(
      <>
        <AccountMenu />
        <Draft />
      </>,
    )
    await signOutFromMenu()
    await click(button(en.unsaved.leave))
    await settle()
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(where()).toBe("/")
    expect(draft()?.value).toBe("A draft the owner typed")
    expect(document.querySelector(".ui-toast")?.textContent).toContain(en.account.signOutFailed.split(":")[0])
    // The guard still holds the change: a move inside the app asks again.
    await act(async () => {
      await router?.navigate("/projects")
    })
    await settle()
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(en.unsaved.leaveTitle)
    await click(button(en.unsaved.stay))
    expect(where()).toBe("/")
  })

  it("a sign-out that worked drops the changes and goes to sign-in without asking again", async () => {
    stubMedia(() => false)
    signOut.mockResolvedValue({ data: { success: true }, error: null })
    await render(
      <>
        <AccountMenu />
        <Draft />
      </>,
    )
    await signOutFromMenu()
    await click(button(en.unsaved.leave))
    await settle()
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(where()).toBe("/login")
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it("without unsaved changes it signs out at once", async () => {
    stubMedia(() => false)
    signOut.mockResolvedValue({ data: { success: true }, error: null })
    await render(<AccountMenu />)
    await signOutFromMenu()
    await settle()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(where()).toBe("/login")
  })
})

function More() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        More
      </button>
      {open ? <MoreSheet inbox={0} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

describe("the More sheet (NL-9, R4)", () => {
  it("Escape and Back close it, and the page already open only closes it", async () => {
    stubMedia(() => false)
    await render(<More />)
    const sheet = () => document.querySelector('[role="dialog"]')
    await click(button("More"))
    expect(sheet()?.getAttribute("aria-label")).toBe(en.nav.allPages)
    // Its foot holds the theme button.
    expect(sheet()?.querySelector("[data-theme-button]")).not.toBeNull()
    await key("Escape")
    expect(sheet()).toBeNull()
    expect(document.activeElement).toBe(button("More"))

    await click(button("More"))
    await back()
    expect(sheet()).toBeNull()
    expect(where()).toBe("/")

    await click(button("More"))
    const here = Array.from(sheet()?.querySelectorAll("a") ?? []).find((link) => link.getAttribute("href") === "/")
    await click(here)
    expect(sheet()).toBeNull()
    expect(where()).toBe("/")
  })

  it("closes when the window grows past 760px: no layer, nothing inert, its history entry given back", async () => {
    let width = 390
    const media = stubMedia((query) => query === "(max-width: 760px)" && width <= 760)
    const goBack = vi.spyOn(history, "back").mockImplementation(() => {})
    await render(<More />)
    await click(button("More"))
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(layerCount()).toBe(1)
    expect((history.state as { adiutorLayer?: boolean } | null)?.adiutorLayer).toBe(true)

    width = 1000
    await act(async () => media.resize())
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(layerCount()).toBe(0)
    expect(document.querySelectorAll("[inert]")).toHaveLength(0)
    expect(document.documentElement.classList.contains("ui-layer-on")).toBe(false)
    expect(goBack).toHaveBeenCalledTimes(1)
  })
})
