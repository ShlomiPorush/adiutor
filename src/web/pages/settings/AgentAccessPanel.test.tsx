// @vitest-environment happy-dom
// Settings, Agent access: the error for any failed read, a failed refresh said with Try again while the data stays,
// and the panel: the switch and the idle days in the page's one draft and save bar (the save asks first when it ends
// connections), how to connect (the MCP address, the Claude Code command, the skill sentence, the sync bundle's
// commands) or why agents cannot, the connections with Disconnect, Disconnect all, there even with no connection, and
// the old agent keys while any is left.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import en from "../../../shared/locales/en.json"
import { SETTINGS_DEFAULTS } from "../../../shared/settings.ts"
import { setTransport, type TransportRequest, type TransportResponse } from "../../api/client.ts"
import { qk } from "../../api/endpoints.ts"
import type { AgentConnection, AgentSettings, Settings } from "../../api/types.ts"
import { I18nProvider } from "../../i18n/i18n.tsx"
import { ConfirmHost } from "../../ui/confirm.tsx"
import { ToastHost } from "../../ui/Toast.tsx"
import { UnsavedProvider } from "../../ui/unsaved.tsx"
import { forgetSettingsVisit, SettingsPage } from "../SettingsPage.tsx"
import { agentChanges, claudeCommand, idleDaysOf, skillSentence } from "./AgentAccessPanel.tsx"

/** Better Auth's key list and delete, as the old keys' group calls them. */
const oldKeys = vi.hoisted(() => ({
  keys: [] as {
    id: string
    name: string | null
    start: string | null
    createdAt: string
    expiresAt: null
    lastRequest: null
  }[],
  deleted: [] as string[],
}))
vi.mock("../../api/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/auth.ts")>()
  return {
    ...real,
    authClient: {
      apiKey: {
        list: () => Promise.resolve({ data: { apiKeys: oldKeys.keys }, error: null }),
        delete: ({ keyId }: { keyId: string }) => {
          oldKeys.deleted.push(keyId)
          oldKeys.keys = oldKeys.keys.filter((k) => k.id !== keyId)
          return Promise.resolve({ data: { success: true }, error: null })
        },
      },
    },
  }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISSUER = "https://adiutor.example.com"
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
  privateDomains: { value: ["corp.example"], locked: false, variable: null },
}

let agents: AgentSettings
let agentsStatus: number | "proxy404"
let settingsStatus: number
/** While set, a PATCH of the agent settings waits for it (a save still on its way). */
let agentPatchGate: Promise<void> | null
let connectionsStatus: number
let connections: AgentConnection[]
let requests: TransportRequest[]
let mounted: { root: Root; host: HTMLElement } | null = null
let client: QueryClient

const connection = (id: string, name: string): AgentConnection => ({
  id,
  name,
  via: "code",
  resource: "rest",
  areas: ["read", "sync"],
  redirectHost: null,
  approvedAt: "2026-11-01T08:00:00.000Z",
  lastUsedAt: null,
  endsAt: "2027-01-30T08:00:00.000Z",
})

const failure = (status: number): TransportResponse =>
  status === 404
    ? { status: 404, body: { error: { code: "not_found", message: "Nothing is here." } } }
    : { status, body: { error: { code: "internal_error", message: "Down." } } }

async function transport(request: TransportRequest): Promise<TransportResponse> {
  requests.push(request)
  const { method, path, body } = request
  if (path === "/settings" && method === "GET")
    return settingsStatus === 200 ? { status: 200, body: { data: SAVED } } : failure(settingsStatus)
  if (path === "/settings" && method === "PATCH") return { status: 200, body: { data: SAVED } }
  if (path === "/agents/settings" && method === "GET") {
    // A proxy's own 404 page: no JSON, so the client reads only the status.
    if (agentsStatus === "proxy404") return { status: 404, body: null }
    return agentsStatus === 200 ? { status: 200, body: agents } : failure(agentsStatus)
  }
  if (path === "/agents/settings" && method === "PATCH") {
    if (agentPatchGate) await agentPatchGate
    agents = { ...agents, ...(body as object) }
    return { status: 200, body: { enabled: agents.enabled, idleDays: agents.idleDays } }
  }
  if (path === "/agents/connections" && method === "GET")
    return connectionsStatus === 200 ? { status: 200, body: { connections } } : failure(connectionsStatus)
  if (path.startsWith("/agents/connections/") && method === "DELETE") {
    connections = connections.filter((c) => !path.endsWith(c.id))
    return { status: 204, body: null }
  }
  if (path === "/agents/connections/disconnect-all" && method === "POST") {
    const ended = connections.length
    connections = []
    return { status: 200, body: { ended } }
  }
  return failure(404)
}

