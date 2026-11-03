// @vitest-environment happy-dom
// Settings rows (PR 4; v3 FS-3, FS-6, FS-15, FB-1, SV-2, DS-9, DS-20, S-12, S-13; R6, R7): Changed and Reset to
// default from the one table of defaults, Reset changing only the draft and a value put back as loaded leaving the
// count; secrets and locked values without Changed, Reset or Clear; a locked secret, a locked chat id and Telegram
// off; the password change in a dialog (open, the page's checks, success, failure, Escape and Back); the bulk
// actions at the end of a list's head; and the private domains as value chips.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, type ReactNode, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import en from "../../../shared/locales/en.json"
import { SETTINGS_DEFAULTS } from "../../../shared/settings.ts"
import { setTransport, type TransportRequest } from "../../api/client.ts"
import { qk } from "../../api/endpoints.ts"
import type { AgentKey, BrowserSession, Settings, SettingsPatch, Suppression } from "../../api/types.ts"
import { I18nProvider } from "../../i18n/i18n.tsx"
import { ConfirmHost } from "../../ui/confirm.tsx"
import { ToastHost } from "../../ui/Toast.tsx"
import { UnsavedProvider } from "../../ui/unsaved.tsx"
import { AccountPage } from "../AccountPage.tsx"
import { changedFields, forgetSettingsVisit, SettingsPage, typedNumber } from "../SettingsPage.tsx"
import { removeEvery } from "./SyncSections.tsx"

/** Better Auth's client as Account and Agent access call it; each test sets the answers it needs. */
const auth = vi.hoisted(() => ({
  sessions: [] as unknown[],
  keys: [] as unknown[],
  changePassword: null as null | ((body: unknown) => Promise<{ data: unknown; error: unknown }>),
  calls: [] as { route: string; body?: unknown }[],
}))

vi.mock("../../api/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/auth.ts")>()
  const answer = (data: unknown) => Promise.resolve({ data, error: null })
  return {
    ...real,
    authClient: {
      useSession: () => ({ data: { session: { id: "this" } } }),
      listSessions: () => answer(auth.sessions),
      revokeSession: (body: unknown) => {
        auth.calls.push({ route: "revoke-session", body })
        return answer({ status: true })
      },
      revokeOtherSessions: () => {
        auth.calls.push({ route: "revoke-other-sessions" })
        auth.sessions = auth.sessions.filter((session) => (session as { id: string }).id === "this")
        return answer({ status: true })
      },
      revokeSessions: () => {
        auth.calls.push({ route: "revoke-sessions" })
        return answer({ status: true })
      },
      changePassword: (body: unknown) => {
        auth.calls.push({ route: "change-password", body })
        return auth.changePassword ? auth.changePassword(body) : answer({ token: "t" })
      },
      apiKey: {
        list: () => answer({ apiKeys: auth.keys, total: auth.keys.length }),
        delete: (body: { keyId: string }) => {
          auth.calls.push({ route: "api-key/delete", body })
          auth.keys = auth.keys.filter((key) => (key as { id: string }).id !== body.keyId)
          return answer({ success: true })
        },
      },
    },
  }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The passwords a change accepts are new on every run; the refused ones (too short, not matching, wrong) are literal.
const OLD_PASSWORD = crypto.randomUUID()
const NEW_PASSWORD = crypto.randomUUID()

const SAVED: Settings = {
  id: "s1",
  ...SETTINGS_DEFAULTS,
  language: "en",
  updatedAt: "2026-11-01T08:00:00.000Z",
  telegram: {
    botToken: { set: true, readable: true, locked: false, variable: null },
    chatId: { value: "4242", locked: false, variable: null },
    state: "on",
    missing: [],
  },
  privateDomains: { value: ["corp.example", "lab.example"], locked: false, variable: null },
}

let saved: Settings
let patches: SettingsPatch[]
let suppressions: Suppression[]
let deleted: string[]

