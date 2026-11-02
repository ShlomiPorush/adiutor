// The phone More sheet (v3 NL-9): every page, with the same counters as the sidebar, sliding up
// from just above the tab bar. A layer of its own on purpose (listed in popups.guard.test.ts): the
// page behind is inert while the tab bar stays usable. Escape, Back and a tap outside close it, and
// a page picked in it replaces the sheet's history entry instead of stacking one more. The sheet closes once
// the move is made (the shell closes it on a new path), so the Leave question's Stay keeps it open; the page
// already open only closes it. Its foot holds the theme button, as n8n-ops' sheet does.

import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { NavLink, useLocation } from "react-router"
import { useI18n } from "../i18n/i18n.tsx"
import { openLayer } from "../ui/layers.ts"
import { NAV } from "./navigation.ts"
import { ThemeButton } from "./ShellTools.tsx"

export function MoreSheet({ inbox, onClose }: { inbox: number; onClose: () => void }) {
  const { t } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const { pathname } = useLocation()

  // The veil is the layer's root, portalled into <body> as the dialog builder does.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    return openLayer({
      root,
      close: () => closeRef.current(),
      initialFocus: () =>
        root.querySelector<HTMLElement>("[aria-current=page]") ?? root.querySelector<HTMLElement>("a"),
      inertOnly: () => Array.from(document.querySelectorAll<HTMLElement>(".ui-mtop, .ui-content")),
    })
  }, [])

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the veil is not a control; Escape, Back and the More button close the sheet
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above
    <div
      ref={rootRef}
      className="ui-moresheet"
      data-layer="more"
      onClick={(event) => {
        if (event.target === event.currentTarget) closeRef.current()
      }}
    >
      <div
        className="ui-moresheet-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("nav.allPages")}
        data-layer-panel=""
      >
        {NAV.map((page) => (
          <NavLink
            key={page.id}
            to={page.to}
            end={page.to === "/"}
            replace
            className="ui-nav-item"
            onClick={(event) => {
              if (page.to !== pathname) return
              event.preventDefault()
              closeRef.current()
            }}
          >
            <page.icon aria-hidden="true" />
            <span className="ui-nav-label">{t(`nav.${page.id}`)}</span>
            {page.id === "inbox" && inbox > 0 ? <span className="ui-nav-count">{inbox}</span> : null}
          </NavLink>
        ))}
        <div className="ui-moresheet-foot">
          <ThemeButton />
        </div>
      </div>
    </div>,
    document.body,
  )
}
