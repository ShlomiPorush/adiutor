// Needs attention from every page (v3 NL-19): a bell in the top bar counts what waits on the owner
// (items waiting on you, open stage proposals, projects with critical security findings). Red when
// something is critical, amber otherwise, hidden at zero. It opens the same list with the same
// actions: a window under the bell on a wide screen (a layer of its own, listed in
// popups.guard.test.ts), a sheet from the dialog builder on a phone. A failed read keeps the last
// count and says some checks could not run. A row that opens a page from the window or the sheet opens it in
// place of the layer's history entry, and the layer closes once the page shows (as the More sheet does), so
// Back from that page returns to the page under the bell in one step.

import { useQueryClient } from "@tanstack/react-query"
import { Bell as BellIcon, X } from "lucide-react"
import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Link, useLocation, useNavigate } from "react-router"
import { api, qk } from "../api/endpoints.ts"
import type { Morning, WaitingProposal } from "../api/types.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { openLayer } from "../ui/layers.ts"
import { Empty, errorReason } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { SeverityTag, StatusTag } from "../ui/tags.tsx"
import { useOpenItem, useRefreshItems } from "./items.ts"

export function attentionOf(morning: Morning | undefined) {
  if (!morning) return { count: 0, tone: "none" as const, critical: [] as Morning["security"] }
  const critical = morning.security.filter((line) => line.critical > 0)
  const count = morning.waiting.length + critical.length
  return { count, tone: critical.length ? ("fail" as const) : count ? ("warn" as const) : ("none" as const), critical }
}

const PHONE = "(max-width: 760px)"

export function Bell({
  morning,
  failed,
  place,
}: {
  morning: Morning | undefined
  failed: boolean
  place: "top" | "phone"
}) {
  const { t, tc } = useI18n()
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  // A page opened from the window or the sheet took its history entry: the layer closes once it shows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every new page
  useEffect(() => setOpen(false), [pathname])
  const button = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const { count, tone } = attentionOf(morning)
  const unknown = failed && count === 0
  const name = unknown ? t("bell.unknown") : count ? tc("bell.named", count) : t("bell.none")

  // The window belongs to its bell: it closes when the width moves it to the other bar.
  useEffect(() => {
    if (!open) return
    const media = matchMedia(PHONE)
    const onChange = () => setOpen(false)
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [open])

  const phone = typeof matchMedia === "function" && matchMedia(PHONE).matches
  return (
    <>
      <button
        ref={button}
        type="button"
        className="ui-icon-btn ui-bell"
        aria-label={name}
        title={name}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <BellIcon aria-hidden="true" />
        {unknown ? <span className="ui-bell-n is-unknown" aria-hidden="true" /> : null}
        {count > 0 ? (
          <span className={tone === "fail" ? "ui-bell-n is-fail" : "ui-bell-n"} aria-hidden="true">
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </button>
      {open && place === "phone" && phone ? (
        <Dialog size="md" title={t("bell.title")} onClose={() => setOpen(false)} backdropClose>
          <AttentionList morning={morning} failed={failed} onDone={() => setOpen(false)} />
        </Dialog>
      ) : null}
      {open && !(place === "phone" && phone) ? (
        <BellWindow id={panelId} anchor={button} morning={morning} failed={failed} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}

function BellWindow({
  id,
  anchor,
  morning,
  failed,
  onClose,
}: {
  id: string
  anchor: RefObject<HTMLButtonElement | null>
  morning: Morning | undefined
  failed: boolean
  onClose: () => void
}) {
  const { t, tc, dir } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const pressedOutside = useRef(false)
  const { pathname } = useLocation()
  const [place, setPlace] = useState<{ top: number; inset: number }>({ top: 70, inset: 16 })
  const { count } = attentionOf(morning)

  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect()
    if (!rect) return
    // Its end edge under the bell's end edge.
    const inset = dir === "rtl" ? rect.left : window.innerWidth - rect.right
    setPlace({ top: rect.bottom + 8, inset: Math.max(16, inset) })
  }, [anchor, dir])
  // The click-outside area is the layer's root, portalled into <body> as the dialog builder does.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    return openLayer({
      root,
      close: () => closeRef.current(),
      initialFocus: () => root.querySelector<HTMLElement>(".ui-attn-list"),
    })
  }, [])

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: a click beside the window closes it; Escape and the X do the same by keyboard
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above
    <div
      ref={rootRef}
      className="ui-attn-backdrop"
      data-layer="bell"
      onMouseDown={(event) => {
        pressedOutside.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && (pressedOutside.current || event.detail === 0)) closeRef.current()
        pressedOutside.current = false
      }}
    >
      <div
        id={id}
        className="ui-attn-win"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-layer-panel=""
        style={{ top: place.top, insetInlineEnd: place.inset }}
      >
        <div className="ui-attn-head">
          <h3 id={titleId}>
            {t("bell.title")} {count ? <span className="ui-muted ui-num">{tc("bell.count", count)}</span> : null}
          </h3>
          <button
            type="button"
            className="ui-icon-btn"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={() => closeRef.current()}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the list scrolls by keyboard */}
        <div className="ui-attn-list" tabIndex={0}>
          <AttentionList morning={morning} failed={failed} onDone={() => closeRef.current()} />
        </div>
        <div className="ui-attn-foot">
          {/* Another page: the link takes the window's entry and the window closes once the page shows, so Stay in
              the Leave question keeps it open. On the morning view already, it only closes. */}
          <Link
            to="/"
            replace
            className="ui-link"
            onClick={() => {
              if (pathname === "/") closeRef.current()
            }}
          >
            {t("bell.openMorning")}
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** The rows that need the owner, with one action each; shared by the bell and the morning view. */
export function AttentionList({
  morning,
  failed,
  onDone,
}: {
  morning: Morning | undefined
  failed: boolean
  onDone?: () => void
}) {
  const { t, tc } = useI18n()
  const openItem = useOpenItem()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { critical } = attentionOf(morning)
  /** A project's page: from the bell's layer in place of its entry (the layer closes once it shows). */
  const openProject = (projectId: string) => {
    const to = `/projects/${projectId}`
    if (!onDone) navigate(to)
    else if (to === pathname) onDone()
    else navigate(to, { replace: true })
  }
  if (!morning) return <Empty title={failed ? t("bell.failed") : t("bell.loading")} />
  const empty = morning.waiting.length + critical.length === 0
  return (
    <div>
      {failed ? <p className="ui-list-end ui-text-warn">{t("bell.someFailed")}</p> : null}
      {empty && !failed ? <Empty title={t("bell.allClear")} hint={t("bell.allClearHint")} /> : null}
      {critical.map((line) => (
        // biome-ignore lint/a11y/useSemanticElements: a whole row opens it (v3 TB-8); it holds block content and links, so it cannot be a <button>
        <div
          key={`sec-${line.projectId}`}
          className="ui-alert"
          data-tone="fail"
          data-row-open=""
          role="button"
          tabIndex={0}
          onClick={() => openProject(line.projectId)}
          onKeyDown={(event) => {
            if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
              event.preventDefault()
              openProject(line.projectId)
            }
          }}
        >
          <i className="ui-alert-bar" />
          <div className="ui-alert-text">
            <span className="ui-alert-title">
              <bdi dir="auto">{line.projectName}</bdi> <SeverityTag severity="critical" />
            </span>
            <p>{tc("security.critical", line.critical)}</p>
          </div>
        </div>
      ))}
      {morning.waiting.map((entry) =>
        entry.kind === "stage_proposal" ? (
          <ProposalRow key={entry.proposal.id} proposal={entry.proposal} />
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: a whole row opens it (v3 TB-8); it holds block content and links, so it cannot be a <button>
          <div
            key={entry.item.id}
            className="ui-alert"
            data-tone="warn"
            data-row-open=""
            role="button"
            tabIndex={0}
            onClick={() => {
              onDone?.()
              openItem(entry.item.id)
            }}
            onKeyDown={(event) => {
              if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
                event.preventDefault()
                onDone?.()
                openItem(entry.item.id)
              }
            }}
          >
            <i className="ui-alert-bar" />
            <div className="ui-alert-text">
              <span className="ui-item-title" dir="auto">
                {entry.item.title}
              </span>
              <p>
                {entry.item.projectName ? <bdi dir="auto">{entry.item.projectName}</bdi> : t("inbox")} ·{" "}
                <StatusTag status={entry.item.status} /> · <Time value={entry.at} />
              </p>
            </div>
          </div>
        ),
      )}
    </div>
  )
}

