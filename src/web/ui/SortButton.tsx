// The one Sort button of a list (v3 TB-28; n8n-ops' SortButton in components/ui/table.tsx), on the picker's
// panel (ui/Picker.tsx). A list whose header row phones hide has it at every size, at the end of its count
// line. It opens a small panel with two groups of radios, Sort by (the sortable columns by their header
// labels) and Order (worded by the column's kind); a choice applies at once and the panel stays open. The
// headers and the button set one order, so the two never disagree (TB-3). A dot marks an order that is not
// the list's default.

import { ArrowDownUp } from "lucide-react"
import { useId, useRef, useState } from "react"
import { useI18n } from "../i18n/i18n.tsx"
import { PickerPanel } from "./Picker.tsx"

export type SortDir = "asc" | "desc"
export type SortState<K extends string> = { key: K; dir: SortDir }
/** How a column's order is worded: "A to Z", "Low to high", "Oldest first", else "Ascending". */
export type SortKind = "text" | "number" | "date" | "other"
export type SortColumn<K extends string> = { key: K; label: string; kind: SortKind }

/** The order a column starts in (TB-1): text A to Z, numbers high to low, dates newest first. */
export function firstDir(kind: SortKind): SortDir {
  return kind === "text" || kind === "other" ? "asc" : "desc"
}

/** A header click: the sorted column turns around, another column starts in its own first order (TB-1). */
export function headerSort<K extends string>(sort: SortState<K>, column: SortColumn<K>): SortState<K> {
  if (sort.key === column.key) return { key: column.key, dir: sort.dir === "asc" ? "desc" : "asc" }
  return { key: column.key, dir: firstDir(column.kind) }
}

export function SortButton<K extends string>({
  name,
  columns,
  value,
  defaultValue,
  onChange,
}: {
  /** The list's name in the panel's title ("Sort projects"). */
  name: string
  columns: SortColumn<K>[]
  value: SortState<K>
  /** The order the list arrives in; the button shows no dot while it is in effect. */
  defaultValue: SortState<K>
  onChange: (sort: SortState<K>) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const column = columns.find((entry) => entry.key === value.key)
  const kind = column?.kind ?? "other"
  const words = (dir: SortDir) => t(`sort.words.${kind}.${dir}`)
  const label = t("sort.button", { column: column?.label ?? value.key, order: words(value.dir) })
  const isDefault = value.key === defaultValue.key && value.dir === defaultValue.dir
  // The order the column starts in comes first (TB-1).
  const dirs: SortDir[] = firstDir(kind) === "desc" ? ["desc", "asc"] : ["asc", "desc"]

  return (
    <span className="ui-sort-slot">
      <button
        ref={buttonRef}
        type="button"
        className="ui-icon-btn ui-sort-btn-icon"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        data-set={isDefault ? undefined : ""}
        onClick={(event) => {
          // The focus comes back to the button on close (Safari does not focus a clicked button).
          event.currentTarget.focus({ preventScroll: true })
          setOpen((now) => !now)
        }}
      >
        <ArrowDownUp aria-hidden="true" />
      </button>
      {open ? (
        <PickerPanel
          anchor={buttonRef}
          label={t("sort.panel", { name })}
          kind="dialog"
          width="sort"
          align="end"
          onClose={() => setOpen(false)}
          // Onto the checked choice of Sort by (TB-28).
          initialFocus={(panel) => panel.querySelector<HTMLElement>("fieldset input:checked")}
        >
          <fieldset className="ui-sort-group">
            <legend>{t("sort.by")}</legend>
            {columns.map((entry) => (
              <label key={entry.key} className="ui-sort-opt">
                <input
                  type="radio"
                  name={`${id}-by`}
                  checked={value.key === entry.key}
                  // A column picked starts in its own first order (TB-1).
                  onChange={() => onChange({ key: entry.key, dir: firstDir(entry.kind) })}
                />
                <span>{entry.label}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className="ui-sort-group">
            <legend>{t("sort.order")}</legend>
            {dirs.map((dir) => (
              <label key={dir} className="ui-sort-opt">
                <input
                  type="radio"
                  name={`${id}-order`}
                  checked={value.dir === dir}
                  onChange={() => onChange({ key: value.key, dir })}
                />
                <span>{words(dir)}</span>
              </label>
            ))}
          </fieldset>
        </PickerPanel>
      ) : null}
    </span>
  )
}
