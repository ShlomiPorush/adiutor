// Settings, Agent access: the agent keys of Better Auth's api-key plugin, through its client. A key is shown once,
// when it is created; the list shows its first characters only. Revoke deletes the key after a question. Acts at
// once, outside the save bar.

import { useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useId, useState } from "react"
import { AGENT_KEY_NAME_MAX } from "../../../shared/auth.ts"
import { authClient, authData } from "../../api/auth.ts"
import { qk } from "../../api/endpoints.ts"
import type { AgentKey } from "../../api/types.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { Copyable } from "../../ui/Copyable.tsx"
import { confirmDialog, useDiscardGuard } from "../../ui/confirm.tsx"
import { Dialog } from "../../ui/Dialog.tsx"
import { EVERY, usePageQuery } from "../../ui/refresh.ts"
import { Empty, ErrorState, errorReason, Loading } from "../../ui/states.tsx"
import { Time } from "../../ui/Time.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { FormError } from "../auth/parts.tsx"
import { Panel } from "../parts.tsx"

const time = (value: Date | string) => (typeof value === "string" ? value : value.toISOString())

export function AgentKeysPanel() {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const query = usePageQuery({
    queryKey: qk.agentKeys,
    queryFn: async () => (await authData(authClient.apiKey.list())).apiKeys as AgentKey[],
    every: EVERY.slow,
  })
  const keys = query.data ?? []

  const revoke = async (key: AgentKey) => {
    const name = key.name ?? key.start ?? key.id
    const ok = await confirmDialog({
      title: t("agentKeys.revokeTitle", { name }),
      message: t("agentKeys.revokeMessage"),
      confirmText: t("agentKeys.revoke"),
      danger: true,
    })
    if (!ok) return
    try {
      await authData(authClient.apiKey.delete({ keyId: key.id }))
      showToast(t("agentKeys.revoked", { name }), "success")
      await queryClient.invalidateQueries({ queryKey: qk.agentKeys })
    } catch (error) {
      showToast(t("agentKeys.revokeFailed", { name, reason: errorReason(language, error) }), "error")
    }
  }

  return (
    <Panel
      id="agents"
      title={t("agentKeys.title")}
      count={query.data ? keys.length : undefined}
      extra={
        <button type="button" className="ui-more" onClick={() => setCreating(true)}>
          {t("agentKeys.create")}
        </button>
      }
    >
      <p className="ui-panel-body ui-hint">{t("agentKeys.hint")}</p>
      {query.isPending ? <Loading label={t("agentKeys.loading")} /> : null}
      {query.isError && !query.data ? (
        <ErrorState title={t("agentKeys.failed")} error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.data && keys.length === 0 ? <Empty title={t("agentKeys.empty")} hint={t("agentKeys.emptyHint")} /> : null}
      {keys.map((key) => (
        <div key={key.id} className="ui-item">
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
            <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" onClick={() => void revoke(key)}>
              {t("agentKeys.revoke")}
            </button>
          </div>
        </div>
      ))}
      {creating ? <CreateKeyDialog onClose={() => setCreating(false)} /> : null}
    </Panel>
  )
}

/** A name, then the new key shown once with Copy. */
function CreateKeyDialog({ onClose }: { onClose: () => void }) {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const nameId = useId()
  const formId = useId()
  const [name, setName] = useState("")
  const [key, setKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guardedClose = useDiscardGuard(Boolean(name.trim()) && !key, onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t("agentKeys.nameRequired"))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await authData(authClient.apiKey.create({ name: trimmed }))
      setKey(created.key)
      await queryClient.invalidateQueries({ queryKey: qk.agentKeys })
    } catch (failure) {
      setError(t("agentKeys.createFailed", { reason: errorReason(language, failure) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={key ? t("agentKeys.createdTitle") : t("agentKeys.createTitle")}
      size="sm"
      onClose={key ? onClose : () => void guardedClose()}
      foot={
        key ? (
          <button type="button" className="ui-btn ui-btn-primary" onClick={onClose}>
            {t("agentKeys.done")}
          </button>
        ) : (
          <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy}>
            {busy ? t("agentKeys.creating") : t("agentKeys.createSubmit")}
          </button>
        )
      }
    >
      {key ? (
        <div className="ui-form-stack">
          <p className="ui-hint">{t("agentKeys.showOnce")}</p>
          <span className="ui-secret" data-testid="agent-key">
            <Copyable value={key} />
          </span>
          <p className="ui-hint">{t("agentKeys.useIt")}</p>
        </div>
      ) : (
        <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
          <div className="ui-field">
            <label className="ui-label" htmlFor={nameId}>
              {t("agentKeys.name")}
            </label>
            <input
              id={nameId}
              className="ui-input"
              maxLength={AGENT_KEY_NAME_MAX}
              value={name}
              aria-invalid={error ? true : undefined}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
            <p className="ui-hint">{t("agentKeys.nameHint")}</p>
          </div>
          {error ? <FormError>{error}</FormError> : null}
        </form>
      )}
    </Dialog>
  )
}
