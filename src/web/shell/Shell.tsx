// The app frame, copied from n8n-ops' shell (apps/web/src/app/shell.tsx at afba697, its default Regular design)
// and adapted to Mikud's tokens, texts and layer owner (v3 NL-1, NL-6, NL-7, NL-9). From 761px a top bar runs
// across: the brand over the sidebar's column, then in the page's card the fold toggle (above 1100px), the trail
// with the page title, the page's own actions, Quick add and the Needs attention bell. Above 1100px a 240px
// sidebar on the grey canvas that folds into the 72px icon rail, remembered in this browser; from 761 to 1100px
// always the rail. The sidebar foot holds the T3 sync card, the account menu and the theme button. Up to 760px a
// slim top bar, a bottom tab bar and a More sheet. The item dialog opens over any page.

import { useQuery } from "@tanstack/react-query"
import { ChevronRight, Ellipsis, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, NavLink, Outlet, useLocation, useSearchParams } from "react-router"
import { api, qk } from "../api/endpoints.ts"
import type { Morning, Settings } from "../api/types.ts"
import { setFormatPrefs } from "../format/datetime.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { ItemDialog } from "../pages/ItemDialog.tsx"
import { EVERY } from "../ui/refresh.ts"
import { Bell } from "./Bell.tsx"
import { ChromeContext } from "./chrome.tsx"
import { ITEM_PARAM } from "./items.ts"
import { MoreSheet } from "./MoreSheet.tsx"
import { useNavFolded } from "./navFold.ts"
import { NAV, navIdFor } from "./navigation.ts"
import { PageMetaProvider, useCurrentMeta } from "./pageMeta.tsx"
import { QuickAdd } from "./QuickAdd.tsx"
import { AccountMenu, NavToggle, SyncStatus, ThemeButton } from "./ShellTools.tsx"

/** The morning summary feeds the bell, the inbox counter and the sync card on every page (NL-19). */
export function useMorningSummary() {
  return useQuery({
    queryKey: qk.morning,
    queryFn: api.morning,
    refetchInterval: EVERY.live,
    refetchIntervalInBackground: false,
  })
}

function useAppliedSettings(): string {
  const { language, setLanguage } = useI18n()
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings, staleTime: EVERY.slow })
  const data: Settings | undefined = settings.data
  useEffect(() => {
    if (!data) return
    setFormatPrefs({ dateFormat: data.dateFormat, timeFormat: data.timeFormat })
    if (data.language !== language) setLanguage(data.language)
  }, [data, language, setLanguage])
  return data ? `${data.dateFormat}|${data.timeFormat}|${language}` : language
}

