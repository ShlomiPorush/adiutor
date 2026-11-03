// @vitest-environment happy-dom
// A refused field is held in view for REVEAL_FOR_MS (SV-1) without fighting the owner: a scroll it saw no input for
// (a scroll bar dragged off the main thread, assistive technology) ends the hold while the field keeps the focus.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { keepRevealed, REVEAL_FOR_MS } from "../SettingsPage.tsx"

const rect = (top: number, height: number) =>
  ({ top, bottom: top + height, left: 0, right: 400, height, width: 400, x: 0, y: top }) as DOMRect

describe("keepRevealed", () => {
  let page: HTMLDivElement
  let content: HTMLDivElement
  let field: HTMLInputElement
  /** Where the field starts in the page's content, below the visible 500px. */
  let fieldAt = 900
  let writes: ScrollToOptions[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] })
    page = document.createElement("div")
    content = document.createElement("div")
    field = document.createElement("input")
    content.append(field)
    page.append(content)
    document.body.append(page)
    fieldAt = 900
    writes = []
    // The page scrolls as one (content overflow visible): 500px tall, the field 40px tall.
    content.style.overflowY = "visible"
    page.getBoundingClientRect = () => rect(0, 500)
    field.getBoundingClientRect = () => rect(fieldAt - page.scrollTop, 40)
    page.scrollTo = ((options: ScrollToOptions) => {
      writes.push(options)
      page.scrollTop = options.top ?? page.scrollTop
    }) as typeof page.scrollTo
    field.focus()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  const frames = (ms: number) => vi.advanceTimersByTime(ms)

  it("brings the field above the end of the area and keeps it there while a toast arrives", () => {
    keepRevealed(field, page, content, null)
    // Bottom 940 must end at 492 (8px inside): 448.
    expect(page.scrollTop).toBe(448)
    const toast = document.createElement("div")
    toast.className = "ui-toast"
    toast.getBoundingClientRect = () => rect(400, 80)
    document.body.append(toast)
    frames(50)
    // Now clear of the toast: the field ends 8px above its top (392), so 100px more.
    expect(page.scrollTop).toBe(548)
    frames(REVEAL_FOR_MS + 100)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("stops at a scroll it saw no input for, and the field keeps the focus", () => {
    keepRevealed(field, page, content, null)
    expect(page.scrollTop).toBe(448)
    // Assistive technology scrolls back up: no wheel, touch, pointer or key event comes first.
    page.scrollTop = 138
    frames(50)
    expect(page.scrollTop).toBe(138)
    expect(document.activeElement).toBe(field)
    // A layer arriving later does not bring the hold back.
    const toast = document.createElement("div")
    toast.className = "ui-toast"
    toast.getBoundingClientRect = () => rect(400, 80)
    document.body.append(toast)
    frames(REVEAL_FOR_MS)
    expect(page.scrollTop).toBe(138)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("writes once at the start even with the field in view, to end a smooth scroll still running", () => {
    fieldAt = 100
    keepRevealed(field, page, content, null)
    expect(writes).toEqual([{ top: 0, behavior: "instant" }])
    frames(REVEAL_FOR_MS + 100)
    // Nothing moved after that: no other write.
    expect(writes).toHaveLength(1)
  })

  it("stops once the field loses the focus", () => {
    keepRevealed(field, page, content, null)
    field.blur()
    const toast = document.createElement("div")
    toast.className = "ui-toast"
    toast.getBoundingClientRect = () => rect(400, 80)
    document.body.append(toast)
    frames(50)
    expect(page.scrollTop).toBe(448)
    expect(vi.getTimerCount()).toBe(0)
  })
})
