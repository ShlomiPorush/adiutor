// One owner for every layer over the page (v3 DS-8, DS-10, DS-11). Escape and the browser Back
// button close only the top layer, through its own close function, and stay on the page. While a
// layer is open the page holds one extra history entry at the same URL; closing by hand takes it
// back, so the next Back really leaves. Everything except the top layer and the toast is inert, the
// focus moves into the layer and returns to the control that opened it.

export type LayerOptions = {
  /**
   * The layer's root element: its builder portals it straight into <body>, outside any stacking
   * context (DS-15), and React owns it, so StrictMode's second effect run finds it still there.
   */
  root: HTMLElement
  /** Closes the layer the way its X or Cancel does (it may ask first). */
  close: () => void
  /** The layer has its own history entry already (an item opened by URL) or must not add one. */
  noHistory?: boolean
  /** Where the focus goes on open; default: first field, else primary button, else the panel. */
  initialFocus?: () => HTMLElement | null
  /** Makes only these inert instead of everything else (the phone More sheet keeps the tab bar usable). */
  inertOnly?: () => HTMLElement[]
}

type Layer = LayerOptions & { id: number; opener: Element | null }

const stack: Layer[] = []
let nextId = 1
let holdsEntry = false
let ignorePops = 0

const touchOnly = () => typeof matchMedia === "function" && matchMedia("(hover: none) and (pointer: coarse)").matches

let inertNow = new Set<HTMLElement>()

function syncInert(): void {
  const top = stack.at(-1)
  const want = new Set<HTMLElement>()
  if (top?.inertOnly) {
    for (const element of top.inertOnly()) want.add(element)
  } else if (top) {
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof HTMLElement) || child.tagName === "SCRIPT") continue
      if (child !== top.root && child.dataset.layerKeep !== "true") want.add(child)
    }
  }
  for (const element of inertNow) if (!want.has(element)) element.inert = false
  for (const element of want) element.inert = true
  inertNow = want
  // The page behind a layer stays still (DS-11).
  document.documentElement.classList.toggle("ui-layer-on", stack.length > 0)
}

function focusInto(layer: Layer): void {
  const wanted = layer.initialFocus?.()
  if (wanted) {
    wanted.focus({ preventScroll: true })
    return
  }
  const panel = layer.root.querySelector<HTMLElement>("[data-layer-panel]") ?? layer.root
  const field = touchOnly()
    ? null
    : panel.querySelector<HTMLElement>(
        "input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])",
      )
  const primary = panel.querySelector<HTMLElement>(
    "[data-autofocus], .ui-btn-primary:not([disabled]), .ui-btn-danger-solid:not([disabled])",
  )
  const target = field ?? primary ?? panel
  if (target === panel && !panel.hasAttribute("tabindex")) panel.tabIndex = -1
  target.focus({ preventScroll: true })
}

function pushEntry(): void {
  if (holdsEntry) return
  history.pushState({ ...(history.state ?? {}), mikudLayer: true }, "")
  holdsEntry = true
}

function needsEntry(): boolean {
  return stack.some((layer) => !layer.noHistory)
}

/** Registers an open layer; returns its removal. */
export function openLayer(options: LayerOptions): () => void {
  const layer: Layer = { ...options, id: nextId++, opener: document.activeElement }
  stack.push(layer)
  syncInert()
  if (!layer.noHistory) pushEntry()
  requestAnimationFrame(() => {
    if (stack.includes(layer)) focusInto(layer)
  })
  return () => {
    const index = stack.indexOf(layer)
    if (index === -1) return
    stack.splice(index, 1)
    syncInert()
    // Closed by hand: take back the extra entry, so the next Back leaves the page. When a
    // navigation already left that entry (a link inside the layer), there is nothing to take back.
    if (holdsEntry && !needsEntry()) {
      holdsEntry = false
      if ((history.state as { mikudLayer?: boolean } | null)?.mikudLayer) {
        ignorePops++
        history.back()
      }
    }
    const opener = layer.opener
    const below = stack.at(-1)
    requestAnimationFrame(() => {
      if (opener instanceof HTMLElement && opener.isConnected && !opener.closest("[inert]"))
        opener.focus({ preventScroll: true })
      else if (below) focusInto(below)
    })
  }
}

export function topLayerIs(root: HTMLElement | null): boolean {
  return !!root && stack.at(-1)?.root === root
}

export function layerCount(): number {
  return stack.length
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !stack.length) return
      const top = stack.at(-1)
      // A native select or an open picker inside the top layer closes itself first.
      if (event.target instanceof HTMLSelectElement) return
      event.preventDefault()
      event.stopPropagation()
      top?.close()
    },
    true,
  )
  window.addEventListener("popstate", () => {
    if (ignorePops > 0) {
      ignorePops--
      return
    }
    if (!holdsEntry) return
    holdsEntry = false
    const top = [...stack].reverse().find((layer) => !layer.noHistory)
    top?.close()
    // A layer that asked first and stayed open, or one below it, still needs its entry.
    requestAnimationFrame(() => {
      if (needsEntry()) pushEntry()
    })
  })
}
