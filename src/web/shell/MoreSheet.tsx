// The phone More sheet (v3 NL-9): every page, with the same counters as the sidebar, sliding up
// from just above the tab bar. A layer of its own on purpose (listed in popups.guard.test.ts): the
// page behind is inert while the tab bar stays usable. Escape, Back and a tap outside close it, and
// a page picked in it replaces the sheet's history entry instead of stacking one more.

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { NavLink } from "react-router"
import { useI18n } from "../i18n/i18n.tsx"
import { createLayerRoot, openLayer } from "../ui/layers.ts"
import { NAV } from "./navigation.ts"

export function MoreSheet({ inbox, onClose }: { inbox: number; onClose: () => void }) {
  const { t } = useI18n()
  const [root] = useState(() => createLayerRoot("more"))
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => () => root.remove(), [root])
  useEffect(
    () =>
      openLayer({
        root,
        close: () => closeRef.current(),
        initialFocus: () =>
          root.querySelector<HTMLElement>("[aria-current=page]") ?? root.querySelector<HTMLElement>("a"),
        inertOnly: () => Array.from(document.querySelectorAll<HTMLElement>(".ui-mtop, .ui-content")),
      }),
    [root],
  )

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the veil is not a control; Escape, Back and the More button close the sheet
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above
    <div
      className="ui-moresheet"
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
            onClick={() => closeRef.current()}
          >
            <page.icon aria-hidden="true" />
            <span className="ui-nav-label">{t(`nav.${page.id}`)}</span>
            {page.id === "inbox" && inbox > 0 ? <span className="ui-nav-count">{inbox}</span> : null}
          </NavLink>
        ))}
      </div>
    </div>,
    root,
  )
}
