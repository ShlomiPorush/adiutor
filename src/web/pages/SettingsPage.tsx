// Settings, in this order: General (language, formats, closed-item days, how long a browser stays signed in),
// Account (Better Auth's routes, acting at once), Telegram (the bot token, the chat, sign-in codes), Agent access
// (agent keys, acting at once), Secret check (private domains), Appearance, Suppressions and Status. General,
// Telegram and Secret check share one save bar. A setting the environment sets is locked and names its variable.

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { type FormEvent, useId, useState } from "react"
import { SESSION_IDLE_DAYS_MAX, SESSION_IDLE_DAYS_MIN } from "../../shared/auth.ts"
import { LANGUAGES } from "../../shared/enums.ts"
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
import { Empty, ErrorState, errorReason, Loading } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Tag } from "../ui/tags.tsx"
import { useUnsaved } from "../ui/unsaved.tsx"
import { Panel } from "./parts.tsx"
import { AccountPanel, useSignOutEverywhere } from "./settings/AccountPanel.tsx"
import { AgentKeysPanel } from "./settings/AgentKeysPanel.tsx"
import { EnvLock, Row, SwitchRow } from "./settings/parts.tsx"

export const CLOSED_DAYS_MIN = 1
export const CLOSED_DAYS_MAX = 365
const BOT_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/
const CHAT_ID = /^-?\d{1,20}$/
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/

/** The bot token in the form: kept as stored, replaced by a typed one, or removed on save (v3 FS-3). */
type TokenDraft = { mode: "replace"; value: string } | { mode: "remove" }

type Draft = {
  language?: Language
  dateFormat?: DateFormat
  timeFormat?: TimeFormat
  closedItemDays?: string
  sessionIdleDays?: string
  otpViaTelegram?: boolean
  botToken?: TokenDraft
  chatId?: string
  privateDomains?: string[]
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])

export function changedFields(saved: Settings, draft: Draft): SettingsPatch {
  const patch: SettingsPatch = {}
  if (draft.language !== undefined && draft.language !== saved.language) patch.language = draft.language
  if (draft.dateFormat !== undefined && draft.dateFormat !== saved.dateFormat) patch.dateFormat = draft.dateFormat
  if (draft.timeFormat !== undefined && draft.timeFormat !== saved.timeFormat) patch.timeFormat = draft.timeFormat
  if (draft.closedItemDays !== undefined && draft.closedItemDays.trim() !== String(saved.closedItemDays))
    patch.closedItemDays = Number(draft.closedItemDays.trim())
  if (draft.sessionIdleDays !== undefined && draft.sessionIdleDays.trim() !== String(saved.sessionIdleDays))
    patch.sessionIdleDays = Number(draft.sessionIdleDays.trim())
  if (draft.otpViaTelegram !== undefined && draft.otpViaTelegram !== saved.otpViaTelegram)
    patch.otpViaTelegram = draft.otpViaTelegram
  if (draft.botToken?.mode === "replace" && draft.botToken.value.trim())
    patch.telegramBotToken = draft.botToken.value.trim()
  if (draft.botToken?.mode === "remove" && saved.telegram.botToken.set) patch.telegramBotToken = null
  if (draft.chatId !== undefined && draft.chatId.trim() !== (saved.telegram.chatId.value ?? ""))
    patch.telegramChatId = draft.chatId.trim() || null
  if (draft.privateDomains !== undefined && !sameList(draft.privateDomains, saved.privateDomains.value))
    patch.privateDomains = draft.privateDomains
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
        {query.data ? <SettingsForm saved={query.data} /> : <AccountPanel />}
        <AppearancePanel />
        <SuppressionsPanel />
        <StatusPanel />
      </div>
    </div>
  )
}

type FieldError = { field: "days" | "idle" | "token" | "chat" | "domain"; text: string }

