// @vitest-environment happy-dom
// The approval page of the authorization server (/connect/approve/<uid>): who asks and how far its name can be trusted,
// how it connected, the resource, the address it returns to, the areas as checkboxes with the warning while writing is
// chosen, the lifetime in words; Approve and Deny with the areas chosen; the server's next address followed only on
// this origin; and every answer of the API: signed out, gone, not configured, refused, invalid, no answer.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import en from "../../../shared/locales/en.json"
import { qk } from "../../api/endpoints.ts"
import type { ConsentDetails } from "../../api/types.ts"
import { I18nProvider } from "../../i18n/i18n.tsx"
import { away, ConsentPage, forgetSentAnswers } from "./ConsentPage.tsx"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Answer = { status: number; body?: unknown; type?: string }
let details: Answer
let decision: Answer
let calls: { path: string; method: string; body: unknown }[]
let gone: string[]
let mounted: { root: Root; host: HTMLElement } | null = null
let router: ReturnType<typeof createMemoryRouter>

const browserDetails = (): ConsentDetails => ({
  client: { name: "Claude Code", builtIn: false, nameIsOwnWord: true },
  via: "browser",
  resource: "mcp",
  redirect: { host: "127.0.0.1:33418", loopback: true, scheme: "http" },
  areas: ["read", "write"],
  idleDays: 90,
})

function respond(answer: Answer): Response {
  const type = answer.type ?? "application/json"
  // A JSON `null` body stays `null`, so the decision test can send it; only a missing body becomes `{}`.
  const text = type.includes("json")
    ? JSON.stringify(answer.body === undefined ? {} : answer.body)
    : String(answer.body ?? "")
  return new Response(text, { status: answer.status, headers: { "content-type": type } })
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  forgetSentAnswers()
  localStorage.setItem("adiutor.language", "en")
  details = { status: 200, body: browserDetails() }
  decision = { status: 200, body: { outcome: "approved", redirectTo: `${window.location.origin}/oauth/authorize/u1` } }
  calls = []
  gone = []
  away.go = (address) => {
    gone.push(address)
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input)
      calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path.endsWith("/details")) return respond(details)
      if (path.endsWith("/decision")) return respond(decision)
      return respond({ status: 404, body: { error: "not_found" } })
    }),
  )
})

afterEach(async () => {
  if (mounted) {
    const { root, host } = mounted
    mounted = null
    await act(async () => root.unmount())
    host.remove()
  }
  vi.unstubAllGlobals()
})

async function settle(ms = 30): Promise<void> {
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
  queryClient.setQueryData(qk.session, { actor: { kind: "owner", label: "owner.name" } })
  router = createMemoryRouter(
    [
      { path: "/connect/approve/:uid", element: <ConsentPage /> },
      { path: "/login", element: <p data-testid="login">sign in</p> },
      { path: "/setup", element: <p data-testid="setup">setup</p> },
      { path: "/settings/agents", element: <p data-testid="settings">settings</p> },
      { path: "/", element: <p>board</p> },
    ],
    { initialEntries: ["/connect/approve/u1"] },
  )
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
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
const button = (name: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => plain(b.textContent) === name)
const box = (area: string) => document.querySelector<HTMLInputElement>(`input[name="area"][value="${area}"]`)
async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await settle()
}
const decisions = () => calls.filter((call) => call.path.endsWith("/decision"))