async function transport({ method, path, body }: TransportRequest) {
  if (path === "/settings" && method === "GET") return { status: 200, body: { data: saved } }
  if (path === "/settings" && method === "PATCH") {
    patches.push(body as SettingsPatch)
    return { status: 200, body: { data: saved } }
  }
  if (path === "/session") return { status: 200, body: { data: { actor: { kind: "owner", label: "owner.name" } } } }
  if (path === "/suppressions" && method === "GET") return { status: 200, body: { data: suppressions } }
  if (path.startsWith("/suppressions/") && method === "DELETE") {
    const id = path.split("/")[2] ?? ""
    deleted.push(id)
    suppressions = suppressions.filter((entry) => entry.id !== id)
    return { status: 204, body: null }
  }
  if (path === "/telegram/status")
    return {
      status: 200,
      body: { data: { configured: true, polling: true, lastUpdateAt: null, lastMorning: null } },
    }
  return { status: 404, body: { error: { code: "not_found", message: "Not here." } } }
}

let mounted: { root: Root; host: HTMLElement } | null = null
let client: QueryClient | null = null

async function render(path: string): Promise<void> {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted = { root, host }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client = queryClient
  queryClient.setQueryData(qk.session, { actor: { kind: "owner", label: "owner.name" } })
  const frame = (page: ReactNode) => (
    <UnsavedProvider>
      {page}
      <ConfirmHost />
      <ToastHost />
    </UnsavedProvider>
  )
  const router = createMemoryRouter(
    [
      { path: "/settings/:section?", element: frame(<SettingsPage />) },
      { path: "/account", element: frame(<AccountPage />) },
    ],
    {
      initialEntries: [path],
    },
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

async function type(input: Element | null | undefined, value: string): Promise<void> {
  expect(input).toBeTruthy()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    setter?.call(input, value)
    input?.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

async function key(name: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }))
  })
  await settle()
}

/** Text as read: the i18n wraps each value in direction isolates (FSI, PDI). */
const plain = (text: string | null | undefined) => text?.replace(/[\u2066-\u2069]/g, "").trim()
const buttons = (scope: ParentNode = document) => Array.from(scope.querySelectorAll<HTMLElement>("button"))
const button = (name: string, scope: ParentNode = document) =>
  buttons(scope).find((element) => plain(element.textContent) === name)
/** The row whose label line names it. */
const row = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(".ui-set-row")).find(
    (element) => element.querySelector(".ui-set-label-line b")?.textContent === label,
  )
const pill = (label: string) => row(label)?.querySelector(".ui-set-label-line .ui-set-pill")?.textContent?.trim()
const resetOf = (label: string) => row(label)?.querySelector<HTMLElement>(".ui-set-clear.is-reset") ?? undefined
const count = () => plain(document.querySelector(".ui-savebar-count")?.textContent) ?? null
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const question = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
const closedDays = () => row(en.settings.closedDays)?.querySelector<HTMLInputElement>("input")
/** Hebrew's name in Hebrew, as the page writes it (Intl.DisplayNames; Hebrew text lives only in he.json). */
const hebrew = new Intl.DisplayNames(["he"], { type: "language" }).of("he") ?? "he"
const resetLabel = (value: string) => en.settings.resetTo.replace("{value}", value)

beforeEach(() => {
  forgetSettingsVisit()
  localStorage.clear()
  localStorage.setItem("mikud.language", "en")
  saved = structuredClone(SAVED)
  patches = []
  suppressions = []
  deleted = []
  auth.sessions = []
  auth.keys = []
  auth.changePassword = null
  auth.calls = []
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
  vi.restoreAllMocks()
})

