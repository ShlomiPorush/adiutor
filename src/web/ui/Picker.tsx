// The one picker builder (v3 MP-1, MP-4, MP-5, DS-24; n8n-ops' PickerContent and usePicker in
// components/filter-bar.tsx and its FieldPicker, rebuilt on Mikud's layer owner instead of Radix). A button
// opens a panel anchored to it: a listbox of options, with a search field above more than ten of them, or a
// small panel of controls (the Sort menu, ui/SortButton.tsx). The panel is a layer of ui/layers.ts: Escape
// and Back close only the picker, also inside a dialog, the focus moves into it and back to its button, and
// a press beside it closes it. It stays on screen: under its button, or above it when the room below is
// short, between the phone's top bar and tab bar, scrolling within the room it has. guards.test.ts fails on
// a picker, listbox or panel made anywhere else.

import { ChevronDown } from "lucide-react"
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { useI18n } from "../i18n/i18n.tsx"
import { openLayer } from "./layers.ts"

export type PickerOption = {
  value: string
  label: string
  /** A count or a short note at the option's end; it is never cut. */
  hint?: ReactNode
  /** More text the search matches besides the label. */
  search?: string
}

const GAP = 6
const EDGE = 8
const PHONE = "(max-width: 760px)"
/** More choices than this get a search field (MP-4). */
export const SEARCH_FROM = 10

const touchOnly = () => typeof matchMedia === "function" && matchMedia("(hover: none) and (pointer: coarse)").matches

/** Search text compared loosely: case and underscores do not count ("new york" finds New_York) (MP-4). */
const loose = (text: string) => text.replaceAll("_", " ").toLocaleLowerCase()

/** The options a search leaves: by label and extra search text, as a substring. */
export function filterOptions(options: PickerOption[], query: string): PickerOption[] {
  const wanted = loose(query.trim())
  return wanted ? options.filter((option) => loose(`${option.label} ${option.search ?? ""}`).includes(wanted)) : options
}

/** The next option whose label starts with the typed text, after the focused one (type-ahead). */
export function typeAhead(labels: string[], typedText: string, from: number): number {
  // The same letter again and again moves through the options that start with it.
  const typed =
    typedText.length > 1 && [...typedText].every((char) => char === typedText[0]) ? typedText.slice(0, 1) : typedText
  const wanted = loose(typed)
  // One letter moves on to the next match; a longer text stays on the current option while it still matches.
  const start = typed.length > 1 ? Math.max(from, 0) : from + 1
  for (let step = 0; step < labels.length; step++) {
    const index = (start + step) % labels.length
    if (loose(labels[index] ?? "").startsWith(wanted)) return index
  }
  return -1
}

type PanelWidth = "list" | "search" | "field" | "sort"

/**
 * The part of the page the owner sees, in the coordinates `getBoundingClientRect` and a fixed panel use (the layout
 * viewport's). Zoomed in by a pinch on a phone, that is the visual viewport: smaller than the layout and moved by its
 * offsets. Without `visualViewport`, the window.
 */
export function visibleArea(): { left: number; top: number; right: number; bottom: number } {
  const view = window.visualViewport
  if (view && view.width > 0 && view.height > 0)
    return {
      left: view.offsetLeft,
      top: view.offsetTop,
      right: view.offsetLeft + view.width,
      bottom: view.offsetTop + view.height,
    }
  return {
    left: 0,
    top: 0,
    right: document.documentElement.clientWidth || window.innerWidth,
    bottom: window.innerHeight,
  }
}

/**
 * Where the panel may hang: the visible area 8px in from each end, below the phone's top bar and above its tab bar.
 * A picker inside another layer (a dialog or sheet) sits over those bars, so only the visible area counts.
 */
