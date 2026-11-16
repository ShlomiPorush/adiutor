// Settings, Agent access: the agent keys left from the releases before agent access by approval. Adiutor refuses them
// on /api/v1 and /mcp and no route makes a new one; the owner sees what is left and deletes it, until the clean-up
// release removes the list with Better Auth's api-key plugin. Shown only while keys are left. Each key's name, first
// characters, when it was made and its last request; Delete removes one, Delete all every key (the plugin has no bulk
// delete, and one list answers at most 100 keys: disconnectAll.ts). Both ask first and act at once, outside the save bar.

import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { authClient, authData } from "../../api/auth.ts"
import { qk } from "../../api/endpoints.ts"
import type { AgentKey } from "../../api/types.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { confirmDialog } from "../../ui/confirm.tsx"
import { EVERY, usePageQuery } from "../../ui/refresh.ts"
import { ErrorState, errorReason } from "../../ui/states.tsx"
import { Time } from "../../ui/Time.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { disconnectEvery } from "./disconnectAll.ts"
import { Group } from "./parts.tsx"

const time = (value: Date | string) => (typeof value === "string" ? value : value.toISOString())

const listKeys = async () => (await authData(authClient.apiKey.list())).apiKeys as AgentKey[]

export function OldAgentKeys() {
  const { t, tc, language } = useI18n()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const query = usePageQuery({ queryKey: qk.agentKeys, queryFn: listKeys, every: EVERY.slow })
  const keys = [...(query.data ?? [])].sort((a, b) => time(b.createdAt).localeCompare(time(a.createdAt)))
  const label = (key: AgentKey) => key.name ?? key.start ?? key.id
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.agentKeys })

  const remove = async (key: AgentKey) => {
    const name = label(key)
    const ok = await confirmDialog({
      title: t("agentKeys.deleteTitle", { name }),
      message: t("agentKeys.deleteMessage"),
      confirmText: t("agentKeys.delete"),
      danger: true,
    })
    if (!ok) return
    try {
      await authData(authClient.apiKey.delete({ keyId: key.id }))
      showToast(t("agentKeys.deleted", { name }), "success")
    } catch (error) {
      showToast(t("agentKeys.deleteFailed", { name, reason: errorReason(language, error) }), "error")
    }
    await refresh()
  }

  const removeAll = async () => {
    const ok = await confirmDialog({
      title: t("agentKeys.deleteAllTitle"),
      message: tc("agentKeys.deleteAllMessage", keys.length),
      confirmText: t("agentKeys.deleteAll"),
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      // Lists again until the list is empty: one list answers at most 100 keys.
      const { remaining, atLeast } = await disconnectEvery(listKeys, async (keyId) => {
        await authData(authClient.apiKey.delete({ keyId }))
      })
      if (remaining === 0) showToast(t("agentKeys.deletedAll"), "success")
      else showToast(tc(atLeast ? "agentKeys.deleteAllFailedAtLeast" : "agentKeys.deleteAllFailed", remaining), "error")
    } catch (error) {
      showToast(t("agentKeys.deleteAllError", { reason: errorReason(language, error) }), "error")
    } finally {
      setBusy(false)
    }
    await refresh()
  }

  // Nothing to show while nothing is left (or before the list arrived).
  if (query.isError && !query.data)
    return <ErrorState title={t("agentKeys.failed")} error={query.error} onRetry={() => void query.refetch()} />
  if (keys.length === 0) return null
  return (
    <Group
      id="settings-agent-keys"
      title={t("agentKeys.oldTitle")}
      count={keys.length}
      intro={t("agentKeys.oldNote")}
      extra={
        keys.length > 1 ? (
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-danger"
            disabled={busy}
            onClick={() => void removeAll()}
          >
            {t("agentKeys.deleteAll")}
          </button>
        ) : null
      }
    >
      {keys.map((key) => (
        <div key={key.id} className="ui-item" data-testid="old-agent-key">
          <div className="ui-item-main">
            <span className="ui-item-title">
              <bdi dir="auto">{key.name ?? t("agentKeys.unnamed")}</bdi>{" "}
              <bdi className="ui-mono ui-key-start" dir="ltr">
                {key.start ? `${key.start}…` : ""}
              </bdi>
            </span>
            <span className="ui-item-meta">
              {t("agentKeys.created")} <Time value={time(key.createdAt)} mode="full" /> · {t("agentKeys.lastUsed")}{" "}
              {key.lastRequest ? <Time value={time(key.lastRequest)} mode="ago" /> : t("agentKeys.never")}
            </span>
          </div>
          <div className="ui-item-end">
            <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" onClick={() => void remove(key)}>
              {t("agentKeys.delete")}
            </button>
          </div>
        </div>
      ))}
    </Group>
  )
}