describe("Changed and Reset to default (FS-6, R7)", () => {
  it("marks a value that differs from its default, and Reset puts the default back in the draft only", async () => {
    await render("/settings/general")
    expect(pill(en.settings.closedDays)).toBeUndefined()
    expect(resetOf(en.settings.closedDays)).toBeUndefined()
    // English differs from the default, Hebrew: marked at load, with the default's own name.
    expect(pill(en.settings.language)).toBe(en.settings.changed)
    expect(plain(resetOf(en.settings.language)?.textContent)).toBe(resetLabel(hebrew))

    await type(closedDays(), "9")
    expect(pill(en.settings.closedDays)).toBe(en.settings.changed)
    expect(row(en.settings.closedDays)?.querySelector(".is-changed")?.getAttribute("title")).toBe(
      en.settings.changedTooltip,
    )
    expect(plain(resetOf(en.settings.closedDays)?.textContent)).toBe(resetLabel("7"))
    expect(count()).toContain("1")

    await click(resetOf(en.settings.closedDays))
    expect(closedDays()?.value).toBe("7")
    expect(pill(en.settings.closedDays)).toBeUndefined()
    // Back to the loaded value: nothing to save, and nothing was sent.
    expect(count()).toBeNull()
    expect(patches).toEqual([])
  })

  it("a field put back as it was loaded leaves the count, also as 07 or with spaces (SV-2)", async () => {
    await render("/settings/general")
    await type(closedDays(), "12")
    expect(count()).toContain("1")
    await type(closedDays(), " 07 ")
    expect(count()).toBeNull()
    expect(pill(en.settings.closedDays)).toBeUndefined()

    // A segmented choice changed and changed back.
    const segment = (name: string) => button(name, row(en.settings.timeFormat) as HTMLElement)
    await click(segment(en.settings.timeFormats.h12))
    expect(count()).toContain("1")
    expect(pill(en.settings.timeFormat)).toBe(en.settings.changed)
    await click(segment(en.settings.timeFormats.h24))
    expect(count()).toBeNull()
  })

  it("a saved value that differs is marked at load; Reset is a change to save, and saves the default", async () => {
    saved.closedItemDays = 12
    saved.timeFormat = "h:mm a"
    await render("/settings/general")
    expect(pill(en.settings.closedDays)).toBe(en.settings.changed)
    await click(resetOf(en.settings.closedDays))
    await click(resetOf(en.settings.timeFormat))
    expect(closedDays()?.value).toBe("7")
    expect(count()).toContain("2")
    await click(button(en.savebar.save))
    expect(patches).toEqual([{ closedItemDays: 7, timeFormat: "HH:mm" }])
  })

  it("never marks or resets a secret or a locked value; Reset all of General sends only General", async () => {
    saved.closedItemDays = 12
    saved.sessionIdleDays = 45
    saved.telegram.botToken = { set: true, readable: true, locked: true, variable: "MIKUD_TELEGRAM_BOT_TOKEN" }
    saved.telegram.chatId = { value: "70012345", locked: true, variable: "MIKUD_TELEGRAM_CHAT_ID" }
    saved.privateDomains = { value: ["corp.example"], locked: true, variable: "MIKUD_PRIVATE_DOMAINS" }
    await render("/settings/telegram")
    const telegram = document.querySelector("#telegram") as HTMLElement
    expect(telegram.querySelector(".ui-set-clear")).toBeNull()
    expect(telegram.querySelector(".is-changed")).toBeNull()

    await click(document.querySelector('.ui-set-nav a[href="/settings/secret-check"]'))
    expect(document.querySelector("#secret-check .ui-set-clear, #secret-check .is-changed")).toBeNull()

    await click(document.querySelector('.ui-set-nav a[href="/settings/general"]'))
    for (const reset of Array.from(document.querySelectorAll<HTMLElement>("#general .ui-set-clear.is-reset")))
      await click(reset)
    await click(button(en.savebar.save))
    expect(patches).toHaveLength(1)
    expect(Object.keys(patches[0] ?? {}).sort()).toEqual(["closedItemDays", "language", "sessionIdleDays"])
  })

  it("the bot token, a secret, has Replace and Remove but no Changed or Reset; the chat id has Clear", async () => {
    await render("/settings/telegram")
    const token = row(en.telegramSettings.botToken) as HTMLElement
    expect(token.querySelector(".ui-set-clear, .is-changed")).toBeNull()
    expect(button(en.telegramSettings.replace, token)).toBeTruthy()

    const chat = row(en.telegramSettings.chatId) as HTMLElement
    await click(button(en.settings.clear, chat))
    expect(chat.querySelector("input")?.value).toBe("")
    expect(button(en.settings.clear, chat)).toBeUndefined()
    await click(button(en.savebar.save))
    expect(patches).toEqual([{ telegramChatId: null }])
  })
})

