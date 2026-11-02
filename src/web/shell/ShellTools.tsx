// The shell's own tools (v3 NL-7, NL-9; copied from n8n-ops shell.tsx in its Regular design): the toggle that
// folds the sidebar, the theme button, the account menu with the theme and sign-out, and the status card of
// the last T3 sync. The theme lives only here: light, dark or the system's, kept in this browser.

import { useQuery } from "@tanstack/react-query"
import { LogOut, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Settings, ShieldCheck, Sun } from "lucide-react"
import { useRef, useState } from "react"
import { Link, useNavigate } from "react-router"
import { api, qk } from "../api/endpoints.ts"
import type { Morning } from "../api/types.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { Menu } from "../ui/Menu.tsx"
import { Time } from "../ui/Time.tsx"
import { isMac } from "./navFold.ts"
import { useSignOut } from "./signOut.ts"
import { THEMES, type Theme, useTheme } from "./theme.ts"

/** The order the theme button walks through, as n8n-ops does: the system's, then light, then dark. */
export const THEME_CYCLE: readonly Theme[] = ["system", "light", "dark"]
export const nextTheme = (theme: Theme): Theme =>
  THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length] ?? "system"

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const

export function NavToggle({ folded, toggle }: { folded: boolean; toggle: () => void }) {
  const { t } = useI18n()
  const label = folded ? t("shell.expandMenu") : t("shell.collapseMenu")
  return (
    <button
      type="button"
      className="ui-icon-btn ui-nav-toggle"
      aria-label={label}
      aria-expanded={!folded}
      aria-keyshortcuts={isMac() ? "Meta+B" : "Control+B"}
      title={`${label} (${isMac() ? "⌘B" : "Ctrl+B"})`}
      onClick={toggle}
    >
      {folded ? (
        <PanelLeftOpen className="ui-flip-rtl" aria-hidden="true" />
      ) : (
        <PanelLeftClose className="ui-flip-rtl" aria-hidden="true" />
      )}
    </button>
  )
}

/** Walks through the system's theme, light and dark; the name says the current one and the next. */
export function ThemeButton() {
  const { t } = useI18n()
  const [theme, setTheme] = useTheme()
  const next = nextTheme(theme)
  const Icon = THEME_ICON[theme]
  const label = t("shell.themeButton", { theme: t(`theme.${theme}`), next: t(`theme.${next}`) })
  return (
    <button
      type="button"
      className="ui-icon-btn"
      aria-label={label}
      title={label}
      data-theme-button=""
      onClick={() => setTheme(next)}
    >
      <Icon aria-hidden="true" />
    </button>
  )
}

/** The account: its name, the theme, the Account settings and Sign out (R3: unsaved changes asked first). */
export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const me = useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: Number.POSITIVE_INFINITY })
  const name = me.data?.actor.label ?? ""
  const [theme, setTheme] = useTheme()
  const signOut = useSignOut()
  const menuName = t("shell.accountMenu")
  return (
    <>
      <button
        ref={button}
        type="button"
        className={compact ? "ui-account-btn is-compact" : "ui-account-btn"}
        // The name holds the words it shows, so a voice command that says them reaches it.
        aria-label={[name, menuName].filter(Boolean).join(", ")}
        title={menuName}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ui-avatar" aria-hidden="true">
          {name.slice(0, 2).toUpperCase()}
        </span>
        {compact ? null : (
          <span className="ui-account-text" aria-hidden="true">
            <bdi className="ui-account-name">{name}</bdi>
            <span className="ui-account-sub">{t("shell.account")}</span>
          </span>
        )}
      </button>
      {open ? (
        <Menu
          anchor={button}
          label={menuName}
          side={compact ? "bottom" : "top"}
          align={compact ? "end" : "start"}
          onClose={() => setOpen(false)}
          entries={[
            {
              kind: "header",
              content: (
                <>
                  <bdi className="ui-account-head-name">{name}</bdi>
                  <span className="ui-account-head-sub">
                    <ShieldCheck aria-hidden="true" />
                    {t("shell.twoFactorOn")}
                  </span>
                </>
              ),
            },
            { kind: "separator" },
            {
              kind: "radios",
              label: t("shell.theme"),
              options: THEMES.map((option) => {
                const Icon = THEME_ICON[option]
                return {
                  label: t(`theme.${option}`),
                  icon: <Icon aria-hidden="true" />,
                  checked: theme === option,
                  onSelect: () => setTheme(option),
                }
              }),
            },
            { kind: "separator" },
            {
              kind: "item",
              label: t("shell.accountSettings"),
              icon: <Settings aria-hidden="true" />,
              onSelect: () => navigate("/settings"),
            },
            {
              kind: "item",
              label: t("account.signOut"),
              icon: <LogOut aria-hidden="true" />,
              onSelect: () => void signOut(),
            },
          ]}
        />
      ) : null}
    </>
  )
}

/** The last complete T3 sync, in words and in its tone; it opens Settings, where the sync's status is. */
export function SyncStatus({ morning, failed }: { morning: Morning | undefined; failed: boolean }) {
  const { t } = useI18n()
  const sync = morning?.sync
  const tone = !sync?.lastSuccessAt ? "none" : sync.stale ? "warn" : "ok"
  return (
    <Link to="/settings" className="ui-status-card" title={t("sync.title")} data-sync-tone={tone}>
      <span className="ui-status-dot" aria-hidden="true" />
      <span className="ui-status-text">
        <b>{t("shell.syncCard")}</b>
        <span className={tone === "warn" ? "ui-text-warn" : undefined}>
          {!sync ? (
            failed ? (
              t("shell.syncUnknown")
            ) : (
              "-"
            )
          ) : sync.lastSuccessAt ? (
            <>
              {sync.stale ? `${t("shell.syncStale")} · ` : null}
              {t("sync.last")} <Time value={sync.lastSuccessAt} mode="list" />
            </>
          ) : (
            t("sync.never")
          )}
        </span>
      </span>
    </Link>
  )
}
