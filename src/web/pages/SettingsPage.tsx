// Settings in sections (v3 FS-8, FS-10, NL-3, SV-1): a section sidebar under the owner's groups (Q-2), General;
// Security: Account, Agent access, Secret check; Integrations: Telegram; Sync: Status, Suppressions. Each section
// has its own address, /settings/<section>; /settings and an address that names no section open the first one,
// replacing the address. Below 1024px the sidebar is one sticky picker. The theme is not a setting: it lives in
// the shell (the account menu and the theme button).
//
// General, Telegram and Secret check share one draft and one save bar above all sections: a change is kept while
// the owner moves between sections (the unsaved guard keeps moves inside /settings), each section that holds one
// shows a dot, and a refused field, by the page's own check or by the server, opens its section and takes the
// focus. Account and Agent access act at once, outside the save bar. A setting the environment sets is locked and
// names its variable.

import { useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { type FormEvent, type ReactNode, type Ref, type RefObject, useEffect, useId, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
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
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { SaveBar } from "../ui/SaveBar.tsx"
import { ErrorState, errorReason, Loading } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Tag } from "../ui/tags.tsx"
import { useUnsaved } from "../ui/unsaved.tsx"
import { AccountSection, useSignOutEverywhere } from "./settings/AccountPanel.tsx"
import { AgentKeysSection } from "./settings/AgentKeysPanel.tsx"
import { EnvLock, Group, Row, SwitchRow } from "./settings/parts.tsx"
import { StatusSection, SuppressionsSection } from "./settings/SyncSections.tsx"
import {
  changedSections,
  type DraftField,
  FIELD_SECTION,
  FIRST_SECTION,
  isSettingsPath,
  isSettingsSection,
  refusedField,
  SETTINGS_GROUPS,
  type SettingsSection,
  settingsPath,
} from "./settings/sections.ts"

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

/** The sections that edit the draft; the others act at once or only show. */
const FORM_SECTIONS = new Set<SettingsSection>(["general", "telegram", "secret-check"])

export function SettingsPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { section } = useParams()
  const active: SettingsSection = isSettingsSection(section) ? section : FIRST_SECTION
  // /settings and an unknown section open the first one in place of the address, adding no Back step (NL-3).
  // The page stays mounted, so the draft survives the correction.
  useEffect(() => {
    if (!isSettingsSection(section)) navigate(settingsPath(FIRST_SECTION), { replace: true })
  }, [section, navigate])
  const sectionTitle = t(`settings.sections.${active}.title`)
  usePageMeta(t("settings.title"), [], { label: sectionTitle, pageTo: "/settings" })
  const query = usePageQuery({ queryKey: qk.settings, queryFn: api.settings, every: EVERY.slow })
  const form = useSettingsDraft(query.data, active)

  const pageRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  useSectionScroll(active, pageRef, contentRef, pickerRef)

  let body: ReactNode
  if (FORM_SECTIONS.has(active)) {
    if (form.saved) body = <FormSection section={active} form={form} saved={form.saved} />
    else if (query.isError)
      body = <ErrorState title={t("settings.failed")} error={query.error} onRetry={() => void query.refetch()} />
    else body = <Loading label={t("settings.loading")} />
  } else if (active === "account") body = <AccountSection />
  else if (active === "agents") body = <AgentKeysSection />
  else if (active === "status") body = <StatusSection />
  else body = <SuppressionsSection />

  return (
    <div ref={pageRef} className="ui-page ui-set-page">
      <PageHead title={t("settings.title")} description={t("settings.description")} />
      <div className="ui-set-layout">
        <SectionPicker ref={pickerRef} active={active} changed={form.changed} />
        <SectionNav active={active} changed={form.changed} />
        <div ref={contentRef} className="ui-set-content">
          <section id={active} className="ui-set-section" aria-labelledby={`${active}-title`}>
            <h2 id={`${active}-title`} className="ui-set-title">
              {sectionTitle}
            </h2>
            <p className="ui-set-tabdesc">{t(`settings.sections.${active}.hint`)}</p>
            {body}
          </section>
        </div>
      </div>
      <SaveBar count={form.count} busy={form.busy} onSave={() => void form.save()} onDiscard={form.discard} />
    </div>
  )
}