describe("numbers read as the save sends them (F2, SV-2, FS-6)", () => {
  it("7, 07, 7.0, 7e0 and a 7 with spaces are all 7: no change against a saved 7, and no Changed", async () => {
    for (const typed of ["7", "07", "7.0", "7e0", " 7 ", "7 "]) expect(typedNumber(typed), typed).toBe(7)
    expect(typedNumber("")).toBeNull()
    expect(typedNumber("seven")).toBeNull()
    for (const typed of ["07", "7.0", "7e0", " 7 "])
      expect(changedFields(SAVED, { closedItemDays: typed, sessionIdleDays: " 30.0 " }), typed).toEqual({})
    expect(changedFields(SAVED, { closedItemDays: "7.5" })).toEqual({ closedItemDays: 7.5 })

    await render("/settings/general")
    // What the number field keeps of each (a browser empties one it cannot read; the draft then holds "").
    for (const typed of ["7.0", "7e0"]) {
      await type(closedDays(), typed)
      expect(closedDays()?.value).toBe(typed)
      expect(count(), typed).toBeNull()
      expect(pill(en.settings.closedDays), typed).toBeUndefined()
      expect(resetOf(en.settings.closedDays), typed).toBeUndefined()
    }
    await type(closedDays(), "7.5")
    expect(pill(en.settings.closedDays)).toBe(en.settings.changed)
  })
})

describe("set by the environment (FS-3, FS-6, R6)", () => {
  it("a locked secret is stored in the environment, with no buttons and the variable named", async () => {
    saved.telegram.botToken = { set: true, readable: true, locked: true, variable: "MIKUD_TELEGRAM_BOT_TOKEN" }
    await render("/settings/telegram")
    const token = row(en.telegramSettings.botToken) as HTMLElement
    expect(pill(en.telegramSettings.botToken)).toBe(en.settings.env.pill)
    expect(token.querySelector(".ui-set-label-line .ui-set-pill")?.getAttribute("title")).toBe(en.settings.env.tooltip)
    expect(token.querySelector(".ui-set-control")?.textContent).toBe(en.telegramSettings.setByEnv)
    expect(token.querySelectorAll(".ui-set-control button")).toHaveLength(0)
    expect(plain(token.querySelector(".ui-set-env")?.textContent)).toBe(
      en.settings.env.note.replace("{variable}", "MIKUD_TELEGRAM_BOT_TOKEN"),
    )
  })

  it("a locked chat id stays in place, disabled, without Clear, and is never sent", async () => {
    saved.telegram.chatId = { value: "70012345", locked: true, variable: "MIKUD_TELEGRAM_CHAT_ID" }
    await render("/settings/telegram")
    const chat = row(en.telegramSettings.chatId) as HTMLElement
    const input = chat.querySelector("input") as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect(input.value).toBe("70012345")
    expect(pill(en.telegramSettings.chatId)).toBe(en.settings.env.pill)
    expect(button(en.settings.clear, chat)).toBeUndefined()
    expect(chat.querySelector(".ui-set-env")?.textContent).toContain("MIKUD_TELEGRAM_CHAT_ID")
    // The label still names the field exactly: the tag sits beside the label, not inside it.
    expect(chat.querySelector("label")?.textContent).toBe(en.telegramSettings.chatId)
  })

  it("an edit to a field that the environment locks before the save is never sent; the rest saves (F1)", async () => {
    await render("/settings/telegram")
    const token = () => row(en.telegramSettings.botToken) as HTMLElement
    await click(button(en.telegramSettings.replace, token()))
    await type(token().querySelector("input"), `${"1234567"}:${"A".repeat(35)}`)
    await type(row(en.telegramSettings.chatId)?.querySelector("input"), "5151")
    await click(document.querySelector('.ui-set-nav a[href="/settings/secret-check"]'))
    await click(
      buttons(document.querySelector("#secret-check") as HTMLElement).find((element) =>
        plain(element.getAttribute("aria-label"))?.endsWith("lab.example"),
      ),
    )
    await click(document.querySelector('.ui-set-nav a[href="/settings/general"]'))
    await type(closedDays(), "9")
    expect(count()).toContain("4")

    // The environment now sets all three (the variables were set and the server restarted); the page reads again.
    // A new answer, not the same object changed in place: the query compares what it gets with what it holds.
    saved = structuredClone(saved)
    saved.telegram.botToken = { set: true, readable: true, locked: true, variable: "MIKUD_TELEGRAM_BOT_TOKEN" }
    saved.telegram.chatId = { value: "70012345", locked: true, variable: "MIKUD_TELEGRAM_CHAT_ID" }
    saved.privateDomains = { value: ["corp.example"], locked: true, variable: "MIKUD_PRIVATE_DOMAINS" }
    await act(async () => {
      await client?.invalidateQueries({ queryKey: qk.settings })
    })
    await settle()
    expect(count()).toContain("1")
    expect(
      Array.from(document.querySelectorAll(".ui-set-nav .ui-set-dot")).map((dot) =>
        dot.closest("a")?.getAttribute("href"),
      ),
    ).toEqual(["/settings/general"])

    await click(button(en.savebar.save))
    expect(patches).toEqual([{ closedItemDays: 9 }])

    // The locked fields show what the environment sets, not the edits made before.
    await click(document.querySelector('.ui-set-nav a[href="/settings/telegram"]'))
    expect(row(en.telegramSettings.chatId)?.querySelector("input")?.value).toBe("70012345")
  })

  it("Telegram off: the test message and the sign-in codes are locked areas that lead to the bot token", async () => {
    saved.telegram = {
      botToken: { set: false, readable: true, locked: false, variable: null },
      chatId: { value: null, locked: false, variable: null },
      state: "off",
      missing: [],
    }
    await render("/settings/telegram")
    const locked = Array.from(document.querySelectorAll<HTMLElement>("#telegram .ui-locked"))
    expect(locked.map((area) => area.querySelector("b")?.textContent)).toEqual([
      en.telegramSettings.testLocked,
      en.telegramSettings.otpLocked,
    ])
    for (const area of locked) expect(area.textContent).toContain(en.telegramSettings.needsTelegram)
    expect(document.querySelector('#telegram [role="switch"]')).toBeNull()
    expect(button(en.settings.telegramTest)).toBeUndefined()

    await click(button(en.telegramSettings.setUp, locked[1]))
    await settle()
    expect(document.activeElement).toBe(row(en.telegramSettings.botToken)?.querySelector("input"))
  })

  it("Telegram off with the codes already on keeps the switch, so they can be turned off", async () => {
    saved.otpViaTelegram = true
    saved.telegram = {
      botToken: { set: false, readable: true, locked: false, variable: null },
      chatId: { value: "4242", locked: false, variable: null },
      state: "incomplete",
      missing: ["botToken"],
    }
    await render("/settings/telegram")
    const toggle = document.querySelector<HTMLInputElement>('#telegram [role="switch"]')
    expect(toggle?.disabled).toBe(false)
    expect(document.querySelectorAll("#telegram .ui-locked")).toHaveLength(1)
    // On differs from the default, off: the switch row marks it, with Reset outside its label.
    expect(pill(en.telegramSettings.otp)).toBe(en.settings.changed)
    expect(resetOf(en.telegramSettings.otp)?.closest("label")).toBeNull()
    expect(plain(resetOf(en.telegramSettings.otp)?.textContent)).toBe(resetLabel(en.settings.off))
  })
})

