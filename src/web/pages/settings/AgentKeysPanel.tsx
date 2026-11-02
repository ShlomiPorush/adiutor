// Settings, Agent access: the agents connected with `mikud connect`, each with its own key of Better Auth's api-key
// plugin, through its client. The owner approves every connection in the browser (/connect/device); the key itself
// never reaches this page. The list shows each key's name, first characters, when it was connected, when it ends and
// its last request. Disconnect deletes one key, Disconnect all deletes every key (the plugin has no bulk delete, and
// one list answers at most 100 keys: disconnectAll.ts); both ask first and act at once, outside the save bar.

import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { authClient, authData } from "../../api/auth.ts"
import { qk } from "../../api/endpoints.ts"
import type { AgentKey } from "../../api/types.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { Copyable } from "../../ui/Copyable.tsx"
import { confirmDialog } from "../../ui/confirm.tsx"
import { EVERY, usePageQuery } from "../../ui/refresh.ts"
import { Empty, ErrorState, errorReason, Loading } from "../../ui/states.tsx"
import { Time } from "../../ui/Time.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tag } from "../../ui/tags.tsx"
import { Panel } from "../parts.tsx"
import { disconnectEvery } from "./disconnectAll.ts"

const time = (value: Date | string) => (typeof value === "string" ? value : value.toISOString())

/** The sync bundle's path inside the Mikud checkout on the owner's computer. */
const BUNDLE = "node dist/sync/mikud-sync.js"

/** The connect command for one target, with this page's own address. */
export function connectCommand(origin: string, name: string, target: "sync" | "claude" | "codex"): string {
  return `${BUNDLE} connect --url ${origin} --name ${name} --for ${target}`
}

export function AgentKeysPanel() {
  const { t, tc, language } = useI18n()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const query = usePageQuery({
    queryKey: qk.agentKeys,
    queryFn: async () => (await authData(authClient.apiKey.list())).apiKeys as AgentKey[],
    every: EVERY.slow,
  })
  const keys = [...(query.data ?? [])].sort((a, b) => time(b.createdAt).localeCompare(time(a.createdAt)))
  const origin = window.location.origin
  const label = (key: AgentKey) => key.name ?? key.start ?? key.id

  const disconnect = async (key: AgentKey) => {
    const name = label(key)
    const ok = await confirmDialog({
      title: t("agentKeys.disconnectTitle", { name }),
      message: t("agentKeys.disconnectMessage"),
      confirmText: t("agentKeys.disconnect"),
      danger: true,
    })
    if (!ok) return
    try {
      await authData(authClient.apiKey.delete({ keyId: key.id }))
      showToast(t("agentKeys.disconnected", { name }), "success")
    } catch (error) {
      showToast(t("agentKeys.disconnectFailed", { name, reason: errorReason(language, error) }), "error")
    }
    await queryClient.invalidateQueries({ queryKey: qk.agentKeys })
  }

  const disconnectAll = async () => {
    const count = keys.length
    const ok = await confirmDialog({
      title: t("agentKeys.disconnectAllTitle"),
      message: tc("agentKeys.disconnectAllMessage", count),
      confirmText: t("agentKeys.disconnectAll"),
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      // Lists again until the list is empty: one list answers at most 100 keys.
      const { remaining } = await disconnectEvery(
        async () => (await authData(authClient.apiKey.list())).apiKeys as AgentKey[],
        async (keyId) => {
          await authData(authClient.apiKey.delete({ keyId }))
        },
      )
      if (remaining === 0) showToast(t("agentKeys.disconnectedAll"), "success")
      else showToast(tc("agentKeys.disconnectAllFailed", remaining), "error")
    } catch (error) {
      showToast(t("agentKeys.disconnectAllError", { reason: errorReason(language, error) }), "error")
    } finally {
      setBusy(false)
    }
    await queryClient.invalidateQueries({ queryKey: qk.agentKeys })
  }

  return (
    <Panel id="agents" title={t("agentKeys.title")} count={query.data ? keys.length : undefined}>
      <p className="ui-panel-body ui-hint">{t("agentKeys.hint")}</p>
      <div className="ui-panel-body ui-connect-cmds">
        <div>
          <h3 className="ui-h3">{t("agentKeys.howTitle")}</h3>
          <p className="ui-hint">{t("agentKeys.howHint")}</p>
        </div>
        {(["sync", "claude", "codex"] as const).map((target) => (
          <div key={target} className="ui-field">
            <span className="ui-label">{t(`agentKeys.how.${target}`)}</span>
            <span dir="ltr">
              <Copyable value={connectCommand(origin, target, target)} />
            </span>
          </div>
        ))}
        <p className="ui-hint">{t("agentKeys.howOptions", { name: "--name", days: "--days" })}</p>
      </div>
      {query.isPending ? <Loading label={t("agentKeys.loading")} /> : null}
      {query.isError && !query.data ? (
        <ErrorState title={t("agentKeys.failed")} error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.data && keys.length === 0 ? <Empty title={t("agentKeys.empty")} hint={t("agentKeys.emptyHint")} /> : null}
      {keys.map((key) => {
        const expired = key.expiresAt !== null && new Date(key.expiresAt).getTime() <= Date.now()
        return (
          <div key={key.id} className="ui-item">
            <div className="ui-item-main">
              <span className="ui-item-title">
                <bdi dir="auto">{key.name ?? t("agentKeys.unnamed")}</bdi>{" "}
                <bdi className="ui-mono ui-key-start" dir="ltr">
                  {key.start ? `${key.start}…` : ""}
                </bdi>{" "}
                {expired ? <Tag tone="fail">{t("agentKeys.expired")}</Tag> : null}
              </span>
              <span className="ui-item-meta">
                {t("agentKeys.created")} <Time value={time(key.createdAt)} mode="full" /> · {t("agentKeys.expires")}{" "}
                {key.expiresAt ? <Time value={time(key.expiresAt)} mode="full" /> : t("agentKeys.noEnd")} ·{" "}
                {t("agentKeys.lastUsed")}{" "}
                {key.lastRequest ? <Time value={time(key.lastRequest)} mode="ago" /> : t("agentKeys.never")}
              </span>
            </div>
            <div className="ui-item-end">
              <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" onClick={() => void disconnect(key)}>
                {t("agentKeys.disconnect")}
              </button>
            </div>
          </div>
        )
      })}
      {keys.length > 1 ? (
        <div className="ui-panel-body ui-account-actions">
          <button type="button" className="ui-btn ui-btn-danger" disabled={busy} onClick={() => void disconnectAll()}>
            {t("agentKeys.disconnectAll")}
          </button>
        </div>
      ) : null}
    </Panel>
  )
}