function room(anchor: HTMLElement): { top: number; bottom: number; left: number; right: number } {
  const view = visibleArea()
  let top = view.top + EDGE
  let bottom = view.bottom - EDGE
  if (!anchor.closest("[data-layer]")) {
    const bar = document.querySelector(".ui-mtop")?.getBoundingClientRect()
    if (bar && bar.height > 0 && bar.bottom > view.top) top = Math.max(top, bar.bottom + EDGE)
    const tabs = document.querySelector(".ui-tabbar")?.getBoundingClientRect()
    if (tabs && tabs.height > 0 && tabs.top < view.bottom) bottom = Math.min(bottom, tabs.top - EDGE)
  }
  return { top, bottom, left: view.left + EDGE, right: view.right - EDGE }
}

/**
 * A width limit no larger than `across`: in pixels when the browser resolved it, else as a CSS min(); `unset` when
 * the stylesheet sets none.
 */
function capped(limit: string, across: number, unset: string): string {
  if (limit === "" || limit === "none" || limit === "auto") return unset
  const pixels = /^-?[\d.]+px$/.test(limit) ? Number.parseFloat(limit) : Number.NaN
  return Number.isFinite(pixels) ? `${Math.min(pixels, across)}px` : `min(${limit}, ${across}px)`
}

export function place(
  anchor: HTMLElement,
  panel: HTMLElement,
  options: { width: PanelWidth; align: "start" | "end"; rtl: boolean; first: boolean },
): void {
  let bounds = room(anchor)
  let rect = anchor.getBoundingClientRect()
  // A button under a bar (reached with the keyboard) comes to the middle of the screen first.
  if (options.first && (rect.top < bounds.top || rect.bottom > bounds.bottom)) {
    anchor.scrollIntoView({ block: "center" })
    bounds = room(anchor)
    rect = anchor.getBoundingClientRect()
  }
  const style = panel.style
  style.left = ""
  style.right = ""
  style.top = ""
  style.bottom = ""
  style.maxHeight = ""
  style.minWidth = ""
  style.maxWidth = ""
  const across = Math.max(bounds.right - bounds.left, 0)
  // The stylesheet's width limits, each capped by the visible width: a min-width would otherwise win over any
  // max-width, and the stylesheet's own max-width (320px for a list) must stay when there is room.
  const css = getComputedStyle(panel)
  style.minWidth = capped(css.minWidth, across, "0px")
  style.maxWidth = capped(css.maxWidth, across, `${across}px`)
  style.width = options.width === "field" ? `${Math.min(Math.max(rect.width, 280), across)}px` : ""
  // Panels at the end of a row span the visible width on a phone, with 16px margins (MP-5).
  if (options.align === "end" && options.width !== "field" && matchMedia(PHONE).matches) {
    style.left = `${bounds.left - EDGE + 16}px`
    style.width = `${Math.max(across + 2 * EDGE - 32, 0)}px`
  } else {
    const width = Math.min(panel.offsetWidth, across)
    // The start edge is the button's start in the reading direction; the end edge, its end.
    const startsAt = options.rtl ? rect.right - width : rect.left
    const endsAt = options.rtl ? rect.left : rect.right - width
    const wanted = options.align === "start" ? startsAt : endsAt
    style.left = `${Math.max(bounds.left, Math.min(wanted, bounds.right - width))}px`
  }
  const height = panel.scrollHeight
  const below = bounds.bottom - rect.bottom - GAP
  const above = rect.top - GAP - bounds.top
  // Under the button, unless it does not fit there and the room above is larger (MP-5).
  if (height <= below || below >= above) {
    style.top = `${rect.bottom + GAP}px`
    style.maxHeight = `${Math.max(below, 0)}px`
  } else {
    // Measured from the top, as the visible area is: its bottom is not the layout's while zoomed in.
    style.top = `${rect.top - GAP - Math.min(height, Math.max(above, 0))}px`
    style.maxHeight = `${Math.max(above, 0)}px`
  }
  style.visibility = "visible"
}

/**
 * Scrolls a list so an option inside it shows, centred, when it is out of view. Measured against the list itself: the
 * option's offsetTop counts from the panel, above which the search field and its gap sit.
 */
