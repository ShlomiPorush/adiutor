// The one filter bar of a list (v3 MP-6, TB-17, TB-7, SR-9, SR-10; n8n-ops' FilterBar, SearchBox, searchDraft
// and firstRowReset in apps/web/src/components/filter-bar.tsx at 3d43b89, rebuilt on Adiutor's ui- classes and its
// own picker). The bar holds the search, the Filters button and the common pickers; the rarely used filters open
// under it behind the Filters button, whose badge counts those in use. Under the bar one line holds the count
// from the server (TB-18) and, while any filter differs from its start value, "Clear filters". A change of the
// list's filters brings the list back to its first row; a refresh of the same list keeps the place. The bar is
// part of the page, not a layer: its pickers are ui/Picker.tsx.

import { Funnel, Search } from "lucide-react"
import { createContext, type ReactNode, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { useI18n } from "../i18n/i18n.tsx"

/** A search on the server waits for this pause in typing (SR-10). */
export const SEARCH_PAUSE_MS = 300
/** How long a list waits for the rows of new filters before it gives up its second reset to the first row. */
const LIST_WAIT_MS = 10_000

/**
 * What a search that waits for a pause holds between keys, free of React for the tests: `show` draws the text in
 * the box, `send` asks for it once typing has paused.
 */
export function searchDraft(initial: string, show: (text: string) => void, send: (text: string) => void) {
  let sent = initial
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const reset = (value: string) => {
    cancel()
    sent = value
    show(value)
  }
  return {
    /** A key typed: the text shows at once and is asked for once typing pauses. */
    type(text: string) {
      show(text)
      cancel()
      if (text === sent) return
      timer = setTimeout(() => {
        timer = undefined
        sent = text
        send(text)
      }, SEARCH_PAUSE_MS)
    },
    /** The value the list holds now: unless it is the one this box sent, it was set from outside and wins. */
    sync(value: string) {
      if (value !== sent) reset(value)
    },
    /** Clear filters: the value replaces what is typed and a search still on its way is dropped. */
    reset,
    cancel,
  }
}

/** Counts the clicks on "Clear filters", so the search drops what was typed and not sent yet. */
const ClearsContext = createContext(0)

/**
 * A list searched on the server: what is typed shows at once and `onChange` follows once typing pauses, so a word
 * is one request and one address change (SR-10). A value set from outside (Back, Forward, a link) and "Clear
 * filters" replace what the box shows and drop a search still on its way. `resetKey` names the address: any move
 * the box did not make itself (Back to the same search, another filter) also drops what is typed and not sent.
 */
export function SearchBox({
  value,
  onChange,
  label,
  placeholder,
  resetKey,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  placeholder?: string
  resetKey?: string
}) {
  const [text, setText] = useState(value)
  // The latest handler: the one of the render that started the pause may write over filters changed since.
  const send = useRef(onChange)
  send.current = onChange
  // The address move the box makes itself when it sends; the next new address is that one.
  const sending = useRef(false)
  const [draft] = useState(() =>
    searchDraft(value, setText, (typed) => {
      sending.current = true
      send.current(typed)
    }),
  )
  useEffect(() => draft.cancel, [draft])
  useEffect(() => draft.sync(value), [draft, value])
  const clears = useContext(ClearsContext)
  const seenClears = useRef(clears)
  const latest = useRef(value)
  latest.current = value
  useEffect(() => {
    if (clears === seenClears.current) return
    seenClears.current = clears
    draft.reset(latest.current)
  }, [draft, clears])
  const seenKey = useRef(resetKey)
  useEffect(() => {
    if (resetKey === seenKey.current) return
    seenKey.current = resetKey
    if (sending.current) {
      sending.current = false
      return
    }
    draft.reset(latest.current)
  }, [draft, resetKey])
  return (
    <label className="ui-search">
      <Search className="ui-search-icon" aria-hidden="true" />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={text}
        dir="auto"
        onChange={(event) => draft.type(event.target.value)}
      />
    </label>
  )
}

/**
 * Whether a list goes to its first row once more when the rows of new filters come (TB-7), free of React for the
 * tests. It waits for the request of those filters to end; it gives up once the user scrolls, or when no answer
 * came within `LIST_WAIT_MS`, so a later refresh never moves the list under the user.
 */
export function firstRowReset(now: () => number = () => performance.now()) {
  let until: number | null = null
  // Moves on with new filters and with every scroll of the user, so a frame planned before either does nothing.
  let turn = 0
  return {
    changed(loading: boolean) {
      turn += 1
      until = loading ? now() + LIST_WAIT_MS : null
    },
    scrolled() {
      turn += 1
      until = null
    },
    ticket(): () => boolean {
      const planned = turn
      return () => planned === turn
    },
    loaded(loading: boolean): boolean {
      if (until === null || loading) return false
      const due = now() <= until
      until = null
      return due
    },
  }
}

/** Keys that scroll the page when pressed outside a control that uses them itself. */
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "])
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.closest("input, textarea, select, button, a[href], [role=option]") !== null)

/** The element the list scrolls in: the page (`.ui-page` scrolls inside the shell). */
const scrollerFor = (element: HTMLElement) => element.closest<HTMLElement>(".ui-page")