beforeEach(() => {
  forgetSettingsVisit()
  localStorage.clear()
  localStorage.setItem("adiutor.language", "en")
  agents = {
    enabled: true,
    idleDays: 90,
    issuer: ISSUER,
    issuerProblem: null,
    mcpUrl: `${ISSUER}/mcp`,
    restUrl: `${ISSUER}/api/v1`,
  }
  agentsStatus = 200
  settingsStatus = 200
  agentPatchGate = null
  connectionsStatus = 200
  connections = []
  requests = []
  oldKeys.keys = []
  oldKeys.deleted = []
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

async function settle(ms = 40): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function render(path = "/settings/agents"): Promise<void> {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted = { root, host }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(qk.session, { actor: { kind: "owner", label: "owner.name" } })
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
      { path: "/", element: frame(<p data-testid="board">board</p>) },
    ],
    { initialEntries: [path] },
  )
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <RouterProvider router={router} />
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
  await settle()
}

const plain = (text: string | null | undefined) => text?.replace(/[⁦-⁩]/g, "").trim() ?? ""
const page = () => plain(document.body.textContent)
const buttons = (scope: ParentNode = document) => Array.from(scope.querySelectorAll<HTMLButtonElement>("button"))
const button = (name: string, scope: ParentNode = document) =>
  buttons(scope).find((element) => plain(element.textContent) === name)
const question = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
const switchBox = () => document.querySelector<HTMLInputElement>('#settings-agents input[role="switch"]')
const daysField = () => document.querySelector<HTMLInputElement>('#settings-agents input[type="number"]')
const unsaved = () => plain(document.querySelector(".ui-savebar-count")?.textContent) || null
const writes = () => requests.filter((r) => r.method !== "GET")
const refetch = async (key: readonly string[]) => {
  await act(async () => {
    await client.refetchQueries({ queryKey: key })
  })
  await settle()
}

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await settle()
}

async function type(input: HTMLInputElement | null, value: string): Promise<void> {
  expect(input).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value)
    input?.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

describe("a failed read", () => {
  it.each([404, 500])("shows the failure with Try again for %s, then the panel once the read works", async (status) => {
    agentsStatus = status
    await render()
    expect(page()).toContain(en.agentAccess.failed)
    expect(switchBox()).toBeNull()
    agentsStatus = 200
    await click(button(en.common.tryAgain))
    expect(switchBox()).not.toBeNull()
  })

  it("treats a proxy's 404 page as a failure, also on a refresh", async () => {
    agentsStatus = "proxy404"
    await render()
    expect(page()).toContain(en.agentAccess.failed)
    agentsStatus = 200
    await click(button(en.common.tryAgain))
    expect(switchBox()).not.toBeNull()
    agentsStatus = "proxy404"
    await refetch(qk.agentSettings)
    expect(switchBox()).not.toBeNull()
    expect(page()).toContain(en.agentAccess.refreshFailed)
  })
})

describe("a refresh that fails", () => {
  it("keeps the panel and the list, says so, and Try again reads again", async () => {
    connections = [connection("c1", "Laptop sync")]
    await render()
    agentsStatus = 500
    connectionsStatus = 500
    await refetch(qk.agentSettings)
    await refetch(qk.agentConnections)
    expect(switchBox()).not.toBeNull()
    expect(document.querySelectorAll("[data-testid=agent-connection]")).toHaveLength(1)
    const notices = Array.from(document.querySelectorAll(".ui-banner")).filter((b) =>
      plain(b.textContent).includes(en.agentAccess.refreshFailed),
    )
    expect(notices).toHaveLength(2)
    agentsStatus = 200
    settingsStatus = 200
    agentPatchGate = null
    connectionsStatus = 200
    for (const notice of notices) await click(button(en.common.tryAgain, notice))
    expect(page()).not.toContain(en.agentAccess.refreshFailed)
  })

  it("never shows a stale empty list without saying so", async () => {
    await render()
    expect(page()).toContain(en.agentAccess.empty)
    connectionsStatus = 500
    await refetch(qk.agentConnections)
    expect(page()).toContain(en.agentAccess.refreshFailed)
  })
})

