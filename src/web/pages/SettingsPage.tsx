// Settings: language, date and time format, closed-item days (saved with the save bar), the theme of
// this browser (applies at once), paired devices, suppressions, and the sync and Telegram status.

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useId, useState } from "react"
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
import { Empty, ErrorState, errorReason, Loading, Locked } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Tag } from "../ui/tags.tsx"
import { useUnsaved } from "../ui/unsaved.tsx"
import { Panel } from "./parts.tsx"

export const CLOSED_DAYS_MIN = 1
export const CLOSED_DAYS_MAX = 365

type Draft = { language?: Language; dateFormat?: DateFormat; timeFormat?: TimeFormat; closedItemDays?: string }

export function changedFields(saved: Settings, draft: Draft): SettingsPatch {
  const patch: SettingsPatch = {}
  if (draft.language !== undefined && draft.language !== saved.language) patch.language = draft.language
  if (draft.dateFormat !== undefined && draft.dateFormat !== saved.dateFormat) patch.dateFormat = draft.dateFormat
  if (draft.timeFormat !== undefined && draft.timeFormat !== saved.timeFormat) patch.timeFormat = draft.timeFormat
  if (draft.closedItemDays !== undefined && draft.closedItemDays.trim() !== String(saved.closedItemDays)) {
    patch.closedItemDays = Number(draft.closedItemDays.trim())
  }
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
        <AppearancePanel />
        <DevicesPanel />
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
  const [draft, setDraft] = useState<Draft>({})
  const [busy, setBusy] = useState(false)
  const [daysError, setDaysError] = useState<string | null>(null)
  const patch = changedFields(saved, draft)
  const count = Object.keys(patch).length
  useUnsaved("settings", { count, kind: "leave" })

  const current = {
    language: draft.language ?? saved.language,
    dateFormat: draft.dateFormat ?? saved.dateFormat,
    timeFormat: draft.timeFormat ?? saved.timeFormat,
    closedItemDays: draft.closedItemDays ?? String(saved.closedItemDays),
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
      <SaveBar
        count={count}
        busy={busy}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft({})
          setDaysError(null)
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

function DevicesPanel() {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const query = usePageQuery({ queryKey: qk.devices, queryFn: api.devices, every: EVERY.slow })
  const session = useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: Number.POSITIVE_INFINITY })
  const devices = (query.data ?? []).filter((device) => !device.revokedAt)
  const afterChange = async (endedThis: boolean) => {
    if (endedThis) await queryClient.invalidateQueries({ queryKey: qk.session })
    else await queryClient.invalidateQueries({ queryKey: qk.devices })
  }
  const revoke = async (id: string, label: string, current: boolean) => {
    const ok = await confirmDialog({
      title: t("devices.revokeTitle", { label }),
      message: current ? t("devices.revokeThis") : t("devices.revokeOther"),
      confirmText: t("devices.revoke"),
      danger: true,
    })
    if (!ok) return
    try {
      await api.revokeDevice(id)
      showToast(t("devices.revoked", { label }), "success")
      await afterChange(current)
    } catch (error) {
      showToast(t("devices.revokeFailed", { label, reason: errorReason(language, error) }), "error")
    }
  }
  const endAll = async () => {
    const ok = await confirmDialog({
      title: t("devices.endAllTitle"),
      message: t("devices.endAllMessage", { count: devices.length }),
      confirmText: t("devices.endAll"),
      danger: true,
    })
    if (!ok) return
    try {
      await api.endAllDevices()
      await afterChange(true)
    } catch (error) {
      showToast(t("devices.endAllFailed", { reason: errorReason(language, error) }), "error")
    }
  }
  return (
    <Panel
      id="devices"
      title={t("devices.title")}
      count={query.data ? devices.length : undefined}
      extra={
        devices.length ? (
          <button type="button" className="ui-more ui-text-fail" onClick={() => void endAll()}>
            {t("devices.endAll")}
          </button>
        ) : null
      }
    >
      {query.isPending ? <Loading label={t("devices.loading")} /> : null}
      {query.isError && !query.data ? (
        <ErrorState title={t("devices.failed")} error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.data && devices.length === 0 ? <Empty title={t("devices.empty")} /> : null}
      {devices.map((device) => {
        const current = device.id === session.data?.deviceId
        return (
          <div key={device.id} className="ui-item">
            <div className="ui-item-main">
              <span className="ui-item-title">
                <bdi dir="auto">{device.label}</bdi> {current ? <Tag tone="info">{t("devices.thisDevice")}</Tag> : null}
              </span>
              <span className="ui-item-meta">
                {t("devices.paired")} <Time value={device.createdAt} mode="full" /> · {t("devices.lastSeen")}{" "}
                <Time value={device.lastSeenAt} mode="ago" />
              </span>
            </div>
            <div className="ui-item-end">
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-danger"
                onClick={() => void revoke(device.id, device.label, current)}
              >
                {t("devices.revoke")}
              </button>
            </div>
          </div>
        )
      })}
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
const JOB_TONE = { sent: "ok", sending: "info", failed: "fail", unknown: "warn", skipped: "warn" } as const

function StatusPanel() {
  const { t } = useI18n()
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
        </>
      ) : telegram.data ? (
        <div className="ui-panel-body">
          <Locked title={t("settings.telegramLocked")}>{t("settings.telegramLockedBody")}</Locked>
        </div>
      ) : null}
    </Panel>
  )
}