/** General, Telegram and Secret check, with one draft and one save bar; Account and Agent access sit between. */
function SettingsForm({ saved }: { saved: Settings }) {
  const { t, language, setLanguage } = useI18n()
  const queryClient = useQueryClient()
  const signOutEverywhere = useSignOutEverywhere()
  const ids = { days: useId(), idle: useId(), token: useId(), chat: useId(), domain: useId(), error: useId() }
  const [draft, setDraft] = useState<Draft>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<FieldError | null>(null)
  const patch = changedFields(saved, draft)
  const count = Object.keys(patch).length
  useUnsaved("settings", { count, kind: "leave" })

  const current = {
    language: draft.language ?? saved.language,
    dateFormat: draft.dateFormat ?? saved.dateFormat,
    timeFormat: draft.timeFormat ?? saved.timeFormat,
    closedItemDays: draft.closedItemDays ?? String(saved.closedItemDays),
    sessionIdleDays: draft.sessionIdleDays ?? String(saved.sessionIdleDays),
    otpViaTelegram: draft.otpViaTelegram ?? saved.otpViaTelegram,
    chatId: draft.chatId ?? saved.telegram.chatId.value ?? "",
    privateDomains: draft.privateDomains ?? saved.privateDomains.value,
  }
  const set = (change: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...change }))
    setError(null)
  }
  const example = withFormatPrefs({ dateFormat: current.dateFormat, timeFormat: current.timeFormat }, () =>
    formatTime(new Date(), { seconds: false }),
  )

  const refuse = (field: FieldError["field"], label: string, text: string) => {
    setError({ field, text })
    showToast(`${label}: ${text}`, "error")
    document.getElementById(ids[field])?.focus()
  }

  const save = async () => {
    const outside = (value: number | undefined, min: number, max: number) =>
      value !== undefined && (!Number.isInteger(value) || value < min || value > max)
    if (outside(patch.closedItemDays, CLOSED_DAYS_MIN, CLOSED_DAYS_MAX))
      return refuse(
        "days",
        t("settings.closedDays"),
        t("settings.daysInvalid", { min: CLOSED_DAYS_MIN, max: CLOSED_DAYS_MAX }),
      )
    if (outside(patch.sessionIdleDays, SESSION_IDLE_DAYS_MIN, SESSION_IDLE_DAYS_MAX))
      return refuse(
        "idle",
        t("settings.session.idleDays"),
        t("settings.daysInvalid", { min: SESSION_IDLE_DAYS_MIN, max: SESSION_IDLE_DAYS_MAX }),
      )
    if (typeof patch.telegramBotToken === "string" && !BOT_TOKEN.test(patch.telegramBotToken))
      return refuse("token", t("telegramSettings.botToken"), t("telegramSettings.tokenInvalid"))
    if (typeof patch.telegramChatId === "string" && !CHAT_ID.test(patch.telegramChatId))
      return refuse("chat", t("telegramSettings.chatId"), t("telegramSettings.chatInvalid"))
    setError(null)
    setBusy(true)
    try {
      const next = await api.updateSettings(patch)
      queryClient.setQueryData(qk.settings, next)
      setFormatPrefs({ dateFormat: next.dateFormat, timeFormat: next.timeFormat })
      if (next.language !== language) setLanguage(next.language)
      setDraft({})
      await queryClient.invalidateQueries({ queryKey: qk.morning })
      await queryClient.invalidateQueries({ queryKey: qk.telegram })
      // A shorter length leaves browsers already signed in with the time they had (G2): offer to sign out everywhere.
      if (patch.sessionIdleDays !== undefined && patch.sessionIdleDays < saved.sessionIdleDays)
        showToast(t("settings.session.shortened"), "success", {
          action: { label: t("account.endAll"), onAction: () => void signOutEverywhere() },
          duration: 10_000,
        })
      else showToast(t("settings.saved"), "success")
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "setting_locked")
        showToast(t("settings.env.refused"), "error")
      else if (failure instanceof ApiError && failure.code === "validation_failed")
        showToast(t("settings.saveInvalid", { reason: errorReason(language, failure) }), "error")
      else showToast(t("settings.saveFailed", { reason: errorReason(language, failure) }), "error")
    } finally {
      setBusy(false)
    }
  }

  const fieldError = (field: FieldError["field"]) =>
    error?.field === field ? (
      <p id={ids.error} className="ui-field-error">
        {error.text}
      </p>
    ) : null
  const invalid = (field: FieldError["field"]) =>
    error?.field === field ? { "aria-invalid": true as const, "aria-describedby": ids.error } : {}

  return (
    <>
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
                onClick={() => set({ language: code as Language })}
              >
                {new Intl.DisplayNames([code], { type: "language" }).of(code)}
              </button>
            ))}
          </fieldset>
        </Row>
        <Row label={t("settings.dateFormat")} hint={t("settings.dateFormatHint")} htmlFor={`${ids.days}-date`}>
          <select
            id={`${ids.days}-date`}
            className="ui-select"
            value={current.dateFormat}
            onChange={(event) => set({ dateFormat: event.target.value as DateFormat })}
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
                aria-pressed={
                  current.timeFormat === format || (format === "HH:mm" && !isTimeFormat(current.timeFormat))
                }
                onClick={() => set({ timeFormat: format })}
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
        <Row label={t("settings.closedDays")} hint={t("settings.closedDaysHint")} htmlFor={ids.days}>
          <input
            id={ids.days}
            className="ui-input ui-input-num"
            type="number"
            inputMode="numeric"
            min={CLOSED_DAYS_MIN}
            max={CLOSED_DAYS_MAX}
            value={current.closedItemDays}
            {...invalid("days")}
            onChange={(event) => set({ closedItemDays: event.target.value })}
          />
          {fieldError("days")}
        </Row>
        <Row label={t("settings.session.idleDays")} hint={t("settings.session.idleDaysHint")} htmlFor={ids.idle}>
          <input
            id={ids.idle}
            className="ui-input ui-input-num"
            type="number"
            inputMode="numeric"
            min={SESSION_IDLE_DAYS_MIN}
            max={SESSION_IDLE_DAYS_MAX}
            value={current.sessionIdleDays}
            {...invalid("idle")}
            onChange={(event) => set({ sessionIdleDays: event.target.value })}
          />
          {fieldError("idle")}
        </Row>
      </Panel>

      <AccountPanel />

      <Panel id="telegram" title={t("telegramSettings.title")}>
        <p className="ui-panel-body ui-hint">{t("telegramSettings.hint")}</p>
        <TelegramState saved={saved} />
        <Row label={t("telegramSettings.botToken")} hint={t("telegramSettings.botTokenHint")} htmlFor={ids.token}>
          <BotTokenField
            id={ids.token}
            saved={saved.telegram.botToken}
            draft={draft.botToken}
            onChange={(botToken) => set({ botToken })}
            invalidProps={invalid("token")}
          />
          {fieldError("token")}
        </Row>
        <Row label={t("telegramSettings.chatId")} hint={t("telegramSettings.chatIdHint")} htmlFor={ids.chat}>
          {saved.telegram.chatId.locked ? (
            <>
              <input id={ids.chat} className="ui-input" value={current.chatId} disabled dir="ltr" />
              <EnvLock variable={saved.telegram.chatId.variable} />
            </>
          ) : (
            <input
              id={ids.chat}
              className="ui-input"
              inputMode="numeric"
              dir="ltr"
              maxLength={21}
              placeholder={t("telegramSettings.notSet")}
              value={current.chatId}
              {...invalid("chat")}
              onChange={(event) => set({ chatId: event.target.value })}
            />
          )}
          {fieldError("chat")}
        </Row>
        <SwitchRow
          label={t("telegramSettings.otp")}
          hint={t("telegramSettings.otpHint")}
          checked={current.otpViaTelegram}
          disabled={saved.telegram.state !== "on" && !saved.otpViaTelegram}
          note={
            saved.telegram.state !== "on" && !saved.otpViaTelegram
              ? t("telegramSettings.otpNeedsTelegram")
              : current.otpViaTelegram
                ? t("telegramSettings.otpWarning")
                : undefined
          }
          onChange={(otpViaTelegram) => set({ otpViaTelegram })}
        />
        <TelegramRuntimeRows on={saved.telegram.state === "on"} />
      </Panel>

      <AgentKeysPanel />

      <Panel id="secret-check" title={t("secretCheck.title")}>
        <p className="ui-panel-body ui-hint">{t("secretCheck.hint")}</p>
        <Row label={t("secretCheck.domains")} hint={t("secretCheck.domainsHint")} htmlFor={ids.domain}>
          <DomainsField
            id={ids.domain}
            value={current.privateDomains}
            locked={saved.privateDomains.locked}
            variable={saved.privateDomains.variable}
            onChange={(privateDomains) => set({ privateDomains })}
            onInvalid={(text) => refuse("domain", t("secretCheck.domains"), text)}
          />
          {fieldError("domain")}
        </Row>
      </Panel>

      <SaveBar
        count={count}
        busy={busy}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft({})
          setError(null)
        }}
      />
    </>
  )
}

