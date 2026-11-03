// Settings in sections (v3 FS-8, FS-10, NL-3, SV-1): a section sidebar under the owner's groups (Q-2), General;
// Security: Account, Agent access, Secret check; Integrations: Telegram; Sync: Status, Suppressions. Each section
// has its own address, /settings/<section>; /settings and an address that names no section open the first one,
// replacing the address. Below 1024px the sidebar is one sticky picker. The theme is not a setting: it lives in
// the shell (the account menu and the theme button).
//
// General, Telegram and Secret check share one draft and one save bar above all sections: a change is kept while
// the owner moves between sections (the unsaved guard keeps moves inside /settings), each section that holds one
// shows a dot, and a refused field, by the page's own check or by the server, opens its section and takes the
// focus. Account and Agent access act at once, outside the save bar.
//
// Each row marks a value that differs from its default (one table, src/shared/settings.ts) as Changed with Reset to
// default, which changes only the draft; a value put back as it was loaded drops out of the count. A setting the
// environment sets is locked in place with a neutral tag and its variable; secrets and locked values get no Changed
// or Reset (FS-3, FS-6). Telegram opens with its Status group; what needs a working bot while Telegram is not on is
// a locked area that says what is missing (FB-1).

import { useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import {
  type FormEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { Link, useLocation, useNavigate, useNavigationType, useParams } from "react-router"
import { SESSION_IDLE_DAYS_MAX, SESSION_IDLE_DAYS_MIN } from "../../shared/auth.ts"
import { LANGUAGES } from "../../shared/enums.ts"
import { CLOSED_ITEM_DAYS_MAX, CLOSED_ITEM_DAYS_MIN, SETTINGS_DEFAULTS } from "../../shared/settings.ts"
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
import { formatNumber } from "../format/number.ts"
import { type Language, useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { SaveBar } from "../ui/SaveBar.tsx"
import { ErrorState, errorReason, Loading, Locked } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Tag } from "../ui/tags.tsx"
import { useUnsaved } from "../ui/unsaved.tsx"
import { AccountSection, useSignOutEverywhere } from "./settings/AccountPanel.tsx"
import { AgentKeysSection } from "./settings/AgentKeysPanel.tsx"
import { Fact, Facts, Group, type ResetMark, Row, SwitchRow } from "./settings/parts.tsx"
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

/** The same domains, in any order: removing one and adding it back is no change (SV-2). */
const sameList = (a: string[], b: string[]) => {
  const sorted = (list: string[]) => [...list].sort().join(" ")
  return sorted(a) === sorted(b)
}

/**
 * The number a field holds, as the save sends it (`Number` of the trimmed text), or null when it holds none. "07",
 * " 7 ", "7.0" and "7e0" are all 7, so none of them is a change against a saved 7 (SV-2), and none is Changed against
 * a default of 7 (FS-6).
 */
export function typedNumber(typed: string): number | null {
  const text = typed.trim()
  if (text === "") return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

const sameNumber = (typed: string, saved: number) => typedNumber(typed) === saved

export function changedFields(saved: Settings, draft: Draft): SettingsPatch {
  const patch: SettingsPatch = {}
  if (draft.language !== undefined && draft.language !== saved.language) patch.language = draft.language
  if (draft.dateFormat !== undefined && draft.dateFormat !== saved.dateFormat) patch.dateFormat = draft.dateFormat
  if (draft.timeFormat !== undefined && draft.timeFormat !== saved.timeFormat) patch.timeFormat = draft.timeFormat
  if (draft.closedItemDays !== undefined && !sameNumber(draft.closedItemDays, saved.closedItemDays))
    patch.closedItemDays = Number(draft.closedItemDays.trim())
  if (draft.sessionIdleDays !== undefined && !sameNumber(draft.sessionIdleDays, saved.sessionIdleDays))
    patch.sessionIdleDays = Number(draft.sessionIdleDays.trim())
  if (draft.otpViaTelegram !== undefined && draft.otpViaTelegram !== saved.otpViaTelegram)
    patch.otpViaTelegram = draft.otpViaTelegram
  // A field the environment sets is left out, also when it became locked after it was edited (the variable was set
  // and the server restarted): the server would refuse it, and with it the rest of the save.
  const tokenOpen = !saved.telegram.botToken.locked
  if (tokenOpen && draft.botToken?.mode === "replace" && draft.botToken.value.trim())
    patch.telegramBotToken = draft.botToken.value.trim()
  if (tokenOpen && draft.botToken?.mode === "remove" && saved.telegram.botToken.set) patch.telegramBotToken = null
  if (
    !saved.telegram.chatId.locked &&
    draft.chatId !== undefined &&
    draft.chatId.trim() !== (saved.telegram.chatId.value ?? "")
  )
    patch.telegramChatId = draft.chatId.trim() || null
  if (
    !saved.privateDomains.locked &&
    draft.privateDomains !== undefined &&
    !sameList(draft.privateDomains, saved.privateDomains.value)
  )
    patch.privateDomains = draft.privateDomains
  return patch
}

/** The sections that edit the draft; the others act at once or only show. */
const FORM_SECTIONS = new Set<SettingsSection>(["general", "telegram", "secret-check"])

/** The section last open during this visit: /settings, from the navigation, reopens it (NL-4). */
let lastSection: SettingsSection = FIRST_SECTION
/** Where each scroll area of Settings was, per history entry, so Back and Forward bring it back (NL-3). */
const scrollMemory = new Map<string, { page: number; content: number }>()

/** Forgets the section and the scroll positions of this visit (tests). */
export function forgetSettingsVisit(): void {
  lastSection = FIRST_SECTION
  scrollMemory.clear()
}

export function SettingsPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { section } = useParams()
  const active: SettingsSection = isSettingsSection(section)
    ? section
    : section === undefined
      ? lastSection
      : FIRST_SECTION
  // /settings opens the section last open during the visit, and an unknown section the first one, in place of the
  // address, adding no Back step (NL-3, NL-4). A link to a section opens that section. The page stays mounted, so
  // the draft survives the correction.
  useEffect(() => {
    if (isSettingsSection(section)) lastSection = section
    else navigate(settingsPath(section === undefined ? lastSection : FIRST_SECTION), { replace: true })
  }, [section, navigate])
  const sectionTitle = t(`settings.sections.${active}.title`)
  usePageMeta(t("settings.title"), [], { label: sectionTitle, pageTo: "/settings" })
  const query = usePageQuery({ queryKey: qk.settings, queryFn: api.settings, every: EVERY.slow })
  const form = useSettingsDraft(query.data, active)

  const pageRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const refused = form.focusing !== null && FIELD_SECTION[form.focusing] === active
  useSectionView(refused, pageRef, contentRef, pickerRef)
  // A refused field takes the focus once its section shows, after the section's own scroll, and comes into view
  // clear of the sticky picker, the save bar and a toast (SV-1).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a refusal asks for a field or its section shows
  useEffect(() => {
    const field = form.focusing
    if (!field || FIELD_SECTION[field] !== active) return
    const element = document.getElementById(form.ids[field])
    const target =
      element instanceof HTMLFieldSetElement
        ? (element.querySelector<HTMLElement>('[aria-pressed="true"]') ?? element.querySelector<HTMLElement>("button"))
        : element
    if (target) {
      target.focus({ preventScroll: true })
      keepRevealed(target, pageRef.current, contentRef.current, pickerRef.current)
    }
    form.focused()
  }, [form.focusing, active])

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

/** The area that scrolls the fields: their own column from 1024px wide and 601px tall, the whole page otherwise. */
const scrollArea = (page: HTMLElement, content: HTMLElement) =>
  getComputedStyle(content).overflowY !== "visible" ? content : page

/** The height the sticky picker takes at the top of the page, with its gap; 0 where the sidebar shows. */
const pickerHeight = (picker: HTMLElement | null) =>
  picker && getComputedStyle(picker).display !== "none" ? picker.offsetHeight + 8 : 0

/**
 * Where a section opens (NL-3, FS-10). Back and Forward bring each scroll area back to where it was on that
 * history entry; any other move opens the section at its top: where the fields scroll on their own they go back to
 * 0, and where the page scrolls as one (under 1024px, short screens) it scrolls to just under the picker, only when
 * the section starts above it. A move made to show a refused field leaves the scroll to that field. Only the page's
 * own scroll areas move, never the window (the FS-10 pitfall).
 */
function useSectionView(
  refused: boolean,
  pageRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  pickerRef: RefObject<HTMLDivElement | null>,
) {
  const { key } = useLocation()
  const navigationType = useNavigationType()
  const entry = useRef(key)
  const shown = useRef<string | null>(null)

  // Each scroll of either area is kept for the history entry that shows.
  useEffect(() => {
    const page = pageRef.current
    const content = contentRef.current
    if (!page || !content) return
    const keep = () => scrollMemory.set(entry.current, { page: page.scrollTop, content: content.scrollTop })
    page.addEventListener("scroll", keep, { passive: true })
    content.addEventListener("scroll", keep, { passive: true })
    return () => {
      page.removeEventListener("scroll", keep)
      content.removeEventListener("scroll", keep)
    }
  }, [pageRef, contentRef])

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per history entry, before the page paints
  useLayoutEffect(() => {
    const previous = shown.current
    shown.current = key
    entry.current = key
    const page = pageRef.current
    const content = contentRef.current
    if (!page || !content) return
    const saved = navigationType === "POP" ? scrollMemory.get(key) : undefined
    // Started again when StrictMode runs the effect twice: its cleanup stopped the first restore.
    if (saved) return restoreScroll(page, content, saved)
    if (previous === null || previous === key || refused) return
    if (scrollArea(page, content) === content) {
      content.scrollTop = 0
      return
    }
    const top =
      content.getBoundingClientRect().top -
      page.getBoundingClientRect().top +
      page.scrollTop -
      pickerHeight(pickerRef.current)
    if (page.scrollTop > top) page.scrollTo({ top, behavior: "smooth" })
  }, [key])
}

/** How long a restore waits for a section's content to arrive (a list read again after its cache went). */
export const RESTORE_FOR_MS = 5000

/** Input by which the owner scrolls or moves the focus: any of it ends a restore that is still waiting. */
const OWN_SCROLL = ["wheel", "touchstart", "pointerdown", "focusin"] as const

/**
 * Brings the scroll areas back to a saved position (NL-3). A section whose content is still loading is shorter than
 * it was, so the position is set again on every frame until the areas reach it, the owner scrolls by wheel, touch,
 * the scroll bar or a key or moves the focus into them, another entry shows, or RESTORE_FOR_MS pass. A scroll it
 * saw no input for (a scroll bar dragged off the main thread, assistive technology) still stops it: before each
 * write the areas must sit where the last write left them (as the browser clamped it), unless the content grew.
 * Returns the stop.
 */
function restoreScroll(page: HTMLElement, content: HTMLElement, saved: { page: number; content: number }) {
  const until = performance.now() + RESTORE_FOR_MS
  let frame = 0
  const stop = () => {
    cancelAnimationFrame(frame)
    for (const type of OWN_SCROLL) {
      page.removeEventListener(type, stop, true)
      content.removeEventListener(type, stop, true)
    }
    window.removeEventListener("keydown", stop, true)
  }
  /** Where the last write left the areas, and how tall they were then. */
  let wrote: { page: number; content: number; pageHeight: number; contentHeight: number } | null = null
  const step = () => {
    if (wrote) {
      const moved = Math.abs(page.scrollTop - wrote.page) > 1 || Math.abs(content.scrollTop - wrote.content) > 1
      const grew = page.scrollHeight > wrote.pageHeight || content.scrollHeight > wrote.contentHeight
      if (moved && !grew) return stop()
    }
    page.scrollTop = saved.page
    content.scrollTop = saved.content
    wrote = {
      page: page.scrollTop,
      content: content.scrollTop,
      pageHeight: page.scrollHeight,
      contentHeight: content.scrollHeight,
    }
    const reached = Math.abs(page.scrollTop - saved.page) <= 1 && Math.abs(content.scrollTop - saved.content) <= 1
    if (reached || performance.now() > until) stop()
    else frame = requestAnimationFrame(step)
  }
  for (const type of OWN_SCROLL) {
    page.addEventListener(type, stop, { capture: true, passive: true })
    content.addEventListener(type, stop, { capture: true, passive: true })
  }
  window.addEventListener("keydown", stop, true)
  step()
  return stop
}

/** Scrolls a field and its note into the visible part of its scroll area: under the picker, above the save bar. */
function reveal(
  target: HTMLElement,
  page: HTMLElement | null,
  content: HTMLElement | null,
  picker: HTMLElement | null,
  always = false,
) {
  if (!page || !content) return
  const area = scrollArea(page, content)
  const bounds = area.getBoundingClientRect()
  const top = bounds.top + (area === page ? pickerHeight(picker) : 0) + 8
  const visibleEnd = bounds.bottom - 8
  let bottom = visibleEnd
  const box = target.getBoundingClientRect()
  const note = document.getElementById(target.getAttribute("aria-describedby") ?? "")
  const end = Math.max(box.bottom, note?.getBoundingClientRect().bottom ?? 0)
  // What floats over the page there: the save bar, a toast, the phone tab bar.
  for (const layer of document.querySelectorAll<HTMLElement>(".ui-savebar, .ui-toast, .ui-tabbar")) {
    const over = layer.getBoundingClientRect()
    // Each layer is weighed against the area itself: one already counted (the save bar) must not hide a taller one
    // over it (the refusal's toast on a phone).
    if (over.height > 0 && over.left < box.right && over.right > box.left && over.top < visibleEnd)
      bottom = Math.min(bottom, over.top - 8)
  }
  const by = box.top < top ? box.top - top : end > bottom ? Math.min(end - bottom, box.top - top) : 0
  // An instant scroll: it also ends a smooth scroll still running from the last section change, which would otherwise
  // carry on from where it was and leave the field short of where this puts it. `always` writes even when the field
  // is in view, only to end that smooth scroll.
  if (by !== 0 || always) area.scrollTo({ top: area.scrollTop + by, behavior: "instant" })
}

/** How long a refused field is held in view while the page settles after its section opens. */
export const REVEAL_FOR_MS = 400

/**
 * Brings a refused field and its note into view (`reveal`), then keeps them there for REVEAL_FOR_MS: on a phone a
 * smooth scroll from the last section change may still be running, and the refusal's toast mounts after the field
 * took the focus, over the save bar. Each frame checks again; it stops once the field loses the focus, or the owner
 * scrolls, touches, clicks or presses a key. A scroll it saw no input for (a scroll bar dragged off the main thread,
 * assistive technology) stops it too, as it stops `restoreScroll`: before each write the areas must sit where the
 * last write left them, unless the content grew. The first write always runs, to end a smooth scroll still running.
 */
export function keepRevealed(
  target: HTMLElement,
  page: HTMLElement | null,
  content: HTMLElement | null,
  picker: HTMLElement | null,
) {
  if (!page || !content) return
  const until = performance.now() + REVEAL_FOR_MS
  const owner = ["wheel", "touchstart", "pointerdown"] as const
  let frame = 0
  const stop = () => {
    cancelAnimationFrame(frame)
    for (const type of owner) {
      page.removeEventListener(type, stop, true)
      content.removeEventListener(type, stop, true)
    }
    window.removeEventListener("keydown", stop, true)
  }
  /** Where the last write left the areas, and how tall they were then. */
  let wrote: { page: number; content: number; pageHeight: number; contentHeight: number } | null = null
  const step = () => {
    if (document.activeElement !== target) return stop()
    if (wrote) {
      const moved = Math.abs(page.scrollTop - wrote.page) > 1 || Math.abs(content.scrollTop - wrote.content) > 1
      const grew = page.scrollHeight > wrote.pageHeight || content.scrollHeight > wrote.contentHeight
      if (moved && !grew) return stop()
    }
    reveal(target, page, content, picker, wrote === null)
    wrote = {
      page: page.scrollTop,
      content: content.scrollTop,
      pageHeight: page.scrollHeight,
      contentHeight: content.scrollHeight,
    }
    if (performance.now() > until) stop()
    else frame = requestAnimationFrame(step)
  }
  for (const type of owner) {
    page.addEventListener(type, stop, { capture: true, passive: true })
    content.addEventListener(type, stop, { capture: true, passive: true })
  }
  window.addEventListener("keydown", stop, true)
  step()
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
    if (outside(patch.closedItemDays, CLOSED_ITEM_DAYS_MIN, CLOSED_ITEM_DAYS_MAX))
      return refuse(
        "closedItemDays",
        t("settings.closedDays"),
        t("settings.daysInvalid", { min: CLOSED_ITEM_DAYS_MIN, max: CLOSED_ITEM_DAYS_MAX }),
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
    /** The refused field that waits for the focus until its section shows. */
    focusing,
    focused: () => setFocusing(null),
    /** Opens a field's section and brings it into view with the focus (a locked area's button). */
    focus: (field: DraftField) => {
      const section = FIELD_SECTION[field]
      if (section !== active) navigate(settingsPath(section))
      setFocusing(field)
    },
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
    // A locked field shows what the environment sets, never an edit made before it was locked.
    chatId: (saved.telegram.chatId.locked ? undefined : draft.chatId) ?? saved.telegram.chatId.value ?? "",
    privateDomains: (saved.privateDomains.locked ? undefined : draft.privateDomains) ?? saved.privateDomains.value,
  }
  const example = withFormatPrefs({ dateFormat: current.dateFormat, timeFormat: current.timeFormat }, () =>
    formatTime(new Date(), { seconds: false }),
  )
  /** Changed and Reset for a value that differs from its default; Reset changes only the draft (R7, FS-6). */
  const resetTo = (differs: boolean, label: string, change: Partial<Draft>): ResetMark | null =>
    differs ? { label, onReset: () => set(change) } : null
  const D = SETTINGS_DEFAULTS
  const telegramOn = saved.telegram.state === "on"

  if (section === "general")
    return (
      <>
        <Group id="settings-formats" title={t("settings.groupTitles.formats")}>
          <Row
            label={t("settings.language")}
            hint={t("settings.languageHint")}
            reset={resetTo(current.language !== D.language, languageName(D.language), { language: D.language })}
          >
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
                  {languageName(code)}
                </button>
              ))}
            </fieldset>
            {fieldError("language")}
          </Row>
          <Row
            label={t("settings.dateFormat")}
            hint={t("settings.dateFormatHint")}
            htmlFor={ids.dateFormat}
            reset={resetTo(current.dateFormat !== D.dateFormat, D.dateFormat.toUpperCase(), {
              dateFormat: D.dateFormat,
            })}
          >
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
          <Row
            label={t("settings.timeFormat")}
            hint={t("settings.timeFormatHint")}
            reset={resetTo(current.timeFormat !== D.timeFormat, t(`settings.timeFormats.${timeKey(D.timeFormat)}`), {
              timeFormat: D.timeFormat,
            })}
          >
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
                  {t(`settings.timeFormats.${timeKey(format)}`)}
                </button>
              ))}
            </fieldset>
            <span className="ui-hint ui-num" aria-live="polite">
              {t("settings.example", { example })}
            </span>
            {fieldError("timeFormat")}
          </Row>
          <Row label={t("settings.timeZone")} hint={t("settings.timeZoneHint")}>
            <span className="ui-mono ui-set-value" dir="ltr">
              {APP_TIME_ZONE}
            </span>
          </Row>
        </Group>
        <Group id="settings-morning" title={t("settings.groupTitles.morning")}>
          <Row
            label={t("settings.closedDays")}
            hint={t("settings.closedDaysHint")}
            htmlFor={ids.closedItemDays}
            reset={resetTo(typedNumber(current.closedItemDays) !== D.closedItemDays, formatNumber(D.closedItemDays), {
              closedItemDays: String(D.closedItemDays),
            })}
          >
            <input
              id={ids.closedItemDays}
              className="ui-input"
              type="number"
              inputMode="numeric"
              min={CLOSED_ITEM_DAYS_MIN}
              max={CLOSED_ITEM_DAYS_MAX}
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
            reset={resetTo(
              typedNumber(current.sessionIdleDays) !== D.sessionIdleDays,
              formatNumber(D.sessionIdleDays),
              {
                sessionIdleDays: String(D.sessionIdleDays),
              },
            )}
          >
            <input
              id={ids.sessionIdleDays}
              className="ui-input"
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

  if (section === "telegram") {
    const chatLock = saved.telegram.chatId.locked ? { variable: saved.telegram.chatId.variable } : null
    const tokenLock = saved.telegram.botToken.locked ? { variable: saved.telegram.botToken.variable } : null
    // Sign-in codes need a working bot. While Telegram is not on the switch is replaced by a locked area, unless the
    // codes are on already: then the switch stays, so the owner can turn them off (FB-1, R6).
    const codesLocked = !telegramOn && !saved.otpViaTelegram
    const setUp = <TelegramSetUp onClick={() => form.focus("botToken")} />
    return (
      <>
        <TelegramStatus saved={saved} setUp={setUp} />
        <Group id="settings-telegram-bot" title={t("settings.groupTitles.telegramBot")}>
          <Row
            label={t("telegramSettings.botToken")}
            hint={t("telegramSettings.botTokenHint")}
            htmlFor={ids.botToken}
            lock={tokenLock}
          >
            <BotTokenField
              id={ids.botToken}
              saved={saved.telegram.botToken}
              draft={draft.botToken}
              onChange={(botToken) => set({ botToken })}
              invalidProps={invalid("botToken")}
            />
            {fieldError("botToken")}
          </Row>
          <Row
            label={t("telegramSettings.chatId")}
            hint={t("telegramSettings.chatIdHint")}
            htmlFor={ids.chatId}
            lock={chatLock}
            onClear={current.chatId.trim() ? () => set({ chatId: "" }) : null}
          >
            <input
              id={ids.chatId}
              className="ui-input"
              inputMode="numeric"
              dir="ltr"
              maxLength={21}
              disabled={Boolean(chatLock)}
              placeholder={chatLock ? t("settings.env.pill") : t("telegramSettings.notSet")}
              value={current.chatId}
              {...invalid("chatId")}
              onChange={(event) => set({ chatId: event.target.value })}
            />
            {fieldError("chatId")}
          </Row>
        </Group>
        <Group id="settings-telegram-codes" title={t("settings.groupTitles.telegramCodes")}>
          {codesLocked ? (
            <div className="ui-set-locked">
              <Locked title={t("telegramSettings.otpLocked")} action={setUp}>
                {t("telegramSettings.needsTelegram")}
              </Locked>
            </div>
          ) : (
            <SwitchRow
              id={ids.otpViaTelegram}
              label={t("telegramSettings.otp")}
              hint={t("telegramSettings.otpHint")}
              checked={current.otpViaTelegram}
              invalidProps={invalid("otpViaTelegram")}
              reset={resetTo(current.otpViaTelegram !== D.otpViaTelegram, t("settings.off"), {
                otpViaTelegram: D.otpViaTelegram,
              })}
              note={
                form.error?.field === "otpViaTelegram"
                  ? fieldError("otpViaTelegram")
                  : current.otpViaTelegram
                    ? t("telegramSettings.otpWarning")
                    : undefined
              }
              onChange={(otpViaTelegram) => set({ otpViaTelegram })}
            />
          )}
        </Group>
      </>
    )
  }

  const domainsLock = saved.privateDomains.locked ? { variable: saved.privateDomains.variable } : null
  return (
    <Group id="settings-private-domains" title={t("settings.groupTitles.privateNetwork")}>
      <Row
        label={t("secretCheck.domains")}
        hint={t("secretCheck.domainsHint")}
        htmlFor={ids.privateDomains}
        lock={domainsLock}
      >
        <DomainsField
          id={ids.privateDomains}
          value={current.privateDomains}
          locked={Boolean(domainsLock)}
          invalidProps={invalid("privateDomains")}
          onChange={(privateDomains) => set({ privateDomains })}
          onInvalid={(text) => form.refuse("privateDomains", t("secretCheck.domains"), text)}
        />
        {fieldError("privateDomains")}
      </Row>
    </Group>
  )
}