export function showInList(list: HTMLElement, option: HTMLElement): void {
  const box = list.getBoundingClientRect()
  const item = option.getBoundingClientRect()
  if (item.top >= box.top && item.bottom <= box.top + list.clientHeight) return
  const offset = item.top - box.top + list.scrollTop
  list.scrollTop = Math.max(0, offset - (list.clientHeight - item.height) / 2)
}

/** Whether a Tab from `from` would leave the panel: the panel's own tab stops, one per radio group. */
export function tabLeaves(panel: HTMLElement, from: Element | null, back: boolean): boolean {
  const radioGroup = (element: Element | null) =>
    element instanceof HTMLInputElement && element.type === "radio" ? element.name : null
  // One stop per control, and one per group of radios, in page order.
  const stops: string[] = []
  const controls = panel.querySelectorAll<HTMLElement>(
    "input:not(:disabled), button:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']",
  )
  controls.forEach((element, index) => {
    const group = radioGroup(element)
    const stop = group === null ? `control-${index}` : `radios-${group}`
    if (!stops.includes(stop)) stops.push(stop)
  })
  const group = radioGroup(from)
  const at =
    group !== null
      ? stops.indexOf(`radios-${group}`)
      : stops.indexOf(`control-${Array.from(controls).indexOf(from as HTMLElement)}`)
  // An option of the listbox is no tab stop: Tab from it leaves the panel.
  if (at === -1) return true
  return back ? at === 0 : at === stops.length - 1
}

/**
 * The panel of a picker: a layer of ui/layers.ts, portalled into <body> as every layer is, placed beside its
 * button. `kind` "listbox" holds the options of `Picker`; "dialog" holds a small set of controls (the Sort
 * menu), named by `label`.
 */
export function PickerPanel({
  anchor,
  label,
  kind,
  width,
  align = "start",
  onClose,
  initialFocus,
  children,
}: {
  anchor: RefObject<HTMLElement | null>
  label: string
  kind: "listbox" | "dialog"
  width: PanelWidth
  align?: "start" | "end"
  onClose: () => void
  initialFocus: (panel: HTMLElement) => HTMLElement | null
  children: ReactNode
}) {
  const { dir } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const focusRef = useRef(initialFocus)
  focusRef.current = initialFocus
  const pressedOutside = useRef(false)
  const placed = useRef(false)

  // Placed before it shows, again when the screen changes size, and after each redraw (a search that narrows the
  // list keeps the panel on its side of the button).
  useLayoutEffect(() => {
    const button = anchor.current
    const panel = panelRef.current
    if (!button || !panel) return
    place(button, panel, { width, align, rtl: dir === "rtl", first: !placed.current })
    placed.current = true
  })
  useEffect(() => {
    const again = () => {
      const button = anchor.current
      const panel = panelRef.current
      if (button && panel) place(button, panel, { width, align, rtl: dir === "rtl", first: false })
    }
    window.addEventListener("resize", again)
    window.visualViewport?.addEventListener("resize", again)
    return () => {
      window.removeEventListener("resize", again)
      window.visualViewport?.removeEventListener("resize", again)
    }
  }, [anchor, width, align, dir])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    return openLayer({
      root,
      close: () => closeRef.current(),
      initialFocus: () => (panelRef.current ? focusRef.current(panelRef.current) : null),
    })
  }, [])

  // The button can hide at 760px (the phone's stage picker): the picker that belongs to it closes.
  useEffect(() => {
    const media = matchMedia(PHONE)
    const onChange = () => closeRef.current()
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Tabbing out closes the picker; its button takes the focus back (MP-1).
    if (event.key === "Tab" && tabLeaves(event.currentTarget, document.activeElement, event.shiftKey)) {
      event.preventDefault()
      closeRef.current()
    }
  }

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: a press beside the picker closes it; Escape does the same by keyboard
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above
    <div
      ref={rootRef}
      className="ui-picker-backdrop"
      data-layer="picker"
      onMouseDown={(event) => {
        pressedOutside.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && (pressedOutside.current || event.detail === 0)) closeRef.current()
        pressedOutside.current = false
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the panel only watches Tab, which closes it; its listbox or dialog role is the control */}
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label is set only with the dialog role */}
      <div
        ref={panelRef}
        className={`ui-picker-panel ui-picker-w-${width}${kind === "dialog" ? " ui-picker-dialog" : ""}`}
        role={kind === "dialog" ? "dialog" : undefined}
        aria-label={kind === "dialog" ? label : undefined}
        data-layer-panel=""
        style={{ visibility: "hidden" }}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

