// @vitest-environment happy-dom
// Settings, GitHub (v3 FS-3, FS-6, FS-16, FB-1, DS-20, SV-1): the private key's states (not set, stored with its
// fingerprint, accepted or not verified yet, unreadable, set by the environment); a pasted key saved with the one save
// bar to /github/app with the generation, and emptied from the draft after the save and after a refusal; a paste that
// is not a key refused before it is sent; Remove asks first and tells the owner to uninstall the App on GitHub too; a
// locked list has no Add or Remove; Add is a locked area until the App is set up; and Read now is locked while GitHub
// is not set up or asked to wait, and joins a read that runs. The data is invented; the key is made on every run.

import { generateKeyPairSync } from "node:crypto"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, type ReactNode, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import en from "../../../shared/locales/en.json"
import { setTransport, type TransportRequest } from "../../api/client.ts"
import { qk } from "../../api/endpoints.ts"
import type { GitHubView } from "../../api/types.ts"
import { I18nProvider } from "../../i18n/i18n.tsx"
import { ConfirmHost } from "../../ui/confirm.tsx"
import { ToastHost } from "../../ui/Toast.tsx"
import { UnsavedProvider } from "../../ui/unsaved.tsx"
import { forgetSettingsVisit, SettingsPage } from "../SettingsPage.tsx"
import { githubChanges, readNowBlocked } from "./GitHubSection.tsx"

vi.mock("../../api/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/auth.ts")>()
  return { ...real, authClient: {} }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A private key in PEM form, new on every run; nothing accepts it but the page's own check. */
const PEM = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const FINGERPRINT = `SHA256:${crypto.randomUUID()}`

const VIEW: GitHubView = {
  settings: {
    appId: { value: "1048576", locked: false, variable: null },
    key: { set: true, readable: true, verified: true, fingerprint: FINGERPRINT, locked: false, variable: null },
    installations: {
      value: [{ id: 51234567, accountId: 7, accountType: "Organization", login: "example-org" }],
      locked: false,
      variable: null,
    },
    generation: 7,
    on: true,
  },
  status: { state: "fine", notCovered: 0, oldestGoodReadAt: null },
  running: false,
  rateLimitedUntil: null,
  lastRun: {
    startedAt: "2026-11-18T07:00:00.000Z",
    finishedAt: "2026-11-18T07:01:00.000Z",
    outcome: "succeeded",
    counts: { installations: 1, installationsRead: 1, projects: 2, projectsWritten: 2, enabled: 6 },
    errors: [],
  },
  installations: [
    {
      id: 51234567,
      accountId: 7,
      accountType: "Organization",
      login: "example-org",
      state: "usable",
      inventory: { complete: true, repos: 4 },
    },
  ],
  notCovered: [],
  moved: [],
  withoutRepo: [{ id: "p-orchard", name: "Orchard" }],
}

let view: GitHubView
let calls: { method: string; path: string; body?: unknown }[]
/** The answer to the next PATCH /github/app, when it is refused. */
let refusal: { status: number; body: unknown } | null

async function transport({ method, path, body }: TransportRequest) {
  if (path.startsWith("/github")) calls.push({ method, path, body })
  if (path === "/github" && method === "GET") return { status: 200, body: { data: view } }
  if (path === "/github/app" && method === "PATCH") {
    if (refusal) return refusal
    const patch = body as { privateKey?: string | null }
    if (typeof patch.privateKey === "string")
      view = {
        ...view,
        settings: { ...view.settings, generation: view.settings.generation + 1, key: { ...view.settings.key } },
      }
    return { status: 200, body: { data: view } }
  }
  if (path.startsWith("/github/installations/") && method === "DELETE") {
    view = {
      ...view,
      installations: [],
      settings: { ...view.settings, installations: { ...view.settings.installations, value: [] } },
    }
    return { status: 200, body: { data: view } }
  }
  if (path === "/github/pull" && method === "POST")
    return { status: 202, body: { data: { joined: view.running, view: { ...view, running: true } } } }
  return { status: 404, body: { error: { code: "not_found", message: "Not here." } } }
}

let mounted: { root: Root; host: HTMLElement } | null = null

