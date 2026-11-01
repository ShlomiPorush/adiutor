// Settings: language, date and time format, closed-item days and the session clocks (saved with the save
// bar), the account (signed-in browsers, password, sign out), the theme of this browser (applies at once),
// suppressions, and the sync and Telegram status.

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, type ReactNode, useId, useState } from "react"
import { useNavigate } from "react-router"
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordSchema,
  SESSION_IDLE_MINUTES_MAX,
  SESSION_IDLE_MINUTES_MIN,
  SESSION_MAX_DAYS_MAX,
  SESSION_MAX_DAYS_MIN,
} from "../../shared/auth.ts"
import { LANGUAGES } from "../../shared/enums.ts"
import { authClient } from "../api/auth.ts"
import { ApiError } from "../api/client.ts"
import { api, qk } from "../api/endpoints.ts"
import type { DateFormat, Settings, SettingsPatch, TimeFormat } from "../api/types.ts"
import {
  APP_TIME_ZONE,
  DATE_FORMATS,
  formatTime,
  isDateFormat,
  isTimeFormat,
  setFormatPrefs,
  TIME_FORMATS,
  withFormatPrefs,
} from "../format/datetime.ts"
import { type Language, useI18n } from "../i18n/i18n.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { THEMES, useTheme } from "../shell/theme.ts"
import { Copyable } from "../ui/Copyable.tsx"
import { confirmDialog } from "../ui/confirm.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { SaveBar } from "../ui/SaveBar.tsx"
import { Empty, ErrorState, errorReason, Loading, Locked } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Tag } from "../ui/tags.tsx"
import { useClearUnsaved, useUnsaved } from "../ui/unsaved.tsx"
import { describeAgent } from "./agent.ts"
import { RECOVERY_COMMAND } from "./auth/LoginPage.tsx"
import { FormError, PasswordField } from "./auth/parts.tsx"
import { Panel } from "./parts.tsx"

export const CLOSED_DAYS_MIN = 1
export const CLOSED_DAYS_MAX = 365

type Draft = {
  language?: Language
  dateFormat?: DateFormat
  timeFormat?: TimeFormat
  closedItemDays?: string
  sessionMaxDays?: string
  sessionIdle?: boolean
  sessionIdleMinutes?: string
}

export function changedFields(saved: Settings, draft: Draft): SettingsPatch {
  const patch: SettingsPatch = {}
  if (draft.language !== undefined && draft.language !== saved.language) patch.language = draft.language
  if (draft.dateFormat !== undefined && draft.dateFormat !== saved.dateFormat) patch.dateFormat = draft.dateFormat
  if (draft.timeFormat !== undefined && draft.timeFormat !== saved.timeFormat) patch.timeFormat = draft.timeFormat
  if (draft.closedItemDays !== undefined && draft.closedItemDays.trim() !== String(saved.closedItemDays)) {
    patch.closedItemDays = Number(draft.closedItemDays.trim())
  }
  if (draft.sessionMaxDays !== undefined && draft.sessionMaxDays.trim() !== String(saved.sessionMaxDays))
    patch.sessionMaxDays = Number(draft.sessionMaxDays.trim())
  if (draft.sessionIdle !== undefined && draft.sessionIdle !== saved.sessionIdle) patch.sessionIdle = draft.sessionIdle
  if (draft.sessionIdleMinutes !== undefined && draft.sessionIdleMinutes.trim() !== String(saved.sessionIdleMinutes))
    patch.sessionIdleMinutes = Number(draft.sessionIdleMinutes.trim())
  return patch
}

