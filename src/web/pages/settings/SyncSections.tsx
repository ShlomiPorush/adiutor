// Settings, Sync: Status (the last T3 sync, its outcome and when security data came in; read only, the sync runs on
// the owner's PC) as a facts grid (FS-8), and Suppressions (what the sync may not recreate): each removable after a
// question, and Remove all at the end of the list's head (S-12), which asks first and names the count (DS-20, FW-8).

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, qk } from "../../api/endpoints.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { Copyable } from "../../ui/Copyable.tsx"
import { confirmDialog } from "../../ui/confirm.tsx"
import { EVERY, usePageQuery } from "../../ui/refresh.ts"
import { Empty, ErrorState, errorReason, Loading } from "../../ui/states.tsx"
import { Time } from "../../ui/Time.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tag } from "../../ui/tags.tsx"
import { Fact, Facts, Group } from "./parts.tsx"

const OUTCOME_TONE = { succeeded: "ok", partial: "warn", failed: "fail" } as const

export function StatusSection() {
  const { t } = useI18n()
  const morning = useQuery({ queryKey: qk.morning, queryFn: api.morning, staleTime: EVERY.live })
  const runs = usePageQuery({ queryKey: qk.syncRuns, queryFn: api.syncRuns, every: EVERY.slow })
  const sync = morning.data?.sync
  const lastT3 = runs.data?.find((run) => run.kind === "t3" && run.outcome)
  return (
    <Group id="settings-sync" title={t("settings.groupTitles.status")}>
      <Facts>
        <Fact label={t("settings.lastSync")}>
          {sync?.lastSuccessAt ? <Time value={sync.lastSuccessAt} mode="full" /> : sync ? t("sync.never") : "-"}
          {sync?.stale ? <Tag tone="warn">{t("security.stale")}</Tag> : null}
        </Fact>
        <Fact label={t("settings.lastOutcome")}>
          {lastT3?.outcome ? (
            <>
              <Tag tone={OUTCOME_TONE[lastT3.outcome]}>{t(`settings.outcome.${lastT3.outcome}`)}</Tag>
              <Time value={lastT3.finishedAt ?? lastT3.startedAt} />
            </>
          ) : (
            "-"
          )}
        </Fact>
        <Fact label={t("settings.securityAsOf")}>
          {sync?.securityLastSuccessAt ? (
            <Time value={sync.securityLastSuccessAt} mode="full" />
          ) : (
            t("security.asOfUnknown")
          )}
        </Fact>
      </Facts>
    </Group>
  )
}

/** Removes each suppression in turn; the number that could not be removed. */
export async function removeEvery(ids: readonly string[], remove: (id: string) => Promise<void>): Promise<number> {
  let failed = 0
  for (const id of ids) {
    try {
      await remove(id)
    } catch {
      failed++
    }
  }
  return failed
}

export function SuppressionsSection() {
  const { t, tc, language } = useI18n()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
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
  const removeAll = async () => {
    const ids = list.map((entry) => entry.id)
    const ok = await confirmDialog({
      title: t("suppressions.removeAllTitle"),
      message: tc("suppressions.removeAllMessage", ids.length),
      confirmText: t("suppressions.removeAll"),
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      const failed = await removeEvery(ids, async (id) => {
        await api.deleteSuppression(id)
      })
      if (failed === 0) showToast(tc("suppressions.removedAll", ids.length), "success")
      else showToast(tc("suppressions.removeAllFailed", failed), "error")
    } finally {
      setBusy(false)
    }
    await queryClient.invalidateQueries({ queryKey: qk.suppressions })
  }
  return (
    <Group
      id="settings-suppressed"
      title={t("settings.groupTitles.suppressed")}
      count={query.data ? list.length : undefined}
      extra={
        list.length > 1 ? (
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-danger"
            disabled={busy}
            onClick={() => void removeAll()}
          >
            {t("suppressions.removeAll")}
          </button>
        ) : null
      }
    >
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
    </Group>
  )
}