describe("what the page shows", () => {
  it("shows an MCP client's name as its own word, how it connected, where it returns, and the lifetime", async () => {
    await render()
    expect(calls[0]?.path).toBe("/connect/approve/u1/details")
    expect(plain(document.querySelector("[data-testid=consent-name]")?.textContent)).toBe("Claude Code")
    expect(document.querySelector("[data-testid=consent-name] bdi")?.getAttribute("dir")).toBe("auto")
    expect(page()).toContain(en.consent.nameTag)
    expect(page()).toContain(en.consent.otherText)
    expect(page()).toContain(en.consent.viaBrowser)
    expect(page()).toContain(en.consent.resourceMcp)
    expect(plain(document.querySelector("[data-testid=consent-host]")?.textContent)).toBe("127.0.0.1:33418")
    expect(page()).toContain(en.consent.loopback)
    expect(page()).toContain(en.consent.lifetime.other.replace("{count}", "90"))
    expect(box("read")?.checked).toBe(true)
    expect(box("write")?.checked).toBe(true)
    expect(box("sync")).toBeNull()
    // Nothing takes the focus: Approve is pressed on purpose.
    expect(document.activeElement).toBe(document.body)
  })

  it("marks the built-in client as Adiutor's skill or sync, connected with a code, and another site's return address", async () => {
    details = {
      status: 200,
      body: {
        ...browserDetails(),
        client: { name: "Laptop sync", builtIn: true, nameIsOwnWord: true },
        via: "code",
        resource: "rest",
        redirect: null,
        areas: ["read", "write", "sync"],
        idleDays: 1,
      },
    }
    await render()
    expect(page()).toContain(en.consent.builtInTag)
    expect(page()).toContain(en.consent.viaCode)
    expect(page()).toContain(en.consent.resourceRest)
    expect(page()).not.toContain(en.consent.returnsTo)
    expect(box("sync")?.checked).toBe(true)
    expect(page()).toContain(en.consent.lifetime.one)
  })

  it("names another site as such", async () => {
    details = {
      status: 200,
      body: { ...browserDetails(), redirect: { host: "agent.example.com", loopback: false, scheme: "https" } },
    }
    await render()
    expect(page()).toContain(en.consent.remote)
  })

  it("names an app's own scheme, which has no host, as an app on a device", async () => {
    details = {
      status: 200,
      body: { ...browserDetails(), redirect: { host: "", loopback: false, scheme: "com.example.agent" } },
    }
    await render()
    expect(plain(document.querySelector("[data-testid=consent-host]")?.textContent)).toBe("com.example.agent:")
    expect(page()).toContain(en.consent.app)
    expect(page()).not.toContain(en.consent.remote)
  })

  it("marks the built-in client as asking like Adiutor's skill or sync, with a warning, not as proof", async () => {
    details = {
      status: 200,
      body: { ...browserDetails(), client: { name: "Laptop sync", builtIn: true, nameIsOwnWord: true } },
    }
    await render()
    const tag = document.querySelector(".ui-consent-id .ui-tag")
    expect(plain(tag?.textContent)).toBe(en.consent.builtInTag)
    expect(tag?.classList.contains("ui-tag-warn")).toBe(true)
    expect(en.consent.builtInText).toContain("cannot check")
  })

  it("warns while writing is chosen, and not for reading alone", async () => {
    await render()
    expect(page()).toContain(en.consent.warnTitle)
    await click(box("write"))
    expect(box("write")?.checked).toBe(false)
    expect(page()).not.toContain(en.consent.warnTitle)
  })
})