export function SettingsPage() {
  const { t } = useI18n()
  usePageMeta(t("settings.title"))
  const query = usePageQuery({ queryKey: qk.settings, queryFn: api.settings, every: EVERY.slow })
  return (
    <div className="ui-page">
      <div className="ui-page-narrow ui-section ui-page-has-savebar">
        <div className="ui-page-head">
          <div>
            <h1 className="ui-h1">{t("settings.title")}</h1>
            <p>{t("settings.description")}</p>
          </div>
        </div>
        {query.isPending ? <Loading label={t("settings.loading")} /> : null}
        {query.isError && !query.data ? (
          <ErrorState title={t("settings.failed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {query.data ? <GeneralSettings saved={query.data} /> : null}
        <AccountPanel />
        <AppearancePanel />
        <SuppressionsPanel />
        <StatusPanel />
      </div>
    </div>
  )
}

function Row({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string
  hint: string
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

function GeneralSettings({ saved }: { saved: Settings }) {
  const { t, language, setLanguage } = useI18n()
  const queryClient = useQueryClient()
  const daysId = useId()
  const dateId = useId()
  const errorId = useId()
  const maxDaysId = useId()
  const idleMinutesId = useId()
  const sessionErrorId = useId()
  const [draft, setDraft] = useState<Draft>({})
  const [busy, setBusy] = useState(false)
  const [daysError, setDaysError] = useState<string | null>(null)
  const [sessionError, setSessionError] = useState<{ field: "max" | "idle"; text: string } | null>(null)
  const patch = changedFields(saved, draft)
  const count = Object.keys(patch).length
  useUnsaved("settings", { count, kind: "leave" })

  const current = {
    language: draft.language ?? saved.language,
    dateFormat: draft.dateFormat ?? saved.dateFormat,
    timeFormat: draft.timeFormat ?? saved.timeFormat,
    closedItemDays: draft.closedItemDays ?? String(saved.closedItemDays),
    sessionMaxDays: draft.sessionMaxDays ?? String(saved.sessionMaxDays),
    sessionIdle: draft.sessionIdle ?? saved.sessionIdle,
    sessionIdleMinutes: draft.sessionIdleMinutes ?? String(saved.sessionIdleMinutes),
  }
  const example = withFormatPrefs({ dateFormat: current.dateFormat, timeFormat: current.timeFormat }, () =>
    formatTime(new Date(), { seconds: false }),
  )

  const save = async () => {
    if (patch.closedItemDays !== undefined) {
      const days = patch.closedItemDays
      if (!Number.isInteger(days) || days < CLOSED_DAYS_MIN || days > CLOSED_DAYS_MAX) {
        const message = t("settings.daysInvalid", { min: CLOSED_DAYS_MIN, max: CLOSED_DAYS_MAX })
        setDaysError(message)
        showToast(`${t("settings.closedDays")}: ${message}`, "error")
        document.getElementById(daysId)?.focus()
        return
      }
    }
    setDaysError(null)
    const outside = (value: number | undefined, min: number, max: number) =>
      value !== undefined && (!Number.isInteger(value) || value < min || value > max)
    const invalidSession = outside(patch.sessionMaxDays, SESSION_MAX_DAYS_MIN, SESSION_MAX_DAYS_MAX)
      ? ({
          field: "max",
          min: SESSION_MAX_DAYS_MIN,
          max: SESSION_MAX_DAYS_MAX,
          id: maxDaysId,
          label: "maxDays",
        } as const)
      : outside(patch.sessionIdleMinutes, SESSION_IDLE_MINUTES_MIN, SESSION_IDLE_MINUTES_MAX)
        ? ({
            field: "idle",
            min: SESSION_IDLE_MINUTES_MIN,
            max: SESSION_IDLE_MINUTES_MAX,
            id: idleMinutesId,
            label: "idleMinutes",
          } as const)
        : null
    if (invalidSession) {
      const message = t("settings.session.daysInvalid", { min: invalidSession.min, max: invalidSession.max })
      setSessionError({ field: invalidSession.field, text: message })
      showToast(`${t(`settings.session.${invalidSession.label}`)}: ${message}`, "error")
      document.getElementById(invalidSession.id)?.focus()
      return
    }
    setSessionError(null)
    setBusy(true)
    try {
      const next = await api.updateSettings(patch)
      queryClient.setQueryData(qk.settings, next)
      setFormatPrefs({ dateFormat: next.dateFormat, timeFormat: next.timeFormat })
      if (next.language !== language) setLanguage(next.language)
      setDraft({})
      await queryClient.invalidateQueries({ queryKey: qk.morning })
      showToast(t("settings.saved"), "success")
    } catch (error) {
      if (error instanceof ApiError && error.code === "validation_failed")
        showToast(t("settings.saveInvalid", { reason: errorReason(language, error) }), "error")
      else showToast(t("settings.saveFailed", { reason: errorReason(language, error) }), "error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel id="general" title={t("settings.general")}>
      <Row label={t("settings.language")} hint={t("settings.languageHint")}>
        <fieldset className="ui-seg ui-plain-fieldset">
          <legend className="ui-sr-only">{t("settings.language")}</legend>
          {LANGUAGES.map((code) => (
            <button
              key={code}
              type="button"
              lang={code}
              aria-pressed={current.language === code}
              onClick={() => setDraft((d) => ({ ...d, language: code as Language }))}
            >
              {new Intl.DisplayNames([code], { type: "language" }).of(code)}
            </button>
          ))}
        </fieldset>
      </Row>
      <Row label={t("settings.dateFormat")} hint={t("settings.dateFormatHint")} htmlFor={dateId}>
        <select
          id={dateId}
          className="ui-select"
          value={current.dateFormat}
          onChange={(event) => setDraft((d) => ({ ...d, dateFormat: event.target.value as DateFormat }))}
        >
          {isDateFormat(current.dateFormat) ? null : <option value={current.dateFormat}>{current.dateFormat}</option>}
          {DATE_FORMATS.map((format) => (
            <option key={format} value={format}>
              {format === "browser" ? t("settings.dateBrowser") : format.toUpperCase()}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t("settings.timeFormat")} hint={t("settings.timeFormatHint")}>
        <fieldset className="ui-seg ui-plain-fieldset">
          <legend className="ui-sr-only">{t("settings.timeFormat")}</legend>
          {TIME_FORMATS.map((format) => (
            <button
              key={format}
              type="button"
              aria-pressed={current.timeFormat === format || (format === "HH:mm" && !isTimeFormat(current.timeFormat))}
              onClick={() => setDraft((d) => ({ ...d, timeFormat: format }))}
            >
              {t(`settings.timeFormats.${format === "HH:mm" ? "h24" : format === "h:mm a" ? "h12" : "browser"}`)}
            </button>
          ))}
        </fieldset>
        <span className="ui-hint ui-num" aria-live="polite">
          {t("settings.example", { example })}
        </span>
      </Row>
      <Row label={t("settings.timeZone")} hint={t("settings.timeZoneHint")}>
        <span className="ui-mono">{APP_TIME_ZONE}</span>
      </Row>
      <Row label={t("settings.closedDays")} hint={t("settings.closedDaysHint")} htmlFor={daysId}>
        <input
          id={daysId}
          className="ui-input ui-input-num"
          type="number"
          inputMode="numeric"
          min={CLOSED_DAYS_MIN}
          max={CLOSED_DAYS_MAX}
          value={current.closedItemDays}
          aria-invalid={daysError ? true : undefined}
          aria-describedby={daysError ? errorId : undefined}
          onChange={(event) => setDraft((d) => ({ ...d, closedItemDays: event.target.value }))}
        />
        {daysError ? (
          <p id={errorId} className="ui-field-error">
            {daysError}
          </p>
        ) : null}
      </Row>
      <Row label={t("settings.session.maxDays")} hint={t("settings.session.maxDaysHint")} htmlFor={maxDaysId}>
        <input
          id={maxDaysId}
          className="ui-input ui-input-num"
          type="number"
          inputMode="numeric"
          min={SESSION_MAX_DAYS_MIN}
          max={SESSION_MAX_DAYS_MAX}
          value={current.sessionMaxDays}
          aria-invalid={sessionError?.field === "max" ? true : undefined}
          aria-describedby={sessionError?.field === "max" ? sessionErrorId : undefined}
          onChange={(event) => setDraft((d) => ({ ...d, sessionMaxDays: event.target.value }))}
        />
        {sessionError?.field === "max" ? (
          <p id={sessionErrorId} className="ui-field-error">
            {sessionError.text}
          </p>
        ) : null}
      </Row>
      <Row label={t("settings.session.idle")} hint={t("settings.session.idleHint")}>
        <fieldset className="ui-seg ui-plain-fieldset">
          <legend className="ui-sr-only">{t("settings.session.idle")}</legend>
          {([false, true] as const).map((on) => (
            <button
              key={String(on)}
              type="button"
              aria-pressed={current.sessionIdle === on}
              onClick={() => setDraft((d) => ({ ...d, sessionIdle: on }))}
            >
              {on ? t("settings.session.idleOn") : t("settings.session.idleOff")}
            </button>
          ))}
        </fieldset>
        {current.sessionIdle ? (
          <span className="ui-field">
            <label className="ui-label" htmlFor={idleMinutesId}>
              {t("settings.session.idleMinutes")}
            </label>
            <input
              id={idleMinutesId}
              className="ui-input ui-input-num"
              type="number"
              inputMode="numeric"
              min={SESSION_IDLE_MINUTES_MIN}
              max={SESSION_IDLE_MINUTES_MAX}
              value={current.sessionIdleMinutes}
              aria-invalid={sessionError?.field === "idle" ? true : undefined}
              aria-describedby={sessionError?.field === "idle" ? sessionErrorId : undefined}
              onChange={(event) => setDraft((d) => ({ ...d, sessionIdleMinutes: event.target.value }))}
            />
            {sessionError?.field === "idle" ? (
              <span id={sessionErrorId} className="ui-field-error">
                {sessionError.text}
              </span>
            ) : null}
          </span>
        ) : null}
      </Row>
      <SaveBar
        count={count}
        busy={busy}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft({})
          setDaysError(null)
          setSessionError(null)
        }}
      />
    </Panel>
  )
}

function AppearancePanel() {
  const { t } = useI18n()
  const [theme, setTheme] = useTheme()
  return (
    <Panel id="appearance" title={t("settings.appearance")}>
      <Row label={t("settings.theme")} hint={t("settings.themeHint")}>
        <fieldset className="ui-seg ui-plain-fieldset">
          <legend className="ui-sr-only">{t("settings.theme")}</legend>
          {THEMES.map((option) => (
            <button key={option} type="button" aria-pressed={theme === option} onClick={() => setTheme(option)}>
              {t(`theme.${option}`)}
            </button>
          ))}
        </fieldset>
      </Row>
    </Panel>
  )
}

/** Leaves for sign-in after this browser's session ended on purpose; nothing asks about unsaved changes. */
function useSignedOut() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const clearUnsaved = useClearUnsaved()
  return () => {
    clearUnsaved()
    queryClient.clear()
    navigate("/login", { replace: true })
  }
}

function AccountPanel() {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const signedOut = useSignedOut()
  const query = usePageQuery({ queryKey: qk.account, queryFn: api.account, every: EVERY.slow })
  const [signingOut, setSigningOut] = useState(false)
  const sessions = query.data?.sessions ?? []

  const signOut = async () => {
    setSigningOut(true)
    try {
      const { error } = await authClient.signOut()
      if (error?.status) throw new ApiError(error.status, "unknown", error.message ?? null)
      signedOut()
    } catch (error) {
      setSigningOut(false)
      showToast(t("account.signOutFailed", { reason: errorReason(language, error) }), "error")
    }
  }
  const endOthers = async () => {
    const ok = await confirmDialog({
      title: t("account.endOthersTitle"),
      message: t("account.endOthersMessage"),
      confirmText: t("account.endOthers"),
      danger: true,
    })
    if (!ok) return
    try {
      await api.endOtherSessions()
      showToast(t("account.endOthersDone"), "success")
      await queryClient.invalidateQueries({ queryKey: qk.account })
    } catch (error) {
      showToast(t("account.endFailed", { reason: errorReason(language, error) }), "error")
    }
  }
  const endAll = async () => {
    const ok = await confirmDialog({
      title: t("account.endAllTitle"),
      message: t("account.endAllMessage"),
      confirmText: t("account.endAll"),
      danger: true,
    })
    if (!ok) return
    try {
      await api.endAllSessions()
      signedOut()
    } catch (error) {
      showToast(t("account.endFailed", { reason: errorReason(language, error) }), "error")
    }
  }

  return (
    <Panel
      id="account"
      title={t("account.title")}
      extra={
        <button type="button" className="ui-more" disabled={signingOut} onClick={() => void signOut()}>
          {t("account.signOut")}
        </button>
      }
    >
      {query.isPending ? <Loading label={t("account.loading")} /> : null}
      {query.isError && !query.data ? (
        <ErrorState title={t("account.failed")} error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.data ? (
        <>
          <div className="ui-kv">
            <span>{t("account.signedInAs")}</span>
            <bdi className="ui-mono" dir="ltr">
              {query.data.username}
            </bdi>
          </div>
          <div className="ui-panel-body">
            <h3 className="ui-h3">{t("account.sessions")}</h3>
            <p className="ui-hint">{t("account.sessionsHint")}</p>
          </div>
          {sessions.map((session) => {
            const agent = describeAgent(session.userAgent)
            return (
              <div key={session.id} className="ui-item">
                <div className="ui-item-main">
                  <span className="ui-item-title">
                    <bdi dir="auto">{agent ? t("account.browserOn", agent) : t("account.unknownBrowser")}</bdi>{" "}
                    {session.current ? <Tag tone="info">{t("account.thisBrowser")}</Tag> : null}
                  </span>
                  <span className="ui-item-meta">
                    {t("account.signedIn")} <Time value={session.signedInAt} mode="full" /> · {t("account.lastActive")}{" "}
                    <Time value={session.activeAt} mode="ago" />
                  </span>
                </div>
              </div>
            )
          })}
          <div className="ui-panel-body ui-account-actions">
            {sessions.length > 1 ? (
              <button type="button" className="ui-btn ui-btn-danger" onClick={() => void endOthers()}>
                {t("account.endOthers")}
              </button>
            ) : null}
            <button type="button" className="ui-btn ui-btn-danger" onClick={() => void endAll()}>
              {t("account.endAll")}
            </button>
          </div>
          <PasswordForm />
          <div className="ui-panel-body ui-auth-note">
            <h3 className="ui-h3">{t("account.recovery")}</h3>
            <p className="ui-hint">{t("account.recoveryHint")}</p>
            <Copyable value={RECOVERY_COMMAND} />
          </div>
        </>
      ) : null}
    </Panel>
  )
}

/** Change password: the current one, the new one twice. Other browsers are signed out; this one stays. */
function PasswordForm() {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [repeat, setRepeat] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: "current" | "next" | "repeat" | null; text: string } | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!current) return setError({ field: "current", text: t("account.wrongCurrent") })
    if (!passwordSchema.safeParse(next).success)
      return setError({
        field: "next",
        text:
          next.length > PASSWORD_MAX
            ? t("auth.error.passwordLong", { max: PASSWORD_MAX })
            : t("auth.error.passwordShort", { min: PASSWORD_MIN }),
      })
    if (next !== repeat) return setError({ field: "repeat", text: t("auth.error.mismatch") })
    setBusy(true)
    setError(null)
    try {
      await api.changePassword(current, next)
      setCurrent("")
      setNext("")
      setRepeat("")
      showToast(t("account.changed"), "success")
      await queryClient.invalidateQueries({ queryKey: qk.account })
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "wrong_password") {
        setCurrent("")
        setError({ field: "current", text: t("account.wrongCurrent") })
      } else if (failure instanceof ApiError && failure.code === "rate_limited")
        setError({ field: null, text: t("auth.error.rateLimited") })
      else setError({ field: null, text: t("account.changeFailed", { reason: errorReason(language, failure) }) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ui-panel-body ui-account-form" onSubmit={submit} noValidate>
      <div>
        <h3 className="ui-h3">{t("account.password")}</h3>
        <p className="ui-hint">{t("account.passwordHint")}</p>
      </div>
      <PasswordField
        label={t("account.currentPassword")}
        value={current}
        onChange={setCurrent}
        autoComplete="current-password"
        invalid={error?.field === "current"}
      />
      <PasswordField
        label={t("account.newPassword")}
        hint={t("auth.passwordHint", { min: PASSWORD_MIN })}
        value={next}
        onChange={setNext}
        autoComplete="new-password"
        invalid={error?.field === "next"}
      />
      <PasswordField
        label={t("account.repeatNewPassword")}
        value={repeat}
        onChange={setRepeat}
        autoComplete="new-password"
        invalid={error?.field === "repeat"}
      />
      {error ? <FormError>{error.text}</FormError> : null}
      <button type="submit" className="ui-btn" disabled={busy}>
        {busy ? t("account.changing") : t("account.change")}
      </button>
    </form>
  )
}

function SuppressionsPanel() {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const query = usePageQuery({ queryKey: qk.suppressions, queryFn: api.suppressions, every: EVERY.slow })
  const list = query.data ?? []
  const remove = async (id: string, label: string) => {
    const ok = await confirmDialog({
      title: t("suppressions.removeTitle", { label }),
      message: t("suppressions.removeMessage"),
      confirmText: t("suppressions.remove"),
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteSuppression(id)
      showToast(t("suppressions.removed", { label }), "success")
      await queryClient.invalidateQueries({ queryKey: qk.suppressions })
    } catch (error) {
      showToast(t("suppressions.removeFailed", { label, reason: errorReason(language, error) }), "error")
    }
  }
  return (
    <Panel id="suppressions" title={t("suppressions.title")} count={query.data ? list.length : undefined}>
      <p className="ui-panel-body ui-hint">{t("suppressions.hint")}</p>
      {query.isPending ? <Loading label={t("suppressions.loading")} /> : null}
      {query.isError && !query.data ? (
        <ErrorState title={t("suppressions.failed")} error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.data && list.length === 0 ? (
        <Empty title={t("suppressions.empty")} hint={t("suppressions.emptyHint")} />
      ) : null}
      {list.map((entry) => {
        const label = entry.label ?? entry.externalId
        return (
          <div key={entry.id} className="ui-item">
            <div className="ui-item-main">
              <span className="ui-item-title">
                <bdi dir="auto">{label}</bdi>
              </span>
              <span className="ui-item-meta">
                <Tag tone="neutral" line>
                  {t(`suppressions.kind.${entry.kind}`)}
                </Tag>
                <Copyable value={entry.externalId} />
                <span>
                  {t("suppressions.since")} <Time value={entry.createdAt} />
                </span>
              </span>
            </div>
            <div className="ui-item-end">
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-danger"
                onClick={() => void remove(entry.id, label)}
              >
                {t("suppressions.remove")}
              </button>
            </div>
          </div>
        )
      })}
    </Panel>
  )
}

const OUTCOME_TONE = { succeeded: "ok", partial: "warn", failed: "fail" } as const
const JOB_TONE = { sent: "ok", sending: "info", failed: "fail", unknown: "warn", skipped: "warn" } as const

function StatusPanel() {
  const { t, language } = useI18n()
  const [sendingTest, setSendingTest] = useState(false)
  const sendTest = async () => {
    setSendingTest(true)
    try {
      const result = await api.telegramTestMessage()
      if (result.warning) showToast(t("settings.telegramTestSentUnrecorded"), "warning")
      else showToast(t("settings.telegramTestSent"), "success")
    } catch (error) {
      if (error instanceof ApiError && error.code === "telegram_uncertain")
        showToast(t("settings.telegramTestUncertain"), "warning")
      else if (error instanceof ApiError && error.code === "telegram_failed")
        showToast(t("settings.telegramTestRefused"), "error")
      else showToast(t("settings.telegramTestFailed", { reason: errorReason(language, error) }), "error")
    } finally {
      setSendingTest(false)
    }
  }
  const morning = useQuery({ queryKey: qk.morning, queryFn: api.morning, staleTime: EVERY.live })
  const runs = usePageQuery({ queryKey: qk.syncRuns, queryFn: api.syncRuns, every: EVERY.slow })
  const telegram = usePageQuery({ queryKey: qk.telegram, queryFn: api.telegramStatus, every: EVERY.slow })
  const sync = morning.data?.sync
  const lastT3 = runs.data?.find((run) => run.kind === "t3" && run.outcome)
  return (
    <Panel id="status" title={t("settings.status")}>
      <p className="ui-panel-body ui-hint">{t("settings.statusHint")}</p>
      <div className="ui-kv">
        <span>{t("settings.lastSync")}</span>
        <span>
          {sync?.lastSuccessAt ? <Time value={sync.lastSuccessAt} mode="full" /> : sync ? t("sync.never") : "-"}{" "}
          {sync?.stale ? <Tag tone="warn">{t("security.stale")}</Tag> : null}
        </span>
      </div>
      <div className="ui-kv">
        <span>{t("settings.lastOutcome")}</span>
        <span>
          {lastT3?.outcome ? (
            <>
              <Tag tone={OUTCOME_TONE[lastT3.outcome]}>{t(`settings.outcome.${lastT3.outcome}`)}</Tag>{" "}
              <Time value={lastT3.finishedAt ?? lastT3.startedAt} />
            </>
          ) : (
            "-"
          )}
        </span>
      </div>
      <div className="ui-kv">
        <span>{t("settings.securityAsOf")}</span>
        <span>
          {sync?.securityLastSuccessAt ? (
            <Time value={sync.securityLastSuccessAt} mode="full" />
          ) : (
            t("security.asOfUnknown")
          )}
        </span>
      </div>
      {telegram.isError && !telegram.data ? (
        <div className="ui-panel-body">
          <ErrorState
            title={t("settings.telegramFailed")}
            error={telegram.error}
            onRetry={() => void telegram.refetch()}
          />
        </div>
      ) : telegram.data?.configured ? (
        <>
          <div className="ui-kv">
            <span>{t("settings.bot")}</span>
            <span>
              <Tag tone={telegram.data.polling ? "ok" : "warn"}>
                {telegram.data.polling ? t("settings.botPolling") : t("settings.botNotPolling")}
              </Tag>
            </span>
          </div>
          <div className="ui-kv">
            <span>{t("settings.lastUpdate")}</span>
            <span>
              {telegram.data.lastUpdateAt ? (
                <Time value={telegram.data.lastUpdateAt} mode="full" />
              ) : (
                t("settings.noUpdateYet")
              )}
            </span>
          </div>
          <div className="ui-kv">
            <span>{t("settings.lastMorning")}</span>
            <span>
              {telegram.data.lastMorning ? (
                <>
                  <Time value={telegram.data.lastMorning.at ?? telegram.data.lastMorning.localDate} mode="day" />{" "}
                  <Tag tone={JOB_TONE[telegram.data.lastMorning.state]}>
                    {t(`settings.job.${telegram.data.lastMorning.state}`)}
                  </Tag>
                </>
              ) : (
                t("settings.noMorningYet")
              )}
            </span>
          </div>
          <div className="ui-panel-body">
            <p className="ui-hint">{t("settings.telegramTestHint")}</p>
            <button type="button" className="ui-btn" disabled={sendingTest} onClick={() => void sendTest()}>
              {sendingTest ? t("settings.telegramTestSending") : t("settings.telegramTest")}
            </button>
          </div>
        </>
      ) : telegram.data ? (
        <div className="ui-panel-body">
          <Locked title={t("settings.telegramLocked")}>{t("settings.telegramLockedBody")}</Locked>
        </div>
      ) : null}
    </Panel>
  )
}
