// The parts of a Settings section: a group, a small panel with a 13px title; rows with the label and explanation at
// the start and the control at the end, the control filling its column (v3 FS-8); an on/off switch built from a real
// checkbox whose whole row is its label (FS-1, FS-2); and the marks of a row (FS-6): a neutral "Set by the
// environment" tag on the label line with the variable under the explanation and the control disabled in place, a
// blue Changed tag with "Reset to default (value)" for a value that differs from its default, and Clear for an owner
// value that has no default. A locked value never gets Changed, Reset or Clear; a secret never gets Changed or Reset.

import { Lock, RotateCcw, X } from "lucide-react"
import { type ReactNode, useId } from "react"
import { formatNumber } from "../../format/number.ts"
import { useI18n } from "../../i18n/i18n.tsx"

/** A group of a section: a small panel with a 13px title, its count and its list actions at the end of its head. */
export function Group({
  id,
  title,
  count,
  extra,
  intro,
  heading: Heading = "h3",
  children,
}: {
  id: string
  title: string
  count?: number
  /** Actions on the whole list (Disconnect all), at the end of the head (S-12). */
  extra?: ReactNode
  /** One muted line under the head that says what the group is for. */
  intro?: ReactNode
  /** h3 under a Settings section's h2; h2 on a page without sections (Account). */
  heading?: "h2" | "h3"
  children: ReactNode
}) {
  return (
    <section id={id} className="ui-panel ui-set-group" aria-labelledby={`${id}-title`}>
      <div className="ui-set-group-head">
        <Heading id={`${id}-title`} className="ui-set-group-title">
          {title}
        </Heading>
        {count !== undefined ? <span className="ui-count">{formatNumber(count)}</span> : null}
        {extra ? <div className="ui-set-group-acts">{extra}</div> : null}
      </div>
      {intro ? <p className="ui-set-group-intro">{intro}</p> : null}
      {children}
    </section>
  )
}

/** A Status group's facts, each its name over its value (FS-8, v3's facts grid). */
export function Facts({ children }: { children: ReactNode }) {
  return <div className="ui-set-facts">{children}</div>
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ui-set-fact">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  )
}

/** The environment sets this value: the variable that does. */
export type EnvLock = { variable: string | null }
/** The value differs from its default: the default's name, and what puts it back in the draft. */
export type ResetMark = { label: string; onReset: () => void }

/** The marks of a row; a locked row shows only its lock. */
type Marks = {
  lock?: EnvLock | null
  reset?: ResetMark | null
  /** Empties an owner value that has no default (the chat id); shown only while it holds one. */
  onClear?: (() => void) | null
}

/** The neutral tag beside the label of a value the environment sets (FS-6). */
function LockPill() {
  const { t } = useI18n()
  return (
    <span className="ui-set-pill" title={t("settings.env.tooltip")}>
      <Lock size={12} aria-hidden="true" /> {t("settings.env.pill")}
    </span>
  )
}

function ChangedPill() {
  const { t } = useI18n()
  return (
    <span className="ui-set-pill is-changed" title={t("settings.changedTooltip")}>
      {t("settings.changed")}
    </span>
  )
}

/** Under the explanation: the variable of a lock, else Reset or Clear. */
function MarkLine({ lock, reset, onClear }: Marks) {
  const { t } = useI18n()
  if (lock)
    return (
      <span className="ui-set-env">
        <Lock size={12} aria-hidden="true" />
        <span>{t("settings.env.note", { variable: lock.variable ?? "" })}</span>
      </span>
    )
  if (reset)
    return (
      <button type="button" className="ui-set-clear is-reset" onClick={reset.onReset}>
        <RotateCcw size={12} aria-hidden="true" /> {t("settings.resetTo", { value: reset.label })}
      </button>
    )
  if (onClear)
    return (
      <button type="button" className="ui-set-clear" onClick={onClear}>
        <X size={12} aria-hidden="true" /> {t("settings.clear")}
      </button>
    )
  return null
}

export function Row({
  label,
  hint,
  htmlFor,
  lock,
  reset,
  onClear,
  children,
}: Marks & {
  label: string
  hint?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className={`ui-set-row${lock ? " is-locked" : ""}`}>
      <div className="ui-set-label">
        <span className="ui-set-label-line">
          {htmlFor ? (
            <label htmlFor={htmlFor}>
              <b>{label}</b>
            </label>
          ) : (
            <b>{label}</b>
          )}
          {lock ? <LockPill /> : reset ? <ChangedPill /> : null}
        </span>
        {hint ? <span className="ui-set-desc">{hint}</span> : null}
        <MarkLine lock={lock} reset={lock ? null : reset} onClear={lock ? null : onClear} />
      </div>
      <div className="ui-set-control">{children}</div>
    </div>
  )
}

/** An on/off setting: the whole row flips it; a locked one says why in a visible note. */
export function SwitchRow({
  id: givenId,
  label,
  hint,
  checked,
  onChange,
  disabled,
  note,
  invalidProps,
  lock,
  reset,
}: Omit<Marks, "onClear"> & {
  /** The checkbox id, when the page focuses it (a refused save). */
  id?: string
  label: string
  hint: ReactNode
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /** Why the switch cannot change now, or what turning it on means; shown under the hint. */
  note?: ReactNode
  invalidProps?: Record<string, unknown>
}) {
  const ownId = useId()
  const id = givenId ?? ownId
  const locked = disabled || Boolean(lock)
  return (
    <div className={`ui-set-row ui-set-bool${locked ? " is-locked" : ""}`}>
      <label className="ui-set-bool-main" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          aria-checked={checked}
          className="ui-switch"
          checked={checked}
          disabled={locked}
          {...invalidProps}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="ui-set-bool-text">
          <span className="ui-set-label-line">
            <b>{label}</b>
            {lock ? <LockPill /> : reset ? <ChangedPill /> : null}
          </span>
          <span className="ui-set-bool-hint">{hint}</span>
          {note ? (
            <span className="ui-set-note" role="status">
              {note}
            </span>
          ) : null}
        </span>
      </label>
      {/* Outside the label: a button inside it would be part of the switch's name and its click. */}
      {lock || reset ? (
        <div className="ui-set-bool-marks">
          <MarkLine lock={lock} reset={lock ? null : reset} />
        </div>
      ) : null}
    </div>
  )
}