describe("the answer", () => {
  it("approves with the areas still ticked and follows the server's address", async () => {
    await render()
    await click(box("write"))
    await click(button(en.consent.approve))
    expect(decisions()).toEqual([
      { path: "/connect/approve/u1/decision", method: "POST", body: { approve: true, areas: ["read"] } },
    ])
    expect(gone).toEqual([`${window.location.origin}/oauth/authorize/u1`])
    expect(page()).toContain(en.consent.returning)
  })

  it("denies with no areas", async () => {
    decision = { status: 200, body: { outcome: "denied", redirectTo: `${window.location.origin}/connect/code/u1` } }
    await render()
    await click(button(en.consent.deny))
    expect(decisions()[0]?.body).toEqual({ approve: false, areas: [] })
    expect(gone).toHaveLength(1)
  })

  it("asks for an area before it sends an approval with none", async () => {
    await render()
    await click(box("read"))
    await click(box("write"))
    await click(button(en.consent.approve))
    expect(decisions()).toHaveLength(0)
    expect(page()).toContain(en.consent.noArea)
  })

  it("says what happened when the answer names no next address", async () => {
    decision = { status: 200, body: { outcome: "approved" } }
    await render()
    await click(button(en.consent.approve))
    expect(gone).toEqual([])
    expect(page()).toContain(en.consent.approved)
    expect(page()).toContain(en.consent.closeWindow)
  })

  for (const [name, body] of [
    ["null", null],
    ["{}", {}],
    ["an unknown outcome", { outcome: "maybe" }],
    ["another site's address", { outcome: "approved", redirectTo: "https://elsewhere.example.com/x" }],
    ["an address that is not text", { outcome: "approved", redirectTo: 7 }],
  ] as const)
    it(`counts an answer that breaks the contract (${name}) as lost, keeping the record`, async () => {
      decision = { status: 200, body }
      await render()
      await click(button(en.consent.approve))
      expect(gone).toEqual([])
      expect(page()).toContain(en.consent.unknownTitle)
      expect(button(en.consent.approve)).toBeUndefined()
      expect(sessionStorage.getItem("adiutor.consent.sent.u1")).toBe("unknown")
    })

  it("keeps the form after a refused or failed answer, and ends on a request that is gone", async () => {
    decision = { status: 400, body: { error: "validation_failed", message: "x" } }
    await render()
    await click(button(en.consent.approve))
    expect(page()).toContain(en.consent.failed.validation)
    expect(button(en.consent.approve)?.disabled).toBe(false)
    decision = { status: 410, body: { error: "gone", message: "x" } }
    await click(button(en.consent.approve))
    expect(page()).toContain(en.consent.unavailable)
    expect(page()).toContain(en.consent.reason.gone)
  })

  it("never offers a second answer after a lost one: not after Settings and Back, not after a reload", async () => {
    await render()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        calls.push({ path: String(input), method: "?", body: null })
        return Promise.reject(new TypeError("connection reset"))
      }),
    )
    await click(button(en.consent.approve))
    expect(page()).toContain(en.consent.unknownTitle)
    await click(document.querySelector('a[href="/settings/agents"]'))
    expect(document.querySelector("[data-testid=settings]")).not.toBeNull()
    await act(async () => {
      await router.navigate(-1)
    })
    await settle()
    expect(page()).toContain(en.consent.unknownTitle)
    expect(button(en.consent.approve)).toBeUndefined()
    // A reload: a new app with the same tab's storage reads nothing and offers nothing.
    await act(async () => mounted?.root.unmount())
    mounted?.host.remove()
    mounted = null
    calls = []
    forgetSentAnswers()
    await render()
    expect(page()).toContain(en.consent.unknownTitle)
    expect(button(en.consent.approve)).toBeUndefined()
    expect(calls).toEqual([])
  })

  it("keeps a lost answer for the app's whole life when storage is blocked, past the query cache's clean-up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const blocked = () => {
      throw new Error("blocked")
    }
    vi.stubGlobal("sessionStorage", { getItem: blocked, setItem: blocked, removeItem: blocked, clear: blocked })
    try {
      decision = { status: 200, body: null, type: "text/plain" }
      await render()
      await click(button(en.consent.approve))
      expect(page()).toContain(en.consent.unknownTitle)
      await click(document.querySelector('a[href="/settings/agents"]'))
      // Well past the query cache's 5 minutes for data no page shows.
      await act(async () => {
        vi.advanceTimersByTime(6 * 60_000)
      })
      await act(async () => {
        await router.navigate(-1)
      })
      await settle()
      expect(page()).toContain(en.consent.unknownTitle)
      expect(button(en.consent.approve)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("shows what became of an answer that came back, after Back, instead of the form", async () => {
    decision = { status: 200, body: { outcome: "denied" } }
    await render()
    await click(button(en.consent.deny))
    expect(page()).toContain(en.consent.denied)
    await act(async () => mounted?.root.unmount())
    mounted?.host.remove()
    mounted = null
    await render()
    expect(page()).toContain(en.consent.denied)
    expect(button(en.consent.deny)).toBeUndefined()
  })

  it("lets the owner answer again after a refusal that proves nothing was decided", async () => {
    decision = { status: 415, body: { error: "unsupported_media_type", message: "x" } }
    await render()
    await click(button(en.consent.approve))
    expect(page()).toContain(en.consent.failed.other)
    expect(button(en.consent.approve)?.disabled).toBe(false)
    expect(sessionStorage.getItem("adiutor.consent.sent.u1")).toBeNull()
  })

  for (const [name, lost] of [
    ["no answer", null],
    ["a server error", { status: 502, body: "<html>Bad gateway</html>", type: "text/html" }],
    ["an answer that is not JSON", { status: 200, body: "", type: "text/plain" }],
    ["the server's own error", { status: 500, body: { error: { code: "internal_error" } } }],
  ] as const)
    it(`says the outcome is unknown, without a retry, after ${name}`, async () => {
      await render()
      if (lost === null)
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => Promise.reject(new TypeError("connection reset"))),
        )
      else decision = lost as Answer
      await click(button(en.consent.approve))
      expect(page()).toContain(en.consent.unknownTitle)
      expect(page()).toContain(en.consent.unknownText)
      expect(button(en.consent.approve)).toBeUndefined()
      expect(document.querySelector('a[href="/settings/agents"]')).not.toBeNull()
    })
})

describe("a request the page cannot show", () => {
  it("sends a signed-out browser to sign in and back here", async () => {
    details = { status: 401, body: { error: "unauthorized", message: "Sign in" } }
    await render()
    expect(document.querySelector("[data-testid=login]")).not.toBeNull()
  })

  it("sends an account without two-factor to set it up", async () => {
    details = { status: 403, body: { error: "totp_required", message: "x" } }
    await render()
    expect(document.querySelector("[data-testid=setup]")).not.toBeNull()
  })

  for (const [name, answer, reason] of [
    ["gone", { status: 410, body: { error: "gone" } }, en.consent.reason.gone],
    ["not configured", { status: 404, body: { error: "not_configured" } }, en.consent.reason.not_configured],
    [
      "an Adiutor without agent access (the app's own 404)",
      { status: 404, body: { error: { code: "not_found", message: "Nothing is here." } } },
      en.consent.reason.not_configured,
    ],
    // Not the API's answer: the page no longer reads an HTML page as "agents cannot connect".
    [
      "an answer that is not the API's",
      { status: 200, body: "<!doctype html>", type: "text/html" },
      en.consent.reason.other,
    ],
    ["refused", { status: 403, body: { error: "forbidden" } }, en.consent.reason.forbidden],
    ["broken", { status: 500, body: { error: { code: "internal_error" } } }, en.consent.reason.other],
  ] as const)
    it(`says why for ${name}`, async () => {
      details = answer as Answer
      await render()
      expect(page()).toContain(en.consent.unavailable)
      expect(page()).toContain(reason)
      expect(button(en.consent.approve)).toBeUndefined()
    })

  it("says when Adiutor cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    )
    await render()
    expect(page()).toContain(en.consent.reason.network)
  })
})