/** Off, incomplete (naming what is missing) or on. */
function TelegramState({ saved }: { saved: Settings }) {
  const { t } = useI18n()
  const { state, missing } = saved.telegram
  const tone = state === "on" ? "ok" : state === "incomplete" ? "warn" : "neutral"
  return (
    <div className="ui-kv">
      <span>{t("telegramSettings.state")}</span>
      <span>
        <Tag tone={tone}>{t(`telegramSettings.states.${state}`)}</Tag>{" "}
        {state === "incomplete" ? (
          <span className="ui-hint">
            {t("telegramSettings.missing", {
              fields: missing.map((field) => t(`telegramSettings.${field}`)).join(", "),
            })}
          </span>
        ) : null}
      </span>
    </div>
  )
}

/** The stored bot token: never shown; Set with Replace and Remove, or an input when there is none (v3 FS-3). */
function BotTokenField({
  id,
  saved,
  draft,
  onChange,
  invalidProps,
}: {
  id: string
  saved: Settings["telegram"]["botToken"]
  draft: TokenDraft | undefined
  onChange: (next: TokenDraft | undefined) => void
  invalidProps: Record<string, unknown>
}) {
  const { t } = useI18n()
  if (saved.locked)
    return (
      <>
        <span className="ui-set-secret">{t("telegramSettings.setByEnv")}</span>
        <EnvLock variable={saved.variable} />
      </>
    )
  const input = (
    <input
      id={id}
      className="ui-input"
      type="password"
      autoComplete="new-password"
      dir="ltr"
      maxLength={200}
      placeholder={saved.set ? t("telegramSettings.newValue") : t("telegramSettings.notSet")}
      value={draft?.mode === "replace" ? draft.value : ""}
      {...invalidProps}
      onChange={(event) => onChange({ mode: "replace", value: event.target.value })}
      // biome-ignore lint/a11y/noAutofocus: Replace puts the cursor where the new token goes (v3 FS-3)
      autoFocus={draft?.mode === "replace"}
    />
  )
  if (!saved.set) return input
  if (!saved.readable && draft?.mode !== "remove")
    return (
      <>
        <span className="ui-set-secret is-removing">{t("telegramSettings.unreadable")}</span>
        {input}
        <button type="button" className="ui-link-btn" onClick={() => onChange({ mode: "remove" })}>
          {t("telegramSettings.remove")}
        </button>
      </>
    )
  if (draft?.mode === "replace")
    return (
      <>
        {input}
        <button type="button" className="ui-link-btn" onClick={() => onChange(undefined)}>
          {t("telegramSettings.keep")}
        </button>
      </>
    )
  return (
    <span className="ui-set-secret-row">
      <span className={`ui-set-secret${draft?.mode === "remove" ? " is-removing" : ""}`}>
        {draft?.mode === "remove" ? t("telegramSettings.removedOnSave") : t("telegramSettings.stored")}
      </span>
      {draft?.mode === "remove" ? (
        <button type="button" className="ui-btn ui-btn-sm" onClick={() => onChange(undefined)}>
          {t("telegramSettings.keep")}
        </button>
      ) : (
        <>
          <button type="button" className="ui-btn ui-btn-sm" onClick={() => onChange({ mode: "replace", value: "" })}>
            {t("telegramSettings.replace")}
          </button>
          <button type="button" className="ui-btn ui-btn-sm" onClick={() => onChange({ mode: "remove" })}>
            {t("telegramSettings.remove")}
          </button>
        </>
      )}
    </span>
  )
}