/** An open stage proposal with Accept and Reject; one click each, the toast names the result. */
export type ProposalView = Pick<
  WaitingProposal,
  "id" | "projectId" | "projectName" | "proposedStage" | "reason" | "authorLabel" | "createdAt"
>

export function ProposalRow({ proposal }: { proposal: ProposalView }) {
  const { t, language } = useI18n()
  const refresh = useRefreshItems()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const act = async (accept: boolean) => {
    setBusy(true)
    try {
      await api.decideProposal(proposal.id, accept ? "accept" : "reject")
      showToast(
        accept
          ? t("proposal.accepted", { project: proposal.projectName, stage: t(`stage.${proposal.proposedStage}`) })
          : t("proposal.rejected", { project: proposal.projectName }),
        "success",
      )
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: qk.project(proposal.projectId) })])
    } catch (error) {
      showToast(t("proposal.failed", { reason: errorReason(language, error) }), "error")
      setBusy(false)
    }
  }
  return (
    <div className="ui-alert" data-tone="warn">
      <i className="ui-alert-bar" />
      <div className="ui-alert-text">
        <span className="ui-alert-title">
          {t("proposal.title", { stage: t(`stage.${proposal.proposedStage}`) })} ·{" "}
          <bdi dir="auto">{proposal.projectName}</bdi>
        </span>
        <p>
          {proposal.reason ? (
            <>
              <bdi dir="auto">{proposal.reason}</bdi> ·{" "}
            </>
          ) : null}
          {t("proposal.by")} <bdi dir="auto">{proposal.authorLabel}</bdi> · <Time value={proposal.createdAt} />
        </p>
      </div>
      <div className="ui-alert-acts">
        <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => act(false)}>
          {t("proposal.reject")}
        </button>
        <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => act(true)}>
          {t("proposal.accept")}
        </button>
      </div>
    </div>
  )
}