type PickerCommon = {
  /** The filter's or the field's name ("Stage", "Project"). */
  label: string
  value: string
  options: PickerOption[]
  onChange: (value: string) => void
  /** What the search field is called ("Search projects"); "Search <label>" by default. */
  searchLabel?: string
  /** A search field however many options there are; by default above more than ten (MP-4). */
  search?: boolean
  disabled?: boolean
  /** The end of a row opens toward the start (MP-5). */
  align?: "start" | "end"
}

export type PickerProps = PickerCommon &
  (
    | {
        /** A list filter: a pill named by its filter and value ("Stage: All"), solid when not at its default. */
        variant?: "filter"
        defaultValue: string
      }
    | {
        /** A form value: looks like a select, shows only the value, named by its field's label (MP-1 `field`). */
        variant: "field"
        id?: string
        labelledBy: string
      }
    | {
        /** An action: the button says what a pick does ("Move to project"); a pick acts at once. */
        variant: "action"
        text: string
        ariaLabel: string
      }
  )

/**
 * One accessible picker (MP-1): a button and a listbox. Up and Down move and stop at the ends, Home and End jump,
 * Up from the first option returns to the search, Enter or Space pick, typing a letter jumps to the next option
 * that starts with it, ArrowDown or ArrowUp on the button opens it. More than ten options get a search field
 * above them (MP-4); Enter in it picks the first match, and with none left does nothing.
 */
export function Picker(props: PickerProps) {
  const { t, language } = useI18n()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const valueId = useId()
  const selected = props.options.find((option) => option.value === props.value)
  const variant = props.variant ?? "filter"

  const common = {
    ref: buttonRef,
    type: "button" as const,
    disabled: props.disabled,
    "aria-haspopup": "listbox" as const,
    "aria-expanded": open,
    "aria-controls": open ? listId : undefined,
    onClick: (event: { currentTarget: HTMLButtonElement }) => {
      // The button holds the focus while its picker is open, so the focus comes back to it on close (Safari does
      // not focus a clicked button).
      event.currentTarget.focus({ preventScroll: true })
      setOpen((now) => !now)
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        setOpen(true)
      }
    },
  }
  const arrow = <ChevronDown className="ui-select-arrow" aria-hidden="true" />

  let button: ReactNode
  if (props.variant === "field") {
    button = (
      <button
        {...common}
        id={props.id}
        className="ui-select-btn ui-picker-btn"
        aria-labelledby={`${props.labelledBy} ${valueId}`}
      >
        <span id={valueId}>
          <bdi>{selected?.label ?? ""}</bdi>
        </span>
        {arrow}
      </button>
    )
  } else if (props.variant === "action") {
    button = (
      <button {...common} className="ui-btn ui-btn-sm ui-picker-btn ui-picker-action" aria-label={props.ariaLabel}>
        <span>{props.text}</span>
        {arrow}
      </button>
    )
  } else {
    button = (
      <button
        {...common}
        className="ui-picker-btn ui-picker-pill"
        data-set={props.value !== props.defaultValue ? "" : undefined}
      >
        <span className="ui-picker-name">{props.label}:</span>
        <span className="ui-picker-value">
          <bdi>{selected?.label ?? ""}</bdi>
        </span>
        {arrow}
      </button>
    )
  }

  const searchable = props.search ?? props.options.length > SEARCH_FROM
  return (
    <span className={variant === "field" ? "ui-picker is-field" : "ui-picker"}>
      {button}
      {open ? (
        <PickerPanel
          anchor={buttonRef}
          label={props.label}
          kind="listbox"
          width={variant === "field" ? "field" : searchable ? "search" : "list"}
          align={props.align}
          onClose={() => setOpen(false)}
          initialFocus={(panel) => {
            const search = panel.querySelector<HTMLElement>(".ui-picker-search")
            if (search && !touchOnly()) return search
            const options = Array.from(panel.querySelectorAll<HTMLElement>('[role="option"]'))
            const chosen = options.find((option) => option.getAttribute("aria-selected") === "true") ?? options[0]
            const list = chosen?.parentElement
            // Only the list scrolls to show it; the page stays where it is.
            if (chosen && list) showInList(list, chosen)
            return chosen ?? null
          }}
        >
          <PickerList
            listId={listId}
            label={props.label}
            searchLabel={
              props.searchLabel ??
              t("picker.search", { label: language === "en" ? props.label.toLocaleLowerCase("en") : props.label })
            }
            searchable={searchable}
            value={props.value}
            options={props.options}
            onPick={(value) => {
              // The option's own handler runs first; the layer then gives the focus back to the button.
              props.onChange(value)
              setOpen(false)
            }}
          />
        </PickerPanel>
      ) : null}
    </span>
  )
}

