// The rows of the Settings page: label and explanation at the start, the control at the end (v3 FS-8), the lock of a
// setting the environment sets (FS-6), and an on/off switch built from a real checkbox whose whole row is its label
// (FS-1, FS-2).

import { Lock } from "lucide-react"
import { type ReactNode, useId } from "react"
import { useI18n } from "../../i18n/i18n.tsx"

export function Row({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string
  hint: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="ui-set-row">
      <div>
        {htmlFor ? (
          <label htmlFor={htmlFor}>
            <b>{label}</b>
          </label>
        ) : (
          <b>{label}</b>
        )}
        <span>{hint}</span>
      </div>
      <div className="ui-set-control">{children}</div>
    </div>
  )
}

/** A setting the environment sets: read-only, with the variable to change and a restart. */
export function EnvLock({ variable }: { variable: string | null }) {
  const { t } = useI18n()
  return (
    <span className="ui-set-lock">
      <span className="ui-set-pill" title={t("settings.env.tooltip")}>
        <Lock size={12} aria-hidden="true" /> {t("settings.env.pill")}
      </span>
      <span className="ui-hint">{t("settings.env.note", { variable: variable ?? "" })}</span>
    </span>
  )
}

/** An on/off setting: the whole row flips it; a locked one says why in a visible note. */
export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
  note,
}: {
  label: string
  hint: ReactNode
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /** Why the switch cannot change now; shown under the hint. */
  note?: ReactNode
}) {
  const id = useId()
  return (
    <div className={`ui-set-row ui-set-bool${disabled ? " is-locked" : ""}`}>
      <label className="ui-set-bool-main" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          aria-checked={checked}
          className="ui-switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="ui-set-bool-text">
          <b>{label}</b>
          <span className="ui-set-bool-hint">{hint}</span>
          {note ? (
            <span className="ui-set-note" role="status">
              {note}
            </span>
          ) : null}
        </span>
      </label>
    </div>
  )
}