describe("the new panel", () => {
  it("shows the switch, the idle days, how to connect, and Disconnect all with no connection", async () => {
    await render()
    expect(page()).toContain(en.agentAccess.hint)
    expect(switchBox()?.checked).toBe(true)
    expect(daysField()?.value).toBe("90")
    expect(page()).toContain(`${ISSUER}/mcp`)
    expect(claudeCommand(`${ISSUER}/mcp`)).toBe(`claude mcp add --transport http adiutor "${ISSUER}/mcp"`)
    expect(page()).toContain(claudeCommand(`${ISSUER}/mcp`))
    // The agent-access standard's sentence, with the address where the skill is served.
    expect(skillSentence(ISSUER)).toBe(
      `Install the adiutor skill into your personal skills folder as described at ${ISSUER}/agents/skill/, then connect to Adiutor.`,
    )
    expect(page()).toContain(skillSentence(ISSUER))
    // The sync connects from its tray app: no sync group and no command of the sync bundle; nothing of the agent keys'.
    expect(document.querySelector("#settings-connect-sync")).toBeNull()
    expect(page()).not.toContain("adiutor-sync")
    expect(page()).not.toContain("--days")
    expect(page()).not.toMatch(/--for (sync|claude|codex) *$|connect --url [^ ]+ --name [^ ]+ --for/)
    expect(page()).toContain(en.agentAccess.empty)
    // No old key left: no group for them.
    expect(document.querySelector("#settings-agent-keys")).toBeNull()
    const head = document.querySelector("#settings-agent-connections .ui-set-group-acts") as HTMLElement
    expect(button(en.agentAccess.disconnectAll, head)).toBeTruthy()
  })

  it("lists each connection: name, how it connected, areas and its times, with Disconnect after a question", async () => {
    connections = [connection("c1", "Laptop sync"), connection("c2", "Claude Code")]
    await render()
    const rows = Array.from(document.querySelectorAll("[data-testid=agent-connection]"))
    expect(rows.map((row) => plain(row.querySelector("bdi")?.textContent))).toEqual(["Laptop sync", "Claude Code"])
    const first = plain(rows[0]?.textContent)
    expect(first).toContain(en.agentAccess.via.code)
    expect(first).toContain(en.agentAccess.resource.rest)
    expect(first).toContain(`${en.consent.areas.read.name}, ${en.consent.areas.sync.name}`)
    expect(first).toContain(en.agentAccess.never)
    await click(button(en.agentAccess.disconnect, rows[0] as HTMLElement))
    expect(plain(question()?.textContent)).toContain(en.agentAccess.disconnectTitle.replace("{name}", "Laptop sync"))
    await click(button(en.agentAccess.disconnect, question() as HTMLElement))
    expect(writes()).toEqual([{ method: "DELETE", path: "/agents/connections/c1" }])
    expect(document.querySelectorAll("[data-testid=agent-connection]")).toHaveLength(1)
  })

  it("Disconnect all asks with the count, then ends everything; with none it still ends waiting requests", async () => {
    connections = [connection("c1", "A"), connection("c2", "B")]
    await render()
    await click(button(en.agentAccess.disconnectAll))
    expect(plain(question()?.textContent)).toContain(en.agentAccess.disconnectAllMessage.other.replace("{count}", "2"))
    await click(button(en.agentAccess.disconnectAll, question() as HTMLElement))
    expect(writes().map((w) => w.path)).toEqual(["/agents/connections/disconnect-all"])
    expect(page()).toContain(en.agentAccess.empty)
    await click(button(en.agentAccess.disconnectAll))
    expect(plain(question()?.textContent)).toContain(en.agentAccess.disconnectAllNone)
  })

  it("replaces how to connect with the reason when the public URL does not allow agents", async () => {
    agents = { ...agents, issuer: null, issuerProblem: "plain_http", mcpUrl: null, restUrl: null }
    await render()
    expect(page()).toContain(en.agentAccess.issuerTitle)
    expect(page()).toContain(en.agentAccess.issuer.plain_http)
    expect(page()).not.toContain("claude mcp add")
    expect(page()).not.toContain("adiutor-sync.js")
  })
})

describe("the old agent keys", () => {
  it("are listed while any is left, saying Adiutor refuses them, and deleted after a question", async () => {
    oldKeys.keys = [
      {
        id: "k1",
        name: "sync",
        start: "adt_Qe",
        createdAt: "2026-10-01T08:00:00.000Z",
        expiresAt: null,
        lastRequest: null,
      },
      {
        id: "k2",
        name: "claude",
        start: "adt_tR",
        createdAt: "2026-10-02T08:00:00.000Z",
        expiresAt: null,
        lastRequest: null,
      },
    ]
    await render()
    const group = document.querySelector("#settings-agent-keys") as HTMLElement
    expect(plain(group.textContent)).toContain(en.agentKeys.oldTitle)
    expect(plain(group.textContent)).toContain(en.agentKeys.oldNote)
    expect(group.querySelectorAll("[data-testid=old-agent-key]")).toHaveLength(2)
    const first = group.querySelector("[data-testid=old-agent-key]") as HTMLElement
    await click(button(en.agentKeys.delete, first))
    expect(plain(question()?.textContent)).toContain(en.agentKeys.deleteTitle.replace("{name}", "claude"))
    await click(button(en.agentKeys.delete, question() as HTMLElement))
    expect(oldKeys.deleted).toEqual(["k2"])
    expect(document.querySelectorAll("[data-testid=old-agent-key]")).toHaveLength(1)
  })
})