/** The search field and the options; closing the picker unmounts it, which clears the search (MP-4). */
function PickerList({
  listId,
  label,
  searchLabel,
  searchable,
  value,
  options,
  onPick,
}: {
  listId: string
  label: string
  searchLabel: string
  searchable: boolean
  value: string
  options: PickerOption[]
  onPick: (value: string) => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState("")
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const typed = useRef({ text: "", at: 0 })
  const shown = searchable ? filterOptions(options, query) : options

  const optionEls = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const els = optionEls()
    const at = els.indexOf(document.activeElement as HTMLElement)
    const move = (index: number) => els[Math.max(0, Math.min(els.length - 1, index))]?.focus()
    if (event.key === "ArrowDown") move(at + 1)
    else if (event.key === "ArrowUp") {
      if (at <= 0 && searchable) searchRef.current?.focus()
      else move(at - 1)
    } else if (event.key === "Home") move(0)
    else if (event.key === "End") move(els.length - 1)
    else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Type-ahead: letters typed within a moment of each other spell the start of an option.
      const now = performance.now()
      typed.current = { text: now - typed.current.at < 700 ? typed.current.text + event.key : event.key, at: now }
      const labels = shown.map((option) => option.label)
      let index = typeAhead(labels, typed.current.text, at)
      // Letters that spell no option start again from the last one.
      if (index === -1 && typed.current.text.length > 1) {
        typed.current.text = event.key
        index = typeAhead(labels, event.key, at)
      }
      if (index !== -1) move(index)
    } else return
    event.preventDefault()
  }

  return (
    <>
      {searchable ? (
        <input
          ref={searchRef}
          type="search"
          className="ui-input ui-picker-search"
          dir="auto"
          value={query}
          placeholder={searchLabel}
          aria-label={searchLabel}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault()
              optionEls()[0]?.focus()
            } else if (event.key === "Enter") {
              // The first match; with none left Enter does nothing, so it never submits a form around the picker.
              event.preventDefault()
              const first = shown[0]
              if (first) onPick(first.value)
            }
          }}
        />
      ) : null}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={label}
        className={searchable ? "ui-picker-list has-search" : "ui-picker-list"}
        onKeyDown={onListKey}
      >
        {shown.map((option) => (
          <div
            key={option.value}
            role="option"
            tabIndex={-1}
            aria-selected={option.value === value}
            className="ui-picker-opt"
            onClick={() => onPick(option.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onPick(option.value)
              }
            }}
          >
            <span className="ui-picker-opt-label">
              <bdi>{option.label}</bdi>
            </span>
            {option.hint !== undefined ? <small>{option.hint}</small> : null}
          </div>
        ))}
        {shown.length === 0 ? (
          <p role="status" className="ui-picker-none">
            {t("picker.noMatches")}
          </p>
        ) : null}
      </div>
    </>
  )
}
