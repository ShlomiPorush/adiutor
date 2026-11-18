// @vitest-environment happy-dom
// Settings, GitHub: the App made from a manifest and GitHub's returns. Create the App on GitHub shows only while no App
// is set and nothing is locked, and posts a form with the manifest to GitHub's address; GitHub's return with a code
// and a state leaves the address at once and is exchanged once, showing the App's owner and fingerprint or the
// refusal with what to do; Install on an account opens GitHub's install page in this tab; and GitHub's return after an
// install shows the installation, adding it only on the owner's Add, or says an organization must approve it. The data
// is invented.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, type ReactNode, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import en from "../../../shared/locales/en.json"
import { setTransport, type TransportRequest } from "../../api/client.ts"
import { qk } from "../../api/endpoints.ts"
import type { GitHubInstallationPreview, GitHubView } from "../../api/types.ts"
import { I18nProvider } from "../../i18n/i18n.tsx"
import { ConfirmHost } from "../../ui/confirm.tsx"
import { ToastHost } from "../../ui/Toast.tsx"
import { UnsavedProvider } from "../../ui/unsaved.tsx"
import { forgetSettingsVisit, SettingsPage } from "../SettingsPage.tsx"
import { leaveFor } from "./GitHubSetup.tsx"

vi.mock("../../api/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/auth.ts")>()
  return { ...real, authClient: {} }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FINGERPRINT = `SHA256:${crypto.randomUUID()}`
const WEB = "https://github.com"

/** No App yet: nothing stored, nothing locked. */
const EMPTY: GitHubView = {
  settings: {
    appId: { value: null, locked: false, variable: null },
    key: { set: false, readable: true, verified: false, fingerprint: null, locked: false, variable: null },
    installations: { value: [], locked: false, variable: null },
    generation: 0,
    on: false,
  },
  status: { state: "off", notCovered: 0, oldestGoodReadAt: null },
  running: false,
  rateLimitedUntil: null,
  lastRun: null,
  installations: [],
  notCovered: [],
  moved: [],
  withoutRepo: [],
}

/** The App set, no installation yet. */
const SET_UP: GitHubView = {
  ...EMPTY,
  settings: {
    ...EMPTY.settings,
    appId: { value: "2097152", locked: false, variable: null },
    key: { set: true, readable: true, verified: true, fingerprint: FINGERPRINT, locked: false, variable: null },
    generation: 1,
  },
}

let view: GitHubView
let calls: { method: string; path: string; body?: unknown }[]
let finishAnswer: { status: number; body: unknown }
let preview: GitHubInstallationPreview

async function transport({ method, path, body }: TransportRequest) {
  if (path.startsWith("/github")) calls.push({ method, path, body })
  if (path === "/github" && method === "GET") return { status: 200, body: { data: view } }
  if (path === "/github/create" && method === "POST")
    return {
      status: 200,
      body: { data: { action: `${WEB}/settings/apps/new?state=s1`, manifest: '{"name":"Adiutor reader 0a1b"}' } },
    }
  if (path === "/github/create/finish" && method === "POST") {
    // The server saved the App: its view from now on.
    if (finishAnswer.status === 200) view = structuredClone(SET_UP)
    return finishAnswer
  }
  if (path === "/github/install" && method === "POST")
    return { status: 200, body: { data: { url: `${WEB}/apps/adiutor-reader-0a1b/installations/new` } } }
  if (/^\/github\/installations\/\d+\/preview$/.test(path) && method === "GET")
    return { status: 200, body: { data: preview } }
  if (path === "/github/installations" && method === "POST") {
    view = {
      ...view,
      settings: { ...view.settings, generation: view.settings.generation + 1 },
      installations: [
        {
          id: preview.id,
          accountId: 7,
          accountType: preview.account.type,
          login: preview.account.login,
          state: null,
          inventory: null,
        },
      ],
    }
    return { status: 201, body: { data: view } }
  }
  return { status: 404, body: { error: { code: "not_found", message: "Not here." } } }
}

let mounted: { root: Root; host: HTMLElement } | null = null
let router: ReturnType<typeof createMemoryRouter>