async function render(): Promise<void> {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted = { root, host }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(qk.session, { actor: { kind: "owner", label: "owner.name" } })
  const frame = (page: ReactNode) => (
    <UnsavedProvider>
      {page}
      <ConfirmHost />
      <ToastHost />
    </UnsavedProvider>
  )
  const router = createMemoryRouter([{ path: "/settings/:section?", element: frame(<SettingsPage />) }], {
    initialEntries: ["/settings/github"],
  })
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
  // The owner cannot reach what a folded group hides.
  expect(element?.closest("[hidden]")).toBeNull()
  await act(async () => {
    ;(element as HTMLElement).focus()
    ;(element as HTMLElement).click()
  })
  await settle()
}

/** Types into a controlled field as the browser does: the value, then an input event. */
async function type(field: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string): Promise<void> {
  expect(field).toBeTruthy()
  expect(field?.closest("[hidden]")).toBeNull()
  await act(async () => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value)
    field?.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

/** Text as read: the i18n wraps each value in direction isolates. */
const plain = (text: string | null | undefined) => (text ?? "").replace(/\p{Cf}/gu, "").trim()
const button = (name: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((element) => plain(element.textContent) === name)
const row = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(".ui-set-row")).find(
    (element) => element.querySelector(".ui-set-label-line b")?.textContent === label,
  )
const keyRow = () => row(en.githubSettings.key)
const keyField = () => keyRow()?.querySelector("textarea")
const group = (id: string) => document.getElementById(id)
const appFold = () => group("settings-github-app")?.querySelector<HTMLButtonElement>(".ui-fold-btn") ?? null
/** Opens the GitHub App group from its head, as the owner does once the App is set up. */
async function openApp(): Promise<void> {
  await click(appFold())
  expect(appFold()?.getAttribute("aria-expanded")).toBe("true")
}
const question = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
const saveBar = () => document.querySelector(".ui-savebar")
const readNow = () => button(en.githubSettings.readNow, group("settings-github-pull") ?? document)
const githubCalls = (method: string, path: string) =>
  calls.filter((call) => call.method === method && call.path.startsWith(path))

const withKey = (key: Partial<GitHubView["settings"]["key"]>): GitHubView => ({
  ...VIEW,
  settings: { ...VIEW.settings, key: { ...VIEW.settings.key, ...key } },
})

beforeEach(() => {
  forgetSettingsVisit()
  localStorage.clear()
  localStorage.setItem("adiutor.language", "en")
  view = structuredClone(VIEW)
  calls = []
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
  vi.restoreAllMocks()
})

describe("the private key's states (FS-3)", () => {
  it("not set: a paste field, nothing stored", async () => {
    view = withKey({ set: false, verified: false, fingerprint: null })
    await render()
    expect(keyField()?.placeholder).toBe(en.githubSettings.keyPlaceholder)
    expect(keyField()?.value).toBe("")
    expect(button(en.githubSettings.keyReplace)).toBeUndefined()
  })

  it("stored and accepted: Stored with Replace, Remove and its fingerprint, never a paste field", async () => {
    await render()
    // Set up: the group starts folded, says so in its head, and opens from there.
    expect(plain(appFold()?.textContent)).toContain(en.githubSettings.appSetUp)
    expect(appFold()?.getAttribute("aria-expanded")).toBe("false")
    expect(keyRow()?.closest("[hidden]")).not.toBeNull()
    await openApp()
    const text = plain(keyRow()?.textContent)
    expect(text).toContain(en.githubSettings.keyStored)
    expect(text).toContain(en.githubSettings.keyAccepted)
    expect(text).toContain(FINGERPRINT)
    expect(keyField()).toBeNull()
    await click(button(en.githubSettings.keyReplace))
    expect(keyField()).toBeTruthy()
    expect(document.activeElement).toBe(keyField())
  })

  it("not verified yet: says so and that the next read checks it", async () => {
    view = withKey({ verified: false })
    await render()
    // A key GitHub has not accepted (or refused on a later read) holds the group open, marked in its head.
    expect(keyRow()?.closest("[hidden]")).toBeNull()
    expect(appFold()).toBeNull()
    expect(plain(group("settings-github-app-title")?.textContent)).toContain(en.githubSettings.appCheckKey)
    const text = plain(keyRow()?.textContent)
    expect(text).toContain(en.githubSettings.keyNotVerified)
    expect(text).toContain(en.githubSettings.keyNotVerifiedHint)
  })

  it("unreadable: asks for the key again, with a paste field and Remove", async () => {
    view = withKey({ readable: false, verified: false })
    await render()
    expect(plain(keyRow()?.textContent)).toContain(en.githubSettings.keyUnreadable)
    expect(keyField()).toBeTruthy()
    expect(button(en.githubSettings.keyRemove, keyRow())).toBeTruthy()
  })

  it("set by the environment: locked with its variable, no buttons and no paste field", async () => {
    view = withKey({ locked: true, variable: "ADIUTOR_GITHUB_PRIVATE_KEY", verified: null })
    await render()
    const text = plain(keyRow()?.textContent)
    expect(text).toContain(en.githubSettings.keySetByEnv)
    expect(text).toContain("ADIUTOR_GITHUB_PRIVATE_KEY")
    expect(keyRow()?.querySelector(".ui-set-pill")).toBeTruthy()
    expect(keyField()).toBeNull()
    expect(button(en.githubSettings.keyReplace)).toBeUndefined()
  })
})

describe("saving the App with the one save bar (SV-1)", () => {
  it("sends a pasted key with the generation, then empties it from the draft", async () => {
    view = withKey({ set: false, verified: false, fingerprint: null })
    await render()
    await type(keyField(), PEM)
    expect(plain(saveBar()?.textContent)).toContain(en.savebar.count.one)
    await click(button(en.savebar.save))
    await settle()
    expect(githubCalls("PATCH", "/github/app").map((call) => call.body)).toEqual([
      { generation: 7, privateKey: PEM.trim() },
    ])
    expect(saveBar()).toBeNull()
  })

  it("a refused key leaves the draft too, and the field says why", async () => {
    view = withKey({ set: false, verified: false, fingerprint: null })
    refusal = {
      status: 422,
      body: { error: { code: "github_key_rejected", message: "GitHub did not accept this key for the App." } },
    }
    await render()
    await type(keyField(), PEM)
    await click(button(en.savebar.save))
    await settle()
    expect(githubCalls("PATCH", "/github/app")).toHaveLength(1)
    expect(keyField()?.value).toBe("")
    expect(keyField()?.getAttribute("aria-invalid")).toBe("true")
    expect(plain(keyRow()?.textContent)).toContain(en.errors.code.github_key_rejected)
    expect(saveBar()).toBeNull()
  })

  it("a paste that is not a key is refused before it is sent, and leaves the draft", async () => {
    view = withKey({ set: false, verified: false, fingerprint: null })
    await render()
    await type(keyField(), "not a key at all")
    await click(button(en.savebar.save))
    expect(githubCalls("PATCH", "/github/app")).toHaveLength(0)
    expect(keyField()?.value).toBe("")
    expect(plain(keyRow()?.textContent)).toContain(en.githubSettings.keyInvalid)
  })

  it("an App id that is not a number is refused before it is sent", async () => {
    await render()
    await openApp()
    await type(row(en.githubSettings.appId)?.querySelector("input"), "12ab")
    // An edit holds the group open: no fold button while it waits, so the field and its refusal cannot be hidden.
    expect(appFold()).toBeNull()
    await click(button(en.savebar.save))
    expect(githubCalls("PATCH", "/github/app")).toHaveLength(0)
    expect(plain(row(en.githubSettings.appId)?.textContent)).toContain(en.githubSettings.appIdInvalid)
    expect(row(en.githubSettings.appId)?.closest("[hidden]")).toBeNull()
    expect(document.activeElement).toBe(row(en.githubSettings.appId)?.querySelector("input"))
    expect(appFold()).toBeNull()
  })

  it("a first setup holds the App group open, with Not set up in its head", async () => {
    view = { ...VIEW, settings: { ...VIEW.settings, appId: { value: null, locked: false, variable: null } } }
    await render()
    expect(appFold()).toBeNull()
    expect(plain(group("settings-github-app-title")?.textContent)).toContain(en.githubSettings.appNotSetUp)
    expect(row(en.githubSettings.appId)?.closest("[hidden]")).toBeNull()
  })

  it("githubChanges sends only what differs, and never a locked field", () => {
    expect(githubChanges(VIEW, { githubAppId: " 1048576 " })).toEqual({})
    expect(githubChanges(VIEW, { githubAppId: "" })).toEqual({ appId: null })
    expect(githubChanges(VIEW, { githubKey: { mode: "replace", value: "  " } })).toEqual({})
    expect(githubChanges(VIEW, { githubKey: { mode: "remove" } })).toEqual({ privateKey: null })
    const locked = withKey({ locked: true, variable: "ADIUTOR_GITHUB_PRIVATE_KEY" })
    expect(githubChanges(locked, { githubKey: { mode: "replace", value: PEM } })).toEqual({})
  })
})

describe("installations (FS-16, DS-20, FB-1)", () => {
  it("Remove asks first, tells the owner to uninstall the App on GitHub too, then removes it with the generation", async () => {
    await render()
    await click(button(en.githubSettings.remove, group("settings-github-installations") ?? document))
    const message = en.githubSettings.removeMessage.replace("{name}", "example-org")
    expect(plain(question()?.textContent)).toContain(message)
    expect(message).toContain("Uninstall")
    await click(button(en.githubSettings.remove, question() as HTMLElement))
    await settle()
    expect(githubCalls("DELETE", "/github/installations/").map((call) => call.path)).toEqual([
      "/github/installations/51234567?generation=7",
    ])
  })

  it("a list the environment sets names its variable and offers no Add or Remove", async () => {
    view = {
      ...VIEW,
      settings: {
        ...VIEW.settings,
        installations: { ...VIEW.settings.installations, locked: true, variable: "ADIUTOR_GITHUB_INSTALLATIONS" },
      },
    }
    await render()
    const list = group("settings-github-installations")
    expect(plain(list?.textContent)).toContain("ADIUTOR_GITHUB_INSTALLATIONS")
    expect(button(en.githubSettings.remove, list ?? document)).toBeUndefined()
    expect(button(en.githubSettings.add, list ?? document)).toBeUndefined()
  })

  it("Add is a locked area until the App has its id and key", async () => {
    const unset = withKey({ set: false, verified: false, fingerprint: null })
    view = {
      ...unset,
      installations: [],
      settings: { ...unset.settings, installations: { ...unset.settings.installations, value: [] }, on: false },
    }
    await render()
    const list = group("settings-github-installations")
    expect(plain(list?.querySelector(".ui-locked")?.textContent)).toContain(en.githubSettings.addLocked)
    expect(button(en.githubSettings.add, list ?? document)).toBeUndefined()
  })
})

describe("Read now (FB-1)", () => {
  it("is locked while GitHub is not set up, and says why", async () => {
    view = { ...VIEW, settings: { ...VIEW.settings, on: false } }
    await render()
    expect(readNow()?.disabled).toBe(true)
    expect(plain(group("settings-github-pull")?.textContent)).toContain(en.githubSettings.readBlocked.not_set_up)
  })

  it("is locked while GitHub asked to wait, and says until when", async () => {
    view = { ...VIEW, rateLimitedUntil: new Date(Date.now() + 600_000).toISOString() }
    await render()
    expect(readNow()?.disabled).toBe(true)
    expect(plain(group("settings-github-pull")?.textContent)).toContain(en.githubSettings.rateLimited)
  })

  it("starts a read when it can, and joins one that runs", async () => {
    await render()
    expect(readNow()?.disabled).toBe(false)
    await click(readNow())
    expect(githubCalls("POST", "/github/pull")).toHaveLength(1)
    expect(plain(document.querySelector(".ui-toast")?.textContent)).toContain(en.githubSettings.readStarted)
  })

  it("stays usable while a read runs, shows it, and a press joins it", async () => {
    view = { ...VIEW, running: true }
    await render()
    expect(plain(group("settings-github-pull")?.textContent)).toContain(en.githubSettings.running)
    expect(readNow()?.disabled).toBe(false)
    await click(readNow())
    expect(plain(document.querySelector(".ui-toast")?.textContent)).toContain(en.githubSettings.readJoined)
  })

  it("readNowBlocked follows the settings and the rate limit's end", () => {
    const now = Date.parse("2026-11-18T08:00:00.000Z")
    expect(readNowBlocked(VIEW, now)).toBeNull()
    expect(readNowBlocked({ ...VIEW, settings: { ...VIEW.settings, on: false } }, now)).toBe("not_set_up")
    expect(readNowBlocked({ ...VIEW, rateLimitedUntil: "2026-11-18T08:05:00.000Z" }, now)).toBe("rate_limited")
    expect(readNowBlocked({ ...VIEW, rateLimitedUntil: "2026-11-18T07:55:00.000Z" }, now)).toBeNull()
  })
})

describe("projects GitHub cannot read", () => {
  it("lists projects without a repository, each opening its page", async () => {
    await render()
    const link = group("settings-github-without-repo")?.querySelector("a")
    expect(link?.getAttribute("href")).toBe("/projects/p-orchard")
    expect(plain(link?.textContent)).toBe("Orchard")
  })
})
