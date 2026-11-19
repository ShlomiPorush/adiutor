// Parts that several pages draw the same way: a panel with its head, an item row that opens the
// item, and the project and inbox names.

import { type KeyboardEvent, type ReactNode, useId } from "react"
import type { ItemSummary } from "../api/types.ts"
import { formatNumber } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { useOpenItem } from "../shell/items.ts"
import { FoldButton, useFold } from "../ui/fold.tsx"
import { Time } from "../ui/Time.tsx"
import { SeverityTag, STATUS_TONE, StatusTag, Tag, TypeTag } from "../ui/tags.tsx"

export function Panel({
  id,
  title,
  count,
  extra,
  fold,
  children,
}: {
  id?: string
  title: string
  count?: number
  extra?: ReactNode
  /** Starts folded, and this browser keeps the owner's choice under this key (ui/fold.tsx). */
  fold?: string
  children: ReactNode
}) {
  const headingId = id ? `${id}-title` : undefined
  const countTag = count !== undefined ? <span className="ui-count">{formatNumber(count)}</span> : null
  if (fold) {
    return (
      <FoldPanel id={id} headingId={headingId} title={title} count={countTag} extra={extra} remember={fold}>
        {children}
      </FoldPanel>
    )
  }
  return (
    <section id={id} className="ui-panel" aria-labelledby={headingId}>
      <div className="ui-panel-head">
        <h2 id={headingId}>{title}</h2>
        {countTag}
        {extra}
      </div>
      {children}
    </section>
  )
}

function FoldPanel({
  id,
  headingId,
  title,
  count,
  extra,
  remember,
  children,
}: {
  id?: string
  headingId?: string
  title: string
  count: ReactNode
  extra?: ReactNode
  remember: string
  children: ReactNode
}) {
  const [open, setOpen] = useFold(remember)
  const bodyId = useId()
  return (
    <section id={id} className="ui-panel ui-panel-fold" aria-labelledby={headingId}>
      <div className="ui-panel-head">
        <h2 id={headingId}>
          <FoldButton open={open} onToggle={setOpen} controls={bodyId}>
            {title}
            {count}
          </FoldButton>
        </h2>
        {extra}
      </div>
      <div id={bodyId} className="ui-fold-body" hidden={!open}>
        {children}
      </div>
    </section>
  )
}

/** Enter and Space open a row that has the focus itself (v3 AX-5, TB-8). */
export function rowKeys(open: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
      event.preventDefault()
      open()
    }
  }
}

/** A click that ends a text selection in the row opens nothing, so its text can be copied. */
export function selecting(event: { currentTarget: HTMLElement; detail: number }): boolean {
  const selection = window.getSelection()
  return (
    !!selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode) && event.detail !== 0
  )
}

export function ItemRow({
  item,
  showProject = true,
  time = "updatedAt",
  badge,
}: {
  item: ItemSummary
  showProject?: boolean
  time?: "updatedAt" | "createdAt" | "closedAt"
  /** New since the last visit: created or changed. */
  badge?: string
}) {
  const { t } = useI18n()
  const openItem = useOpenItem()
  const open = () => openItem(item.id)
  return (
    // biome-ignore lint/a11y/useSemanticElements: a whole row opens it (v3 TB-8); it holds block content and links, so it cannot be a <button>
    <div
      className="ui-item"
      data-tone={STATUS_TONE[item.status] === "neutral" ? undefined : STATUS_TONE[item.status]}
      data-row-open=""
      role="button"
      tabIndex={0}
      aria-label={t("item.openNamed", { title: item.title })}
      onClick={(event) => {
        if (!selecting(event)) open()
      }}
      onKeyDown={rowKeys(open)}
    >
      <div className="ui-item-main">
        <span className="ui-item-title" dir="auto" title={item.title}>
          {badge ? (
            <>
              <i className="ui-unread" aria-hidden="true" />{" "}
            </>
          ) : null}
          {item.title}
        </span>
        <span className="ui-item-meta">
          {badge ? <Tag tone="info">{badge}</Tag> : null}
          {showProject ? item.projectName ? <bdi dir="auto">{item.projectName}</bdi> : <span>{t("inbox")}</span> : null}
          <TypeTag type={item.type} />
          {item.severity ? <SeverityTag severity={item.severity} /> : null}
        </span>
      </div>
      <div className="ui-item-end">
        <StatusTag status={item.status} />
        <Time value={item[time]} />
      </div>
    </div>
  )
}