export function Shell() {
  return (
    <PageMetaProvider>
      <ShellFrame />
    </PageMetaProvider>
  )
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

function ShellFrame() {
  const { t } = useI18n()
  const formatKey = useAppliedSettings()
  const morning = useMorningSummary()
  const nav = useNavFolded()
  const [params] = useSearchParams()
  const itemId = params.get(ITEM_PARAM)
  const [quickAdd, setQuickAdd] = useState(false)
  const [more, setMore] = useState(false)
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null)
  const location = useLocation()
  const current = navIdFor(location.pathname)

  // Quick add from anywhere: N, when no field has the focus and no layer is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n" || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target))
        return
      if (document.documentElement.classList.contains("ui-layer-on")) return
      event.preventDefault()
      setQuickAdd(true)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // A page chosen in the More sheet closes it once the move is made: a move the Leave question keeps
  // (Stay) leaves the sheet open with its Back step.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page closes the More sheet
  useEffect(() => setMore(false), [location.pathname])

  const inbox = morning.data?.inboxCount ?? 0
  return (
    <ChromeContext.Provider value={{ actionsSlot }}>
      <div className="ui-shell">
        {/* The page's card is drawn behind the bar and the page, so their order for the keyboard stays as is. */}
        <div className="ui-frame" aria-hidden="true" />
        <TopBar
          nav={nav}
          morning={morning.data}
          morningFailed={morning.isError}
          setActionsSlot={setActionsSlot}
          onQuickAdd={() => setQuickAdd(true)}
        />
        <PhoneTopBar morning={morning.data} morningFailed={morning.isError} onQuickAdd={() => setQuickAdd(true)} />
        <Sidebar inbox={inbox} morning={morning.data} morningFailed={morning.isError} />
        <main className="ui-content" id="main">
          <Outlet key={formatKey} />
        </main>
        <nav className="ui-tabbar" aria-label={t("nav.main")}>
          {NAV.filter((page) => page.tab).map((page) => (
            <NavLink key={page.id} to={page.to} end={page.to === "/"} className="ui-tabbar-item">
              <page.icon aria-hidden="true" />
              <span>{t(`nav.${page.id}`)}</span>
              {page.id === "inbox" && inbox > 0 ? (
                <i className="ui-pip" title={t("nav.inboxCount", { count: inbox })} />
              ) : null}
            </NavLink>
          ))}
          <button
            type="button"
            className={`ui-tabbar-item${current && !NAV.find((page) => page.id === current)?.tab ? " is-current" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={more}
            onClick={() => setMore((open) => !open)}
          >
            <Ellipsis aria-hidden="true" />
            <span>{t("nav.more")}</span>
          </button>
        </nav>
      </div>
      {more ? <MoreSheet inbox={inbox} onClose={() => setMore(false)} /> : null}
      {quickAdd ? <QuickAdd onClose={() => setQuickAdd(false)} /> : null}
      {itemId ? <ItemDialog key={itemId} itemId={itemId} /> : null}
    </ChromeContext.Provider>
  )
}

function Sidebar({
  inbox,
  morning,
  morningFailed,
}: {
  inbox: number
  morning: Morning | undefined
  morningFailed: boolean
}) {
  const { t } = useI18n()
  return (
    <nav className="ui-sidenav" aria-label={t("nav.main")}>
      <div className="ui-nav">
        {NAV.map((page) => (
          <NavLink key={page.id} to={page.to} end={page.to === "/"} className="ui-nav-item" title={t(`nav.${page.id}`)}>
            <page.icon aria-hidden="true" />
            <span className="ui-nav-label">{t(`nav.${page.id}`)}</span>
            {page.id === "inbox" && inbox > 0 ? (
              <span className="ui-nav-count" title={t("nav.inboxCount", { count: inbox })}>
                {inbox}
              </span>
            ) : null}
          </NavLink>
        ))}
      </div>
      <div className="ui-side-foot">
        <SyncStatus morning={morning} failed={morningFailed} />
        <div className="ui-utilities">
          <AccountMenu />
          <ThemeButton />
        </div>
      </div>
    </nav>
  )
}

export function BrandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** The trail: earlier levels as links, then the page title, which is the page's one h1 from 761px. */
function Trail() {
  const { t } = useI18n()
  const meta = useCurrentMeta()
  return (
    <nav aria-label={t("nav.youAreHere")} className="ui-trail">
      <ol className="ui-crumbs">
        {meta.crumbs.map((crumb) => (
          <li key={`${crumb.label}${crumb.to ?? ""}`}>
            {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : <span>{crumb.label}</span>}
            <ChevronRight className="ui-crumb-sep" aria-hidden="true" />
          </li>
        ))}
        <li className="ui-crumb-current">
          <h1 dir="auto">
            <span aria-current="page">{meta.title}</span>
          </h1>
        </li>
      </ol>
    </nav>
  )
}

function TopBar({
  nav,
  morning,
  morningFailed,
  setActionsSlot,
  onQuickAdd,
}: {
  nav: ReturnType<typeof useNavFolded>
  morning: Morning | undefined
  morningFailed: boolean
  setActionsSlot: (element: HTMLDivElement | null) => void
  onQuickAdd: () => void
}) {
  const { t } = useI18n()
  return (
    // A subgrid of the shell: the brand above the sidebar's column, the bar above the page's.
    <header className="ui-topbar">
      <div className="ui-topbar-brand">
        <Link to="/" className="ui-bar-brand" aria-label={t("nav.homeLabel")}>
          <span className="ui-brand-mark" aria-hidden="true">
            <BrandIcon />
          </span>
        </Link>
        <span className="ui-bar-brand-text" aria-hidden="true">
          <b>{t("app.name")}</b>
          <span>{t("shell.tagline")}</span>
        </span>
      </div>
      <div className="ui-topbar-main">
        {/* Regular folds the sidebar from the start of the bar, behind a short divider; only above 1100px. */}
        <span className="ui-topbar-fold">
          <NavToggle {...nav} />
          <span className="ui-topbar-divider" aria-hidden="true" />
        </span>
        <Trail />
        {/* The page's own actions come here (PageActions), then Quick add and the bell (NL-6, NL-19). */}
        <div ref={setActionsSlot} className="ui-topbar-actions" />
        <div className="ui-topbar-end">
          <button
            type="button"
            className="ui-btn"
            onClick={onQuickAdd}
            title={t("quickAdd.shortcutHint")}
            aria-keyshortcuts="N"
          >
            <Plus aria-hidden="true" />
            {t("quickAdd.button")}
            <kbd className="ui-kbd">N</kbd>
          </button>
          <Bell morning={morning} failed={morningFailed} place="top" />
        </div>
      </div>
    </header>
  )
}

/** Phone: a slim top bar with the page name, Quick add, the bell and the account menu (NL-9, NL-19). */
function PhoneTopBar({
  morning,
  morningFailed,
  onQuickAdd,
}: {
  morning: Morning | undefined
  morningFailed: boolean
  onQuickAdd: () => void
}) {
  const { t } = useI18n()
  const meta = useCurrentMeta()
  return (
    <header className="ui-mtop">
      <Link to="/" className="ui-mtop-home ui-brand-mark" aria-label={t("nav.homeLabel")}>
        <BrandIcon />
      </Link>
      <div className="ui-mtop-titles">
        <span className="ui-mtop-app">{t("app.name")}</span>
        <span className="ui-mtop-page" dir="auto">
          {meta.title}
        </span>
      </div>
      <div className="ui-mtop-end">
        <button
          type="button"
          className="ui-icon-btn"
          aria-label={t("quickAdd.button")}
          title={t("quickAdd.button")}
          onClick={onQuickAdd}
        >
          <Plus aria-hidden="true" />
        </button>
        <Bell morning={morning} failed={morningFailed} place="phone" />
        <AccountMenu compact />
      </div>
    </header>
  )
}