describe("private domains as value chips (FS-15, S-13)", () => {
  it("are value chips, not filter chips; removing one and adding it back is no change", async () => {
    await render("/settings/secret-check")
    const chips = Array.from(document.querySelectorAll("#secret-check .ui-value-chip"))
    expect(chips.map((chip) => chip.querySelector("bdi")?.textContent)).toEqual(["corp.example", "lab.example"])
    expect(document.querySelector("#secret-check .ui-chip")).toBeNull()

    const remove = buttons(document.querySelector("#secret-check") as HTMLElement).find(
      (element) =>
        plain(element.getAttribute("aria-label")) === en.secretCheck.removeDomain.replace("{domain}", "corp.example"),
    )
    expect(remove?.getAttribute("title")).toBe(en.secretCheck.remove)
    await click(remove)
    expect(count()).toContain("1")
    await type(document.querySelector("#secret-check .ui-domain-add input"), "corp.example")
    await click(button(en.secretCheck.add))
    expect(document.querySelectorAll("#secret-check .ui-value-chip")).toHaveLength(2)
    expect(count()).toBeNull()
  })

  it("set by the environment: chips without their X, the Add field disabled in place", async () => {
    saved.privateDomains = { value: ["corp.example"], locked: true, variable: "MIKUD_PRIVATE_DOMAINS" }
    await render("/settings/secret-check")
    expect(document.querySelectorAll("#secret-check .ui-value-chip")).toHaveLength(1)
    expect(document.querySelector("#secret-check .ui-value-chip-x")).toBeNull()
    expect(document.querySelector<HTMLInputElement>("#secret-check .ui-domain-add input")?.disabled).toBe(true)
    expect(pill(en.secretCheck.domains)).toBe(en.settings.env.pill)
  })
})

