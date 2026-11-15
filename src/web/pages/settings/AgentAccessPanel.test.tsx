// @vitest-environment happy-dom
// Settings, Agent access: today's panel of agent keys where agent access by approval is not mounted (the settings read
// answers 404), the error state for any other failure, and the new panel where it is: the switch and the idle days
// (turning off and fewer days ask first), how to connect or why agents cannot, the connections with Disconnect, and
// Disconnect all, there even with no connection.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import en from "../../../shared/locales/en.json"
import { setTransport, type TransportRequest, type TransportResponse } from "../../api/client.ts"
import type { AgentConnection, AgentSettings } from "../../api/types.ts"
import { I18nProvider } from "../../i18n/i18n.tsx"
import { ConfirmHost } from "../../ui/confirm.tsx"
import { ToastHost } from "../../ui/Toast.tsx"
import { AgentsSection, claudeCommand, idleDaysOf } from "./AgentAccessPanel.tsx"
import { skillSentence } from "./AgentKeysPanel.tsx"

vi.mock("../../api/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/auth.ts")>()
  return { ...real, authClient: { apiKey: { list: () => Promise.resolve({ data: { apiKeys: [] }, error: null }) } } }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ISSUER = "https://adiutor.example.com"
let settings: AgentSettings | null
let settingsStatus: number
let connections: AgentConnection[]
let requests: TransportRequest[]
let mounted: { root: Root; host: HTMLElement } | null = null

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

async function transport(request: TransportRequest): Promise<TransportResponse> {
  requests.push(request)
  const { method, path, body } = request
  if (path === "/agents/settings" && method === "GET") {
    if (settingsStatus === 404)
      return { status: 404, body: { error: { code: "not_found", message: "Nothing is here." } } }
    if (settingsStatus !== 200)
      return { status: settingsStatus, body: { error: { code: "internal_error", message: "Down." } } }
    return { status: 200, body: settings }
  }
  if (path === "/agents/settings" && method === "PATCH") {
    settings = { ...(settings as AgentSettings), ...(body as object) }
    return { status: 200, body: { enabled: settings.enabled, idleDays: settings.idleDays } }
  }
  if (path === "/agents/connections" && method === "GET") return { status: 200, body: { connections } }
  if (path.startsWith("/agents/connections/") && method === "DELETE") {
    connections = connections.filter((c) => !path.endsWith(c.id))
    return { status: 204, body: null }
  }
  if (path === "/agents/connections/disconnect-all" && method === "POST") {
    const ended = connections.length
    connections = []
    return { status: 200, body: { ended } }
  }
  return { status: 404, body: { error: { code: "not_found", message: "Not here." } } }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem("adiutor.language", "en")
  settings = {
    enabled: true,
    idleDays: 90,
    issuer: ISSUER,
    issuerProblem: null,
    mcpUrl: `${ISSUER}/mcp`,
    restUrl: `${ISSUER}/api/v1`,
  }
  settingsStatus = 200
  connections = []
  requests = []
  setTransport(transport)
})

afterEach(async () => {
  if (mounted) {
    const { root, host } = mounted
    mounted = null
    await act(async () => root.unmount())
    host.remove()
  }
})

async function settle(ms = 40): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function render(): Promise<void> {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted = { root, host }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter>
            <AgentsSection />
            <ConfirmHost />
            <ToastHost />
          </MemoryRouter>
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
const switchBox = () => document.querySelector<HTMLInputElement>('input[role="switch"]')
const daysField = () => document.querySelector<HTMLInputElement>('#settings-agents input[type="number"]')
const writes = () => requests.filter((r) => r.method !== "GET")

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

describe("which panel shows", () => {
  it("shows today's panel of agent keys where agent access is not mounted (404)", async () => {
    settingsStatus = 404
    await render()
    expect(page()).toContain(en.agentKeys.howTitle)
    expect(page()).toContain(en.settings.sections.agents.hint)
    expect(page()).not.toContain(en.agentAccess.switch)
    expect(requests.map((r) => r.path)).toEqual(["/agents/settings"])
  })

  it("shows the failure with Try again for any other answer, never the old panel", async () => {
    settingsStatus = 500
    await render()
    expect(page()).toContain(en.agentAccess.failed)
    expect(button(en.common.tryAgain)).toBeTruthy()
    expect(page()).not.toContain(en.agentKeys.howTitle)
  })
})

describe("the new panel", () => {
  it("shows the switch, the idle days, how to connect, and Disconnect all with no connection", async () => {
    await render()
    expect(page()).toContain(en.agentAccess.hint)
    expect(switchBox()?.checked).toBe(true)
    expect(daysField()?.value).toBe("90")
    expect(page()).toContain(`${ISSUER}/mcp`)
    expect(page()).toContain(claudeCommand(`${ISSUER}/mcp`))
    expect(claudeCommand(`${ISSUER}/mcp`)).toBe(`claude mcp add --transport http adiutor ${ISSUER}/mcp`)
    expect(page()).toContain(skillSentence(ISSUER))
    expect(page()).toContain(en.agentAccess.empty)
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

  it("turns agents off only after a question, and on at once", async () => {
    await render()
    await click(switchBox())
    expect(plain(question()?.textContent)).toContain(en.agentAccess.offMessage)
    await click(button(en.common.cancel, question() as HTMLElement))
    expect(writes()).toEqual([])
    await click(switchBox())
    await click(button(en.agentAccess.offConfirm, question() as HTMLElement))
    expect(writes()).toEqual([{ method: "PATCH", path: "/agents/settings", body: { enabled: false } }])
    expect(switchBox()?.checked).toBe(false)
    expect(page()).toContain(en.agentAccess.offNote)
    await click(switchBox())
    expect(question()).toBeNull()
    expect(writes()[1]).toEqual({ method: "PATCH", path: "/agents/settings", body: { enabled: true } })
  })

  it("saves more idle days at once, asks before fewer, and refuses a number outside 1 to 365", async () => {
    await render()
    const save = () => button(en.agentAccess.idleSave)
    expect(save()?.disabled).toBe(true)
    await type(daysField(), "400")
    expect(page()).toContain(en.agentAccess.idleInvalid)
    expect(save()?.disabled).toBe(true)
    await type(daysField(), "120")
    await click(save())
    expect(writes()).toEqual([{ method: "PATCH", path: "/agents/settings", body: { idleDays: 120 } }])
    await settle()
    expect(daysField()?.value).toBe("120")
    await type(daysField(), "30")
    await click(save())
    expect(plain(question()?.textContent)).toContain(en.agentAccess.idleFewerMessage.other.replace("{count}", "30"))
    await click(button(en.agentAccess.idleFewerConfirm, question() as HTMLElement))
    expect(writes()[1]).toEqual({ method: "PATCH", path: "/agents/settings", body: { idleDays: 30 } })
  })

  it("replaces how to connect with the reason when the public URL does not allow agents", async () => {
    settings = {
      ...(settings as AgentSettings),
      issuer: null,
      issuerProblem: "plain_http",
      mcpUrl: null,
      restUrl: null,
    }
    await render()
    expect(page()).toContain(en.agentAccess.issuerTitle)
    expect(page()).toContain(en.agentAccess.issuer.plain_http)
    expect(page()).not.toContain("claude mcp add")
  })
})

describe("idle days typed", () => {
  it("accepts whole numbers from 1 to 365 only", () => {
    expect(idleDaysOf("1")).toBe(1)
    expect(idleDaysOf(" 365 ")).toBe(365)
    for (const typed of ["0", "366", "1.5", "", "abc", "-3", "1e2"]) expect(idleDaysOf(typed), typed).toBeNull()
  })
})