/** The sidebar of sections under their group headings; the open one is marked like the main navigation. */
function SectionNav({ active, changed }: { active: SettingsSection; changed: Set<SettingsSection> }) {
  const { t } = useI18n()
  return (
    <nav className="ui-set-nav" aria-label={t("settings.categories")}>
      {SETTINGS_GROUPS.map((group) => (
        <div key={group.id} className="ui-set-navgroup">
          <p>{t(`settings.groups.${group.id}`)}</p>
          {group.sections.map((section) => (
            <Link
              key={section}
              to={settingsPath(section)}
              className="ui-set-tab"
              aria-current={section === active ? "true" : undefined}
            >
              <span>{t(`settings.sections.${section}.title`)}</span>
              {changed.has(section) ? (
                <span
                  className="ui-set-dot"
                  role="img"
                  aria-label={t("settings.unsavedHere")}
                  title={t("settings.unsavedHere")}
                />
              ) : null}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  )
}

/** Below 1024px the sidebar is one sticky picker, the groups as its option groups (FS-10). */
function SectionPicker({
  ref,
  active,
  changed,
}: {
  ref: Ref<HTMLDivElement>
  active: SettingsSection
  changed: Set<SettingsSection>
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const id = useId()
  return (
    <div ref={ref} className="ui-set-picker">
      <label htmlFor={id} className="ui-sr-only">
        {t("settings.category")}
      </label>
      <select
        id={id}
        className="ui-select"
        value={active}
        onChange={(event) => {
          if (isSettingsSection(event.target.value)) navigate(settingsPath(event.target.value))
        }}
      >
        {SETTINGS_GROUPS.map((group) => (
          <optgroup key={group.id} label={t(`settings.groups.${group.id}`)}>
            {group.sections.map((section) => {
              const name = t(`settings.sections.${section}.title`)
              return (
                <option key={section} value={section}>
                  {changed.has(section) ? t("settings.unsavedOption", { name }) : name}
                </option>
              )
            })}
          </optgroup>
        ))}
      </select>
    </div>
  )
}

/**
 * A newly opened section starts at its top (FS-10): where the fields scroll on their own, they go back to 0; where
 * the page scrolls as one (under 1024px, short screens), the page scrolls to just under the picker, only when the
 * section starts above it. Only the page's own scroll areas move, never the window (the FS-10 pitfall).
 */
function useSectionScroll(
  active: SettingsSection,
  pageRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  pickerRef: RefObject<HTMLDivElement | null>,
) {
  const first = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the open section changes
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const page = pageRef.current
    const content = contentRef.current
    if (!page || !content) return
    if (getComputedStyle(content).overflowY !== "visible") {
      content.scrollTop = 0
      return
    }
    const picker = pickerRef.current
    const offset = picker && getComputedStyle(picker).display !== "none" ? picker.offsetHeight + 8 : 0
    const top = content.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop - offset
    if (page.scrollTop > top) page.scrollTo({ top, behavior: "smooth" })
  }, [active])
}

type FieldError = { field: DraftField; text: string }

/** The one settings draft for every section, its save bar and its guard (SV-1, R2). */
function useSettingsDraft(saved: Settings | undefined, active: SettingsSection) {
  const { t, language, setLanguage } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const signOutEverywhere = useSignOutEverywhere()
  const base = useId()
  const ids: Record<DraftField, string> = {
    language: `${base}-language`,
    dateFormat: `${base}-date`,
    timeFormat: `${base}-time`,
    closedItemDays: `${base}-days`,
    sessionIdleDays: `${base}-idle`,
    otpViaTelegram: `${base}-otp`,
    botToken: `${base}-token`,
    chatId: `${base}-chat`,
    privateDomains: `${base}-domain`,
  }
  const errorId = `${base}-error`
  const [draft, setDraft] = useState<Draft>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<FieldError | null>(null)
  const [focusing, setFocusing] = useState<DraftField | null>(null)
  const patch = saved ? changedFields(saved, draft) : {}
  const count = Object.keys(patch).length
  useUnsaved("settings", { count, kind: "leave", keeps: (next) => isSettingsPath(next.pathname) })

  // A refused field takes the focus once its section shows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ids are fixed for the life of the page
  useEffect(() => {
    if (!focusing || FIELD_SECTION[focusing] !== active) return
    const element = document.getElementById(ids[focusing])
    const target =
      element instanceof HTMLFieldSetElement
        ? (element.querySelector<HTMLElement>('[aria-pressed="true"]') ?? element.querySelector<HTMLElement>("button"))
        : element
    target?.focus()
    setFocusing(null)
  }, [focusing, active])

  const set = (change: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...change }))
    setError(null)
  }

  /** Marks a field, opens its section when another one shows, and focuses it there. */
  const mark = (field: DraftField, text: string) => {
    setError({ field, text })
    const section = FIELD_SECTION[field]
    if (section !== active) navigate(settingsPath(section))
    setFocusing(field)
  }
  const refuse = (field: DraftField, label: string, text: string) => {
    showToast(`${label}: ${text}`, "error")
    mark(field, text)
  }

  const save = async () => {
    if (!saved) return
    const outside = (value: number | undefined, min: number, max: number) =>
      value !== undefined && (!Number.isInteger(value) || value < min || value > max)
    if (outside(patch.closedItemDays, CLOSED_DAYS_MIN, CLOSED_DAYS_MAX))
      return refuse(
        "closedItemDays",
        t("settings.closedDays"),
        t("settings.daysInvalid", { min: CLOSED_DAYS_MIN, max: CLOSED_DAYS_MAX }),
      )
    if (outside(patch.sessionIdleDays, SESSION_IDLE_DAYS_MIN, SESSION_IDLE_DAYS_MAX))
      return refuse(
        "sessionIdleDays",
        t("settings.session.idleDays"),
        t("settings.daysInvalid", { min: SESSION_IDLE_DAYS_MIN, max: SESSION_IDLE_DAYS_MAX }),
      )
    if (typeof patch.telegramBotToken === "string" && !BOT_TOKEN.test(patch.telegramBotToken))
      return refuse("botToken", t("telegramSettings.botToken"), t("telegramSettings.tokenInvalid"))
    if (typeof patch.telegramChatId === "string" && !CHAT_ID.test(patch.telegramChatId))
      return refuse("chatId", t("telegramSettings.chatId"), t("telegramSettings.chatInvalid"))
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
      let text: string
      if (failure instanceof ApiError && failure.code === "setting_locked") {
        text = t("settings.env.refused")
        showToast(text, "error")
      } else if (failure instanceof ApiError && failure.code === "validation_failed") {
        text = errorReason(language, failure)
        showToast(t("settings.saveInvalid", { reason: text }), "error")
      } else {
        text = errorReason(language, failure)
        showToast(t("settings.saveFailed", { reason: text }), "error")
      }
      // A refusal that names a field opens that field's section and focuses it (SV-1, R2).
      const field = failure instanceof ApiError ? refusedField(failure.code, failure.details) : null
      if (field) mark(field, text)
    } finally {
      setBusy(false)
    }
  }

  const discard = () => {
    setDraft({})
    setError(null)
  }

  const fieldError = (field: DraftField) =>
    error?.field === field ? (
      <p id={errorId} className="ui-field-error">
        {error.text}
      </p>
    ) : null
  const invalid = (field: DraftField) =>
    error?.field === field ? { "aria-invalid": true as const, "aria-describedby": errorId } : {}

  return {
    saved,
    draft,
    ids,
    set,
    refuse,
    save,
    discard,
    fieldError,
    invalid,
    count,
    busy,
    error,
    changed: changedSections(patch),
  }
}

type SettingsForm = ReturnType<typeof useSettingsDraft>

/** General, Telegram and Secret check: the parts of the one draft. */
function FormSection({ section, form, saved }: { section: SettingsSection; form: SettingsForm; saved: Settings }) {
  const { t } = useI18n()
  const { draft, ids, set, invalid, fieldError } = form
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
  const example = withFormatPrefs({ dateFormat: current.dateFormat, timeFormat: current.timeFormat }, () =>
    formatTime(new Date(), { seconds: false }),
  )

  if (section === "general")
    return (
      <>
        <Group id="settings-formats" title={t("settings.groupTitles.formats")}>
          <Row label={t("settings.language")} hint={t("settings.languageHint")}>
            <fieldset id={ids.language} className="ui-seg ui-plain-fieldset">
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
            {fieldError("language")}
          </Row>
          <Row label={t("settings.dateFormat")} hint={t("settings.dateFormatHint")} htmlFor={ids.dateFormat}>
            <select
              id={ids.dateFormat}
              className="ui-select"
              value={current.dateFormat}
              {...invalid("dateFormat")}
              onChange={(event) => set({ dateFormat: event.target.value as DateFormat })}
            >
              {isDateFormat(current.dateFormat) ? null : (
                <option value={current.dateFormat}>{current.dateFormat}</option>
              )}
              {DATE_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {format === "browser" ? t("settings.dateBrowser") : format.toUpperCase()}
                </option>
              ))}
            </select>
            {fieldError("dateFormat")}
          </Row>
          <Row label={t("settings.timeFormat")} hint={t("settings.timeFormatHint")}>
            <fieldset id={ids.timeFormat} className="ui-seg ui-plain-fieldset">
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
            {fieldError("timeFormat")}
          </Row>
          <Row label={t("settings.timeZone")} hint={t("settings.timeZoneHint")}>
            <span className="ui-mono">{APP_TIME_ZONE}</span>
          </Row>
        </Group>
        <Group id="settings-morning" title={t("settings.groupTitles.morning")}>
          <Row label={t("settings.closedDays")} hint={t("settings.closedDaysHint")} htmlFor={ids.closedItemDays}>
            <input
              id={ids.closedItemDays}
              className="ui-input ui-input-num"
              type="number"
              inputMode="numeric"
              min={CLOSED_DAYS_MIN}
              max={CLOSED_DAYS_MAX}
              value={current.closedItemDays}
              {...invalid("closedItemDays")}
              onChange={(event) => set({ closedItemDays: event.target.value })}
            />
            {fieldError("closedItemDays")}
          </Row>
        </Group>
        <Group id="settings-sessions" title={t("settings.groupTitles.sessions")}>
          <Row
            label={t("settings.session.idleDays")}
            hint={t("settings.session.idleDaysHint")}
            htmlFor={ids.sessionIdleDays}
          >
            <input
              id={ids.sessionIdleDays}
              className="ui-input ui-input-num"
              type="number"
              inputMode="numeric"
              min={SESSION_IDLE_DAYS_MIN}
              max={SESSION_IDLE_DAYS_MAX}
              value={current.sessionIdleDays}
              {...invalid("sessionIdleDays")}
              onChange={(event) => set({ sessionIdleDays: event.target.value })}
            />
            {fieldError("sessionIdleDays")}
          </Row>
        </Group>
      </>
    )

  if (section === "telegram")
    return (
      <>
        <Group id="settings-telegram-bot" title={t("settings.groupTitles.telegramBot")}>
          <TelegramState saved={saved} />
          <Row label={t("telegramSettings.botToken")} hint={t("telegramSettings.botTokenHint")} htmlFor={ids.botToken}>
            <BotTokenField
              id={ids.botToken}
              saved={saved.telegram.botToken}
              draft={draft.botToken}
              onChange={(botToken) => set({ botToken })}
              invalidProps={invalid("botToken")}
            />
            {fieldError("botToken")}
          </Row>
          <Row label={t("telegramSettings.chatId")} hint={t("telegramSettings.chatIdHint")} htmlFor={ids.chatId}>
            {saved.telegram.chatId.locked ? (
              <>
                <input
                  id={ids.chatId}
                  className="ui-input"
                  value={current.chatId}
                  disabled
                  dir="ltr"
                  {...invalid("chatId")}
                />
                <EnvLock variable={saved.telegram.chatId.variable} />
              </>
            ) : (
              <input
                id={ids.chatId}
                className="ui-input"
                inputMode="numeric"
                dir="ltr"
                maxLength={21}
                placeholder={t("telegramSettings.notSet")}
                value={current.chatId}
                {...invalid("chatId")}
                onChange={(event) => set({ chatId: event.target.value })}
              />
            )}
            {fieldError("chatId")}
          </Row>
        </Group>
        <Group id="settings-telegram-codes" title={t("settings.groupTitles.telegramCodes")}>
          <SwitchRow
            id={ids.otpViaTelegram}
            label={t("telegramSettings.otp")}
            hint={t("telegramSettings.otpHint")}
            checked={current.otpViaTelegram}
            disabled={saved.telegram.state !== "on" && !saved.otpViaTelegram}
            invalidProps={invalid("otpViaTelegram")}
            note={
              form.error?.field === "otpViaTelegram"
                ? fieldError("otpViaTelegram")
                : saved.telegram.state !== "on" && !saved.otpViaTelegram
                  ? t("telegramSettings.otpNeedsTelegram")
                  : current.otpViaTelegram
                    ? t("telegramSettings.otpWarning")
                    : undefined
            }
            onChange={(otpViaTelegram) => set({ otpViaTelegram })}
          />
        </Group>
        <TelegramRuntime on={saved.telegram.state === "on"} />
      </>
    )

  return (
    <Group id="settings-private-domains" title={t("settings.groupTitles.privateNetwork")}>
      <Row label={t("secretCheck.domains")} hint={t("secretCheck.domainsHint")} htmlFor={ids.privateDomains}>
        <DomainsField
          id={ids.privateDomains}
          value={current.privateDomains}
          locked={saved.privateDomains.locked}
          variable={saved.privateDomains.variable}
          invalidProps={invalid("privateDomains")}
          onChange={(privateDomains) => set({ privateDomains })}
          onInvalid={(text) => form.refuse("privateDomains", t("secretCheck.domains"), text)}
        />
        {fieldError("privateDomains")}
      </Row>
    </Group>
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
        <span id={id} tabIndex={-1} className="ui-set-secret">
          {t("telegramSettings.setByEnv")}
        </span>
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
          <button
            id={id}
            type="button"
            className="ui-btn ui-btn-sm"
            onClick={() => onChange({ mode: "replace", value: "" })}
          >
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
  invalidProps,
  onChange,
  onInvalid,
}: {
  id: string
  value: string[]
  locked: boolean
  variable: string | null
  invalidProps: Record<string, unknown>
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
            {...invalidProps}
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
function TelegramRuntime({ on }: { on: boolean }) {
  const { t, language } = useI18n()
  const [sendingTest, setSendingTest] = useState(false)
  const telegram = usePageQuery({ queryKey: qk.telegram, queryFn: api.telegramStatus, every: EVERY.slow, enabled: on })
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
  if (!on || (!telegram.data && !telegram.isError)) return null
  return (
    <Group id="settings-telegram-runtime" title={t("settings.groupTitles.telegramRuntime")}>
      {telegram.isError && !telegram.data ? (
        <div className="ui-panel-body">
          <ErrorState
            title={t("settings.telegramFailed")}
            error={telegram.error}
            onRetry={() => void telegram.refetch()}
          />
        </div>
      ) : null}
      {telegram.data ? (
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
      ) : null}
    </Group>
  )
}