describe("the password change in a dialog (S-6, FS-22, DS-9)", () => {
  const field = (label: string) => {
    const id = Array.from(dialog()?.querySelectorAll("label") ?? []).find((l) => l.textContent === label)?.htmlFor
    return document.getElementById(id ?? "") as HTMLInputElement | null
  }
  const open = async () => {
    await render("/account")
    await click(button(en.account.change, document.querySelector("#account-password") as HTMLElement))
    expect(dialog()?.textContent).toContain(en.account.passwordTitle)
  }
  const fill = async (current: string, next: string, repeat: string) => {
    await type(field(en.account.currentPassword), current)
    await type(field(en.account.newPassword), next)
    await type(field(en.account.repeatNewPassword), repeat)
  }
  const submit = () => click(dialog()?.querySelector('button[type="submit"]'))

  it("checks the fields before it sends, naming and focusing the one to fix", async () => {
    await open()
    await submit()
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(en.account.currentMissing)
    expect(document.activeElement).toBe(field(en.account.currentPassword))
    await fill(OLD_PASSWORD, "short", "short")
    await submit()
    expect(field(en.account.newPassword)?.getAttribute("aria-invalid")).toBe("true")
    expect(document.activeElement).toBe(field(en.account.newPassword))
    await fill(OLD_PASSWORD, NEW_PASSWORD, "Invented other password")
    await submit()
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(en.auth.error.mismatch)
    expect(document.activeElement).toBe(field(en.account.repeatNewPassword))
    expect(auth.calls.filter((call) => call.route === "change-password")).toHaveLength(0)
  })

  it("a change closes the dialog without asking and says so", async () => {
    await open()
    await fill(OLD_PASSWORD, NEW_PASSWORD, NEW_PASSWORD)
    await submit()
    await settle()
    expect(auth.calls.find((call) => call.route === "change-password")?.body).toEqual({
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    })
    expect(dialog()).toBeNull()
    expect(question()).toBeNull()
    expect(document.body.textContent).toContain(en.account.changed)
  })

  it("a wrong current password keeps the dialog, empties only that field and focuses it", async () => {
    auth.changePassword = () =>
      Promise.resolve({ data: null, error: { status: 400, code: "INVALID_PASSWORD", message: "Invalid password" } })
    await open()
    await fill("Invented wrong password", NEW_PASSWORD, NEW_PASSWORD)
    await submit()
    await settle()
    expect(dialog()).toBeTruthy()
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(en.account.wrongCurrent)
    expect(field(en.account.currentPassword)?.value).toBe("")
    expect(field(en.account.newPassword)?.value).toBe(NEW_PASSWORD)
    expect(document.activeElement).toBe(field(en.account.currentPassword))
  })

  it("Escape asks before it drops what was typed; Keep editing keeps it, Discard closes", async () => {
    await open()
    await type(field(en.account.currentPassword), OLD_PASSWORD)
    await key("Escape")
    expect(question()?.textContent).toContain(en.unsaved.discardTitle)
    await click(button(en.unsaved.keepEditing, question() as HTMLElement))
    expect(question()).toBeNull()
    expect(field(en.account.currentPassword)?.value).toBe(OLD_PASSWORD)
    await key("Escape")
    await click(button(en.unsaved.discard, question() as HTMLElement))
    expect(dialog()).toBeNull()
  })

  it("a change that succeeds while the discard question is open closes the dialog and the question (F3, DS-9)", async () => {
    let succeed: () => void = () => {}
    auth.changePassword = () =>
      new Promise((resolve) => {
        succeed = () => resolve({ data: { token: "t" }, error: null })
      })
    await open()
    await fill(OLD_PASSWORD, NEW_PASSWORD, NEW_PASSWORD)
    await submit()
    // The request is on its way; Escape asks before dropping what was typed.
    await key("Escape")
    expect(question()?.textContent).toContain(en.unsaved.discardTitle)
    await act(async () => {
      succeed()
    })
    await settle()
    expect(dialog()).toBeNull()
    expect(question()).toBeNull()
    expect(document.body.textContent).toContain(en.account.changed)
  })

  it("Back closes the dialog, asking first when something was typed", async () => {
    vi.spyOn(history, "back").mockImplementation(() => {})
    await open()
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await settle()
    expect(dialog()).toBeNull()

    await click(button(en.account.change, document.querySelector("#account-password") as HTMLElement))
    await type(field(en.account.newPassword), NEW_PASSWORD)
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await settle()
    expect(question()?.textContent).toContain(en.unsaved.discardTitle)
    await click(button(en.unsaved.discard, question() as HTMLElement))
    expect(dialog()).toBeNull()
  })
})