/**
 * Brings the list back to its first row when `key` (its filters and search) changes: at once, in the next frame,
 * and, while its rows are `loading`, again in the frame after their request ends, as the old content's height can
 * carry the scroll down meanwhile. It scrolls only when the bar's place is above view, and only that far (TB-7).
 */
function useFirstRowOnChange(bar: { current: HTMLElement | null }, key: string, loading: boolean) {
  const [reset] = useState(() => firstRowReset())
  const lastKey = useRef(key)
  const toTop = () => {
    const element = bar.current
    const scroller = element && scrollerFor(element)
    if (!element || !scroller) return
    const place = Math.max(
      0,
      scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
    )
    if (scroller.scrollTop > place) scroller.scrollTop = place
  }
  const toTopRef = useRef(toTop)
  toTopRef.current = toTop
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the filters change, not when they load
  useLayoutEffect(() => {
    if (key === lastKey.current) return
    lastKey.current = key
    reset.changed(loading)
    toTopRef.current()
    const valid = reset.ticket()
    const frame = requestAnimationFrame(() => valid() && toTopRef.current())
    return () => cancelAnimationFrame(frame)
  }, [key, reset])
  useEffect(() => {
    if (!reset.loaded(loading)) return
    const valid = reset.ticket()
    const frame = requestAnimationFrame(() => valid() && toTopRef.current())
    return () => cancelAnimationFrame(frame)
  }, [loading, reset])
  // A wheel, a touch, the scroll bar or a scrolling key, not the scroll this hook makes itself.
  useEffect(() => {
    const scroller = () => (bar.current ? scrollerFor(bar.current) : null)
    const inside = (event: Event) => event.target instanceof Node && scroller()?.contains(event.target) === true
    const onScroll = (event: Event) => {
      if (inside(event)) reset.scrolled()
    }
    const onPress = (event: PointerEvent) => {
      if (event.target === scroller()) reset.scrolled()
    }
    const onKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key) && !typing(event.target) && inside(event)) reset.scrolled()
    }
    const passive = { passive: true }
    document.addEventListener("wheel", onScroll, passive)
    document.addEventListener("touchmove", onScroll, passive)
    document.addEventListener("pointerdown", onPress, passive)
    document.addEventListener("keydown", onKey, passive)
    return () => {
      document.removeEventListener("wheel", onScroll)
      document.removeEventListener("touchmove", onScroll)
      document.removeEventListener("pointerdown", onPress)
      document.removeEventListener("keydown", onKey)
    }
  }, [bar, reset])
}

/** The first control a person can use in an element. */
const firstControl = (element: HTMLElement | null) =>
  element?.querySelector<HTMLElement>(
    "button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])",
  )

export function FilterBar({
  search,
  pickers,
  more,
  active = 0,
  count,
  onClear,
  listKey,
  loading = false,
}: {
  search?: ReactNode
  /** The filters most people use, shown at every size. */
  pickers?: ReactNode
  /** The rarely used filters, behind the Filters button at every size (MP-6). */
  more?: ReactNode
  /** How many of the `more` filters are not at their default, for the Filters badge. */
  active?: number
  /** The count line's number, from the server (TB-17, TB-18); nothing while it is unknown. */
  count?: ReactNode
  /** Shown as "Clear filters" while something differs from its start value. */
  onClear?: () => void
  /** The list's filters and search in one value; a new one brings the list to its first row (TB-7). */
  listKey: string
  /** While the rows of new filters are on their way. */
  loading?: boolean
}) {
  const { t, tc } = useI18n()
  const [open, setOpen] = useState(false)
  const [clears, setClears] = useState(0)
  const panelId = useId()
  const bar = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const opened = useRef(false)
  useFirstRowOnChange(bar, listKey, loading)
  // Opening the rare filters moves the focus to the first of them (MP-6).
  useEffect(() => {
    if (!open || !opened.current) return
    opened.current = false
    firstControl(panel.current)?.focus()
  }, [open])
  const filtersLabel = active > 0 ? tc("filters.inUse", active) : t("filters.button")
  return (
    <div ref={bar} className="ui-fbar">
      <div className="ui-fbar-row">
        {search ? (
          <div className="ui-fbar-search">
            <ClearsContext.Provider value={clears}>{search}</ClearsContext.Provider>
          </div>
        ) : null}
        {more ? (
          <button
            type="button"
            className="ui-icon-btn ui-filters-toggle"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={filtersLabel}
            title={filtersLabel}
            onClick={() => {
              opened.current = !open
              setOpen(!open)
            }}
          >
            <Funnel aria-hidden="true" />
            {active > 0 ? (
              <span className="ui-filters-n" aria-hidden="true">
                {active}
              </span>
            ) : null}
          </button>
        ) : null}
        {pickers ? <div className="ui-fbar-pickers">{pickers}</div> : null}
        {more ? (
          <div ref={panel} id={panelId} className="ui-fbar-more" hidden={!open}>
            {more}
          </div>
        ) : null}
      </div>
      {count !== undefined || onClear ? (
        <p className="ui-list-summary">
          {count !== undefined ? <b aria-live="polite">{count}</b> : null}
          {onClear ? (
            <button
              type="button"
              className="ui-link ui-clear-filters"
              onClick={() => {
                // The search drops what is typed but not sent yet, which the address does not hold (SR-10).
                setClears((value) => value + 1)
                onClear()
              }}
            >
              {t("filters.clear")}
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}