/** Private domains as chips with an Add field (v3 FS-15); read-only when the environment sets them. */
function DomainsField({
  id,
  value,
  locked,
  variable,
  onChange,
  onInvalid,
}: {
  id: string
  value: string[]
  locked: boolean
  variable: string | null
  onChange: (next: string[]) => void
  onInvalid: (text: string) => void
}) {
  const { t } = useI18n()
  const [typed, setTyped] = useState("")
  const add = (event: FormEvent) => {
    event.preventDefault()
    const domain = typed
      .trim()
      .toLowerCase()
      .replace(/^\.+|\.+$/g, "")
    if (!domain) return
    if (!DOMAIN.test(domain)) return onInvalid(t("secretCheck.domainInvalid"))
    if (!value.includes(domain)) onChange([...value, domain])
    setTyped("")
  }
  return (
    <>
      {value.length > 0 ? (
        <ul className="ui-domain-chips" dir="ltr">
          {value.map((domain) => (
            <li key={domain} className="ui-chip">
              <span className="ui-mono">{domain}</span>
              {locked ? null : (
                <button
                  type="button"
                  className="ui-chip-x"
                  title={t("secretCheck.remove")}
                  aria-label={t("secretCheck.removeDomain", { domain })}
                  onClick={() => onChange(value.filter((d) => d !== domain))}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <span className="ui-hint">{t("secretCheck.none")}</span>
      )}
      {locked ? (
        <EnvLock variable={variable} />
      ) : (
        <span className="ui-domain-add">
          <input
            id={id}
            className="ui-input"
            dir="ltr"
            maxLength={253}
            autoCapitalize="off"
            spellCheck={false}
            placeholder={t("secretCheck.placeholder")}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") add(event)
            }}
          />
          <button type="button" className="ui-btn" onClick={add}>
            {t("secretCheck.add")}
          </button>
        </span>
      )}
    </>
  )
}

const JOB_TONE = { sent: "ok", sending: "info", failed: "fail", unknown: "warn", skipped: "warn" } as const

/** What the running bot reports, and the test message, while Telegram is on. */
function TelegramRuntimeRows({ on }: { on: boolean }) {
  const { t, language } = useI18n()
  const [sendingTest, setSendingTest] = useState(false)
  const telegram = usePageQuery({ queryKey: qk.telegram, queryFn: api.telegramStatus, every: EVERY.slow })
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
  if (!on) return null
  if (telegram.isError && !telegram.data)
    return (
      <div className="ui-panel-body">
        <ErrorState
          title={t("settings.telegramFailed")}
          error={telegram.error}
          onRetry={() => void telegram.refetch()}
        />
      </div>
    )
  if (!telegram.data) return null
  return (
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

function StatusPanel() {
  const { t } = useI18n()
  const morning = useQuery({ queryKey: qk.morning, queryFn: api.morning, staleTime: EVERY.live })
  const runs = usePageQuery({ queryKey: qk.syncRuns, queryFn: api.syncRuns, every: EVERY.slow })
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
    </Panel>
  )
}