describe("bulk actions at the end of a list's head (S-12, DS-20)", () => {
  const head = (group: string) => document.querySelector<HTMLElement>(`#${group} .ui-set-group-acts`)
  const session = (id: string, userAgent: string): BrowserSession =>
    ({
      id,
      token: `token-${id}`,
      userAgent,
      createdAt: "2026-11-01T08:00:00.000Z",
      expiresAt: "2026-12-01T08:00:00.000Z",
    }) as BrowserSession
  const agentKey = (id: string): AgentKey =>
    ({
      id,
      name: `agent-${id}`,
      start: "mkd_ab",
      createdAt: "2026-11-01T08:00:00.000Z",
      expiresAt: null,
      lastRequest: null,
    }) as AgentKey

  it("Account: Sign out other browsers and Sign out everywhere sit in the browsers' head and ask first", async () => {
    auth.sessions = [
      session("this", "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0"),
      session("other", "Mozilla/5.0 (Linux; Android 14) Chrome/130.0"),
    ]
    await render("/account")
    const acts = head("account-browsers") as HTMLElement
    expect(buttons(acts).map((b) => b.textContent)).toEqual([en.account.endOthers, en.account.endAll])
    await click(button(en.account.endOthers, acts))
    expect(question()?.textContent).toContain(en.account.endOthersTitle)
    await click(button(en.account.endOthers, question() as HTMLElement))
    await settle()
    expect(auth.calls.map((call) => call.route)).toContain("revoke-other-sessions")
    // One browser left: only Sign out everywhere stays.
    expect(buttons(head("account-browsers") as HTMLElement).map((b) => b.textContent)).toEqual([en.account.endAll])
  })

  it("Agent access: Disconnect all sits in the list's head, names the count and deletes every key", async () => {
    auth.keys = [agentKey("k1"), agentKey("k2"), agentKey("k3")]
    await render("/settings/agents")
    const acts = head("settings-agent-keys") as HTMLElement
    await click(button(en.agentKeys.disconnectAll, acts))
    expect(plain(question()?.textContent)).toContain(en.agentKeys.disconnectAllMessage.other.replace("{count}", "3"))
    await click(button(en.agentKeys.disconnectAll, question() as HTMLElement))
    await settle()
    expect(
      auth.calls
        .filter((call) => call.route === "api-key/delete")
        .map((call) => (call.body as { keyId: string }).keyId),
    ).toEqual(["k1", "k2", "k3"])
  })

  it("Suppressions: Remove all sits in the list's head, names the count and removes each one", async () => {
    suppressions = ["a", "b"].map((id) => ({
      id,
      kind: "thread",
      externalId: `thread-${id}`,
      label: `Invented thread ${id}`,
      createdAt: "2026-10-01T08:00:00.000Z",
    }))
    await render("/settings/suppressions")
    const acts = head("settings-suppressed") as HTMLElement
    await click(button(en.suppressions.removeAll, acts))
    expect(plain(question()?.textContent)).toContain(en.suppressions.removeAllMessage.other.replace("{count}", "2"))
    expect(question()?.querySelector(".ui-btn-danger-solid")?.textContent).toBe(en.suppressions.removeAll)
    await click(button(en.suppressions.removeAll, question() as HTMLElement))
    await settle()
    expect(deleted).toEqual(["a", "b"])
    expect(plain(document.body.textContent)).toContain(en.suppressions.removedAll.other.replace("{count}", "2"))
  })

  it("Suppressions with one entry: no Remove all", async () => {
    suppressions = [{ id: "a", kind: "project", externalId: "p-a", label: null, createdAt: "2026-10-01T08:00:00.000Z" }]
    await render("/settings/suppressions")
    expect(head("settings-suppressed")).toBeNull()
  })

  it("removeEvery counts the ones that could not be removed and goes on", async () => {
    const seen: string[] = []
    const failed = await removeEvery(["a", "b", "c"], async (id) => {
      seen.push(id)
      if (id === "b") throw new Error("refused")
    })
    expect(seen).toEqual(["a", "b", "c"])
    expect(failed).toBe(1)
  })
})
