// @vitest-environment happy-dom
// Every layer renders under React's StrictMode, which `main.tsx` turns on for development: the
// effects run, are cleaned up and run again, and the layer must keep its content in the page.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, type ReactNode, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it } from "vitest"
import { I18nProvider } from "../i18n/i18n.tsx"
import { Bell } from "../shell/Bell.tsx"
import { MoreSheet } from "../shell/MoreSheet.tsx"
import { Dialog } from "./Dialog.tsx"
import { layerCount } from "./layers.ts"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let mounted: { root: Root; host: HTMLElement } | null = null

async function render(ui: ReactNode): Promise<void> {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted = { root, host }
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <I18nProvider>{ui}</I18nProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    )
  })
}

async function unmount(): Promise<void> {
  if (!mounted) return
  const { root, host } = mounted
  mounted = null
  await act(async () => root.unmount())
  host.remove()
}

afterEach(unmount)

/** The one layer in the page: a direct child of <body>, not inert, holding the panel. */
function openLayerRoot(panel: Element | null): HTMLElement {
  expect(panel?.isConnected).toBe(true)
  const roots = Array.from(document.body.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.dataset.layer !== undefined,
  )
  expect(roots).toHaveLength(1)
  const root = roots[0] as HTMLElement
  expect(root.contains(panel)).toBe(true)
  expect(root.inert).toBeFalsy()
  expect(layerCount()).toBe(1)
  return root
}

async function expectGoneAfterUnmount(): Promise<void> {
  await unmount()
  expect(document.body.querySelector("[data-layer]")).toBeNull()
  expect(layerCount()).toBe(0)
  expect(document.documentElement.classList.contains("ui-layer-on")).toBe(false)
}

describe("layers under StrictMode", () => {
  it("a dialog keeps its title, body and foot in the page", async () => {
    await render(
      <Dialog title="Rename the garden project" size="sm" onClose={() => {}} foot={<button type="button">Save</button>}>
        <p>The new name shows on the morning view.</p>
      </Dialog>,
    )
    const panel = document.body.querySelector('[role="dialog"]')
    openLayerRoot(panel)
    expect(panel?.textContent).toContain("Rename the garden project")
    expect(panel?.textContent).toContain("The new name shows on the morning view.")
    expect(panel?.textContent).toContain("Save")
    await expectGoneAfterUnmount()
  })

  it("the bell window keeps its list in the page", async () => {
    await render(<Bell morning={undefined} failed={false} place="top" />)
    const button = document.body.querySelector<HTMLButtonElement>("button.ui-bell")
    await act(async () => button?.click())
    const panel = document.body.querySelector(".ui-attn-win")
    openLayerRoot(panel)
    expect(panel?.querySelector(".ui-attn-list")?.textContent).not.toBe("")
    await expectGoneAfterUnmount()
  })

  it("the More sheet keeps every page link in the page", async () => {
    await render(<MoreSheet inbox={3} onClose={() => {}} />)
    const panel = document.body.querySelector(".ui-moresheet-panel")
    openLayerRoot(panel)
    expect(panel?.querySelectorAll("a").length).toBeGreaterThan(0)
    await expectGoneAfterUnmount()
  })
})
