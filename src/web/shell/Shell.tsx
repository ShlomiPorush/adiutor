// The app frame (v3 NL-1, NL-6, NL-7, NL-9): above 1100px a 240px sidebar, from 761 to 1100px a 72px
// icon rail, up to 760px a slim top bar, a bottom tab bar and a More sheet. The top bar holds the
// crumbs, Quick add and the Needs attention bell on every page. The item dialog opens over any page.

import { useQuery } from "@tanstack/react-query"
import { ChevronRight, CircleDot, Ellipsis, Moon, Plus, RefreshCw, Sun } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Link, NavLink, Outlet, useLocation, useSearchParams } from "react-router"
import { api, qk } from "../api/endpoints.ts"
import type { Morning, Settings } from "../api/types.ts"
import { setFormatPrefs } from "../format/datetime.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { ItemDialog } from "../pages/ItemDialog.tsx"
import { EVERY } from "../ui/refresh.ts"
import { Time } from "../ui/Time.tsx"
import { Bell } from "./Bell.tsx"
import { ITEM_PARAM } from "./items.ts"
import { MoreSheet } from "./MoreSheet.tsx"
import { NAV, navIdFor } from "./navigation.ts"
import { PageMetaProvider, useCurrentMeta } from "./pageMeta.tsx"
import { QuickAdd } from "./QuickAdd.tsx"
import { useTheme } from "./theme.ts"

/** The morning summary feeds the bell, the inbox counter and the sync line on every page (NL-19). */
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
  const [params] = useSearchParams()
  const itemId = params.get(ITEM_PARAM)
  const [quickAdd, setQuickAdd] = useState(false)
  const [more, setMore] = useState(false)
  const moreButton = useRef<HTMLButtonElement>(null)
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page closes the More sheet
  useEffect(() => setMore(false), [location.pathname])

  const inbox = morning.data?.inboxCount ?? 0
  return (
    <div className="ui-shell">
      <Sidebar inbox={inbox} morning={morning.data} />
      <div className="ui-main">
        <TopBar morning={morning.data} morningFailed={morning.isError} onQuickAdd={() => setQuickAdd(true)} />
        <PhoneTopBar morning={morning.data} morningFailed={morning.isError} onQuickAdd={() => setQuickAdd(true)} />
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
            ref={moreButton}
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
    </div>
  )
}

function SyncLine({ morning }: { morning: Morning | undefined }) {
  const { t } = useI18n()
  if (!morning) return null
  const { lastSuccessAt, stale } = morning.sync
  return (
    <div className={stale ? "ui-side-sync is-stale" : "ui-side-sync"} title={t("sync.title")}>
      {stale ? <CircleDot aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
      <span>
        {lastSuccessAt ? (
          <>
            {t("sync.last")} <Time value={lastSuccessAt} mode="list" />
          </>
        ) : (
          t("sync.never")
        )}
      </span>
    </div>
  )
}

function ThemeButton() {
  const { t } = useI18n()
  const [, setTheme, dark] = useTheme()
  const label = dark ? t("theme.toLight") : t("theme.toDark")
  return (
    <button
      type="button"
      className="ui-icon-btn"
      aria-label={label}
      title={label}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </button>
  )
}

function Sidebar({ inbox, morning }: { inbox: number; morning: Morning | undefined }) {
  const { t } = useI18n()
  return (
    <nav className="ui-sidenav" aria-label={t("nav.main")}>
      <Link to="/" className="ui-brand" aria-label={t("nav.homeLabel")}>
        <span className="ui-brand-mark" aria-hidden="true">
          <BrandIcon />
        </span>
        <span className="ui-brand-name">{t("app.name")}</span>
      </Link>
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
        <SyncLine morning={morning} />
        <div className="ui-utilities">
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

function Crumbs() {
  const { t } = useI18n()
  const meta = useCurrentMeta()
  return (
    <nav aria-label={t("nav.youAreHere")}>
      <ol className="ui-crumbs">
        {meta.crumbs.map((crumb) => (
          <li key={`${crumb.label}${crumb.to ?? ""}`}>
            {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : <span>{crumb.label}</span>}
            <ChevronRight className="ui-crumb-sep" aria-hidden="true" />
          </li>
        ))}
        <li>
          <span aria-current="page">{meta.title}</span>
        </li>
      </ol>
    </nav>
  )
}

function TopBar({
  morning,
  morningFailed,
  onQuickAdd,
}: {
  morning: Morning | undefined
  morningFailed: boolean
  onQuickAdd: () => void
}) {
  const { t } = useI18n()
  return (
    <header className="ui-topbar">
      <Crumbs />
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
    </header>
  )
}

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
        <span className="ui-mtop-page">{meta.title}</span>
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
        <ThemeButton />
      </div>
    </header>
  )
}