describe("the switch and the idle days in the page's draft (SV-1)", () => {
  it("holds a change in the save bar, guarded against leaving, until Save", async () => {
    await render()
    await type(daysField(), "120")
    expect(writes()).toEqual([])
    expect(unsaved()).not.toBeNull()
    expect(document.querySelector('.ui-set-nav a[href="/settings/agents"] .ui-set-dot')).not.toBeNull()
    await click(button(en.savebar.discard))
    expect(daysField()?.value).toBe("90")
    expect(unsaved()).toBeNull()
    await type(daysField(), "120")
    await click(button(en.savebar.save))
    expect(question()).toBeNull()
    expect(writes()).toEqual([{ method: "PATCH", path: "/agents/settings", body: { idleDays: 120 } }])
    expect(unsaved()).toBeNull()
    expect(daysField()?.value).toBe("120")
  })

  it("asks before a save that turns agents off; Cancel keeps the draft and sends nothing", async () => {
    await render()
    await click(switchBox())
    expect(switchBox()?.checked).toBe(false)
    expect(writes()).toEqual([])
    await click(button(en.savebar.save))
    expect(plain(question()?.textContent)).toContain(en.agentAccess.offMessage)
    await click(button(en.common.cancel, question() as HTMLElement))
    expect(writes()).toEqual([])
    expect(unsaved()).not.toBeNull()
    await click(button(en.savebar.save))
    await click(button(en.agentAccess.offConfirm, question() as HTMLElement))
    expect(writes()).toEqual([{ method: "PATCH", path: "/agents/settings", body: { enabled: false } }])
    expect(switchBox()?.checked).toBe(false)
    expect(page()).toContain(en.agentAccess.offNote)
  })

  it("asks before fewer idle days, refuses a number outside 1 to 365 with the field marked, and saves both settings", async () => {
    await render()
    await type(daysField(), "400")
    await click(button(en.savebar.save))
    expect(writes()).toEqual([])
    expect(daysField()?.getAttribute("aria-invalid")).toBe("true")
    expect(page()).toContain(en.agentAccess.idleInvalid)
    await type(daysField(), "30")
    await click(switchBox())
    await click(switchBox())
    await click(button(en.savebar.save))
    expect(plain(question()?.textContent)).toContain(en.agentAccess.idleFewerMessage.other.replace("{count}", "30"))
    await click(button(en.agentAccess.idleFewerConfirm, question() as HTMLElement))
    expect(writes()).toEqual([{ method: "PATCH", path: "/agents/settings", body: { idleDays: 30 } }])
  })
})

describe("a save of the agent fields while other things happen", () => {
  it("keeps a value typed while the save was on its way, unsaved and guarded", async () => {
    let release = () => {}
    agentPatchGate = new Promise<void>((resolve) => {
      release = resolve
    })
    await render()
    await type(daysField(), "120")
    await click(button(en.savebar.save))
    expect(writes()).toEqual([{ method: "PATCH", path: "/agents/settings", body: { idleDays: 120 } }])
    await type(daysField(), "30")
    await act(async () => release())
    await settle()
    expect(daysField()?.value).toBe("30")
    expect(unsaved()).not.toBeNull()
  })

  it("saves the agent settings on their own when the general settings could not be read", async () => {
    settingsStatus = 500
    await render()
    expect(switchBox()?.checked).toBe(true)
    await click(switchBox())
    await click(button(en.savebar.save))
    await click(button(en.agentAccess.offConfirm, question() as HTMLElement))
    expect(writes()).toEqual([{ method: "PATCH", path: "/agents/settings", body: { enabled: false } }])
    expect(unsaved()).toBeNull()
    expect(page()).toContain(en.agentAccess.turnedOff)
  })
})

describe("what a save of the agent fields sends", () => {
  it("only what differs from the stored settings", () => {
    const saved = {
      enabled: true,
      idleDays: 90,
      issuer: ISSUER,
      issuerProblem: null,
      mcpUrl: null,
      restUrl: null,
    } as const
    expect(agentChanges(saved, {})).toEqual({})
    expect(agentChanges(saved, { agentsEnabled: true, agentIdleDays: " 90 " })).toEqual({})
    expect(agentChanges(saved, { agentsEnabled: false, agentIdleDays: "7" })).toEqual({ enabled: false, idleDays: 7 })
    expect(agentChanges(undefined, { agentsEnabled: false })).toEqual({})
  })
})

describe("idle days typed", () => {
  it("accepts whole numbers from 1 to 365 only", () => {
    expect(idleDaysOf("1")).toBe(1)
    expect(idleDaysOf(" 365 ")).toBe(365)
    for (const typed of ["0", "366", "1.5", "", "abc", "-3", "1e2"]) expect(idleDaysOf(typed), typed).toBeNull()
  })
})