/** A language's name in that language (Intl.DisplayNames, never a locale file: RT, the locale traps). */
const languageName = (code: string) => new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code
const timeKey = (format: TimeFormat) => (format === "HH:mm" ? "h24" : format === "h:mm a" ? "h12" : "browser")

/** The button of a locked area that needs Telegram: brings the bot token field into view with the focus. */
function TelegramSetUp({ onClick }: { onClick: () => void }) {
  const { t } = useI18n()
  return (
    <button type="button" className="ui-btn ui-btn-sm" onClick={onClick}>
      {t("telegramSettings.setUp")}
    </button>
  )
}

const JOB_TONE = { sent: "ok", sending: "info", failed: "fail", unknown: "warn", skipped: "warn" } as const

/**
 * The Status group that opens Telegram (FS-8): the state, with the test message beside it, and what the running bot
 * reports. While Telegram is not on, the test and the bot's report are a locked area that says what is missing.
 */
function TelegramStatus({ saved, setUp }: { saved: Settings; setUp: ReactNode }) {
  const { t, language } = useI18n()
  const { state, missing } = saved.telegram
  const on = state === "on"
  const [sendingTest, setSendingTest] = useState(false)
  const telegram = usePageQuery({ queryKey: qk.telegram, queryFn: api.telegramStatus, every: EVERY.slow, enabled: on })
  const tone = on ? "ok" : state === "incomplete" ? "warn" : "neutral"
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
  const data = telegram.data
  return (
    <Group id="settings-telegram-status" title={t("settings.groupTitles.status")}>
      <Facts>
        <Fact label={t("telegramSettings.state")}>
          <Tag tone={tone}>{t(`telegramSettings.states.${state}`)}</Tag>
          {state === "incomplete" ? (
            <span className="ui-hint">
              {t("telegramSettings.missing", {
                fields: missing.map((field) => t(`telegramSettings.${field}`)).join(", "),
              })}
            </span>
          ) : null}
          {on ? (
            <button type="button" className="ui-btn ui-btn-sm" disabled={sendingTest} onClick={() => void sendTest()}>
              {sendingTest ? t("settings.telegramTestSending") : t("settings.telegramTest")}
            </button>
          ) : null}
        </Fact>
        {data ? (
          <>
            <Fact label={t("settings.bot")}>
              <Tag tone={data.polling ? "ok" : "warn"}>
                {data.polling ? t("settings.botPolling") : t("settings.botNotPolling")}
              </Tag>
            </Fact>
            <Fact label={t("settings.lastUpdate")}>
              {data.lastUpdateAt ? <Time value={data.lastUpdateAt} mode="full" /> : t("settings.noUpdateYet")}
            </Fact>
            <Fact label={t("settings.lastMorning")}>
              {data.lastMorning ? (
                <>
                  <Time value={data.lastMorning.at ?? data.lastMorning.localDate} mode="day" />
                  <Tag tone={JOB_TONE[data.lastMorning.state]}>{t(`settings.job.${data.lastMorning.state}`)}</Tag>
                </>
              ) : (
                t("settings.noMorningYet")
              )}
            </Fact>
          </>
        ) : null}
      </Facts>
      {on ? (
        <>
          {telegram.isError && !data ? (
            <ErrorState
              title={t("settings.telegramFailed")}
              error={telegram.error}
              onRetry={() => void telegram.refetch()}
            />
          ) : null}
          <p className="ui-set-group-intro">{t("settings.telegramTestHint")}</p>
        </>
      ) : (
        <div className="ui-set-locked">
          <Locked title={t("telegramSettings.testLocked")} action={setUp}>
            {t("telegramSettings.needsTelegram")}
          </Locked>
        </div>
      )}
    </Group>
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
  // Set by the environment: stored there, with no buttons; the lock is on the label line (FS-3, FS-6).
  if (saved.locked)
    return (
      <span id={id} tabIndex={-1} className="ui-set-secret">
        {t("telegramSettings.setByEnv")}
      </span>
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

/**
 * Private domains as value chips with an Add field (v3 FS-15, S-13): a value chip is mono, square-cornered and
 * quiet, never the pill of a filter chip. Set by the environment: the chips without their X, and the Add field
 * disabled in place.
 */
function DomainsField({
  id,
  value,
  locked,
  invalidProps,
  onChange,
  onInvalid,
}: {
  id: string
  value: string[]
  locked: boolean
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
        <ul className="ui-value-chips" dir="ltr" aria-label={t("secretCheck.domains")}>
          {value.map((domain) => (
            <li key={domain} className="ui-value-chip">
              <bdi>{domain}</bdi>
              {locked ? null : (
                <button
                  type="button"
                  className="ui-value-chip-x"
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
      <span className="ui-domain-add">
        <input
          id={id}
          className="ui-input"
          dir="ltr"
          maxLength={253}
          autoCapitalize="off"
          spellCheck={false}
          disabled={locked}
          placeholder={locked ? t("settings.env.pill") : t("secretCheck.placeholder")}
          value={typed}
          {...invalidProps}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") add(event)
          }}
        />
        <button type="button" className="ui-btn" disabled={locked} onClick={add}>
          {t("secretCheck.add")}
        </button>
      </span>
    </>
  )
}