async function render(entry = "/settings/github"): Promise<void> {
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
  router = createMemoryRouter([{ path: "/settings/:section?", element: frame(<SettingsPage />) }], {
    initialEntries: [entry],
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
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await settle()
}

/** Types into a controlled field as the browser does: the value, then an input event. */
async function type(field: HTMLInputElement | null | undefined, value: string): Promise<void> {
  expect(field).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value)
    field?.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

const question = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
const plain = (text: string | null | undefined) => (text ?? "").replace(/\p{Cf}/gu, "").trim()
const button = (name: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((element) => plain(element.textContent) === name)
const banners = () => Array.from(document.querySelectorAll<HTMLElement>(".ui-banner")).map((b) => plain(b.textContent))
const githubCalls = (method: string, path: string) =>
  calls.filter((call) => call.method === method && call.path === path)

beforeEach(() => {
  forgetSettingsVisit()
  localStorage.clear()
  localStorage.setItem("adiutor.language", "en")
  view = structuredClone(EMPTY)
  calls = []
  finishAnswer = { status: 200, body: { data: { owner: { login: "example-owner", type: "User" }, view: SET_UP } } }
  preview = { id: 51234567, account: { login: "example-org", type: "Organization" }, state: "usable" }
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
  for (const form of document.querySelectorAll("form[action]")) form.remove()
  vi.restoreAllMocks()
})

describe("Create the App on GitHub", () => {
  it("posts a form with the manifest to GitHub's address, in this tab", async () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {})
    await render()
    const create = button(en.githubSettings.create)
    expect(create?.className).toContain("ui-btn-primary")
    await click(create)
    expect(githubCalls("POST", "/github/create")).toHaveLength(1)
    expect(submit).toHaveBeenCalledTimes(1)
    const form = submit.mock.contexts[0] as HTMLFormElement
    expect(form.isConnected).toBe(true)
    expect(form.method).toBe("post")
    expect(form.getAttribute("action")).toBe(`${WEB}/settings/apps/new?state=s1`)
    expect(form.target).toBe("")
    const field = form.querySelector<HTMLInputElement>('input[name="manifest"]')
    expect(field?.type).toBe("hidden")
    expect(field?.value).toBe('{"name":"Adiutor reader 0a1b"}')
  })

  it("is not offered while an App is set or a GitHub field is locked; the paste fields stay", async () => {
    view = structuredClone(SET_UP)
    await render()
    expect(button(en.githubSettings.create)).toBeUndefined()
    expect(document.querySelector("#settings-github-app textarea, #settings-github-app input")).toBeTruthy()
    await act(async () => mounted?.root.unmount())
    mounted?.host.remove()
    mounted = null

    view = {
      ...structuredClone(EMPTY),
      settings: {
        ...EMPTY.settings,
        installations: { value: [], locked: true, variable: "ADIUTOR_GITHUB_INSTALLATIONS" },
      },
    }
    await render()
    expect(button(en.githubSettings.create)).toBeUndefined()
  })
})

describe("GitHub's return after creating the App", () => {
  it("leaves the address at once, exchanges the code once, and shows the owner and the fingerprint", async () => {
    await render("/settings/github?code=c0de&state=st4te")
    expect(router.state.location.pathname).toBe("/settings/github")
    expect(router.state.location.search).toBe("")
    expect(githubCalls("POST", "/github/create/finish")).toEqual([
      { method: "POST", path: "/github/create/finish", body: { code: "c0de", state: "st4te" } },
    ])
    const shown = banners().join("\n")
    expect(shown).toContain(en.githubSettings.created)
    expect(shown).toContain("example-owner")
    expect(shown).toContain(FINGERPRINT)
    // The App is set now: Create is gone, Install is offered.
    expect(button(en.githubSettings.create)).toBeUndefined()
    expect(button(en.githubSettings.install)).toBeTruthy()
    // Back does not bring the code again: the entry was replaced.
    expect(router.state.historyAction).toBe("REPLACE")
  })

  it("shows a refusal with the way to recover", async () => {
    finishAnswer = {
      status: 409,
      body: { error: { code: "github_create_expired", message: "This App creation is unknown." } },
    }
    await render("/settings/github?code=c0de&state=st4te")
    expect(router.state.location.search).toBe("")
    expect(githubCalls("POST", "/github/create/finish")).toHaveLength(1)
    const shown = banners().join("\n")
    expect(shown).toContain(en.githubSettings.createFailed)
    expect(shown).toContain(en.errors.code.github_create_expired)
    expect(shown).toContain(en.githubSettings.createRecovery)
  })
})

describe("Install on an account", () => {
  it("opens GitHub's install page in this tab", async () => {
    view = structuredClone(SET_UP)
    const go = vi.spyOn(leaveFor, "page").mockImplementation(() => {})
    await render()
    await click(button(en.githubSettings.install))
    expect(githubCalls("POST", "/github/install")).toHaveLength(1)
    expect(go).toHaveBeenCalledWith(`${WEB}/apps/adiutor-reader-0a1b/installations/new`)
  })

  it("is not offered while the installations are locked", async () => {
    view = {
      ...structuredClone(SET_UP),
      settings: {
        ...SET_UP.settings,
        installations: { value: [], locked: true, variable: "ADIUTOR_GITHUB_INSTALLATIONS" },
      },
    }
    await render()
    expect(button(en.githubSettings.install)).toBeUndefined()
  })
})

describe("GitHub's return after an install", () => {
  it("shows the installation as GitHub answers it, and adds it only on Add", async () => {
    view = structuredClone(SET_UP)
    await render("/settings/github?installation_id=51234567&setup_action=install")
    expect(router.state.location.search).toBe("")
    expect(calls.filter((call) => call.path === "/github/installations/51234567/preview")).toHaveLength(1)
    expect(githubCalls("POST", "/github/installations")).toHaveLength(0)
    const shown = banners().join("\n")
    expect(shown).toContain("example-org")
    expect(shown).toContain(en.githubSettings.accountType.Organization)
    expect(shown).toContain(en.githubSettings.previewState.usable)
    await click(button(en.githubSettings.add, document.querySelector(".ui-banner") ?? document))
    expect(githubCalls("POST", "/github/installations")).toEqual([
      { method: "POST", path: "/github/installations", body: { generation: 1, installationId: 51234567 } },
    ])
    expect(plain(document.querySelector(".ui-toast")?.textContent)).toContain("example-org")
    expect(banners().join("\n")).not.toContain(en.githubSettings.previewState.usable)
  })

  it("offers no Add for an installation that cannot be added", async () => {
    view = structuredClone(SET_UP)
    preview = { ...preview, state: "too_broad" }
    await render("/settings/github?installation_id=51234567&setup_action=update")
    const banner = document.querySelector<HTMLElement>(".ui-banner")
    expect(plain(banner?.textContent)).toContain(en.githubSettings.previewHint.too_broad)
    expect(button(en.githubSettings.add, banner ?? document)).toBeUndefined()
  })

  it("says an organization's owner must approve a request, and adds nothing", async () => {
    view = structuredClone(SET_UP)
    await render("/settings/github?installation_id=51234567&setup_action=request")
    expect(router.state.location.search).toBe("")
    expect(banners().join("\n")).toContain(en.githubSettings.requestTitle)
    expect(calls.some((call) => call.path.includes("/preview"))).toBe(false)
    expect(githubCalls("POST", "/github/installations")).toHaveLength(0)
  })
})

describe("returns and leaves that change nothing", () => {
  it("says an organization's owner must approve a request that names no installation yet", async () => {
    view = structuredClone(SET_UP)
    await render("/settings/github?setup_action=request")
    expect(router.state.location.search).toBe("")
    expect(banners().join("\n")).toContain(en.githubSettings.requestTitle)
    expect(calls.some((call) => call.path.includes("/preview"))).toBe(false)
  })

  it("offers no Add while the environment sets the installations, and names the variable", async () => {
    view = {
      ...structuredClone(SET_UP),
      settings: {
        ...SET_UP.settings,
        installations: { value: [], locked: true, variable: "ADIUTOR_GITHUB_INSTALLATIONS" },
      },
    }
    preview = { ...preview, state: "locked" }
    await render("/settings/github?installation_id=51234567&setup_action=install")
    const banner = document.querySelector<HTMLElement>(".ui-banner")
    const text = plain(banner?.textContent)
    expect(text).toContain(en.githubSettings.previewState.locked)
    expect(text).toContain("ADIUTOR_GITHUB_INSTALLATIONS")
    expect(text).toContain("51234567")
    expect(button(en.githubSettings.add, banner ?? document)).toBeUndefined()
  })

  it("Create asks about unsaved changes first; Stay keeps the button usable, Leave goes to GitHub", async () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {})
    await render()
    await type(document.querySelector<HTMLInputElement>("#settings-github-app input"), "123456")
    await click(button(en.githubSettings.create))
    expect(question()).toBeTruthy()
    await click(button(en.unsaved.stay, question() ?? document))
    expect(question()).toBeNull()
    expect(githubCalls("POST", "/github/create")).toHaveLength(0)
    const create = button(en.githubSettings.create)
    expect(create?.disabled).toBe(false)

    await click(create)
    await click(button(en.unsaved.leave, question() ?? document))
    expect(githubCalls("POST", "/github/create")).toHaveLength(1)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(button(en.githubSettings.creating)?.disabled).toBe(true)
    // Back from GitHub to this page as the browser kept it: the button is usable again.
    await act(async () => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }))
    })
    expect(button(en.githubSettings.create)?.disabled).toBe(false)
  })

  it("Install asks about unsaved changes first, and Stay keeps the button usable", async () => {
    view = structuredClone(SET_UP)
    const go = vi.spyOn(leaveFor, "page").mockImplementation(() => {})
    await render()
    await type(document.querySelector<HTMLInputElement>("#settings-github-app input"), "123456")
    await click(button(en.githubSettings.install))
    await click(button(en.unsaved.stay, question() ?? document))
    expect(githubCalls("POST", "/github/install")).toHaveLength(0)
    expect(go).not.toHaveBeenCalled()
    expect(button(en.githubSettings.install)?.disabled).toBe(false)
  })
})
