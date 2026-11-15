// The Passkeys group of the Account page: every passkey with its name and when it was added, Rename and Remove on each,
// and Add a passkey at the end of the head. All of it is Better Auth's passkey plugin through its client. Adding needs a
// browser that supports passkeys; listing, renaming and removing do not, so a lost passkey can always be removed.

import { useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useId, useState } from "react"
import { PASSKEY_MAX, PASSKEY_NAME_MAX } from "../../shared/auth.ts"
import {
  type AuthError,
  authClient,
  authData,
  FAILURE_TEXT,
  PASSKEY_FAILURE_TEXT,
  passkeyFailure,
  passkeysSupported,
} from "../api/auth.ts"
import { qk } from "../api/endpoints.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { confirmDialog, useDiscardGuard } from "../ui/confirm.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { Empty, ErrorState, errorReason, Loading } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { FormError } from "./auth/parts.tsx"
import { Group } from "./settings/parts.tsx"

type Passkey = { id: string; name?: string | null; createdAt: Date | string }

const time = (value: Date | string) => (typeof value === "string" ? value : value.toISOString())
const validName = (name: string) => name.trim().length > 0 && name.trim().length <= PASSKEY_NAME_MAX

type Translate = (key: string, values?: Record<string, string | number>) => string

/** The sentence for a failed passkey call: closed in the browser, already on this device, or the server's reason. */
function failureText(t: Translate, answer: AuthError, during: "add" | "change"): string {
  const failure = passkeyFailure(answer)
  if (
    failure === "passkey_cancelled" ||
    failure === "passkey_registered" ||
    failure === "passkey_address" ||
    failure === "passkey_unsuitable"
  )
    return t(PASSKEY_FAILURE_TEXT[failure])
  if (failure !== "other" && failure !== "wrong_password" && failure !== "passkey_failed")
    return t(FAILURE_TEXT[failure])
  const reason = answer?.message || String(answer?.status ?? "")
  return during === "add" ? t("account.passkeyAddFailed", { reason }) : t("account.passkeyFailed", { reason })
}

export function PasskeysGroup() {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const supported = passkeysSupported()
  const query = usePageQuery({
    queryKey: qk.passkeys,
    queryFn: () => authData(authClient.passkey.listUserPasskeys()) as Promise<Passkey[]>,
    every: EVERY.slow,
  })
  const [dialog, setDialog] = useState<{ kind: "add" } | { kind: "rename"; passkey: Passkey } | null>(null)
  const passkeys = [...(query.data ?? [])].sort((a, b) => time(b.createdAt).localeCompare(time(a.createdAt)))
  const full = passkeys.length >= PASSKEY_MAX
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.passkeys })
  const label = (passkey: Passkey) => passkey.name?.trim() || t("account.passkeys")

  const remove = async (passkey: Passkey) => {
    const name = label(passkey)
    const ok = await confirmDialog({
      title: t("account.passkeyRemoveTitle", { name }),
      message: t("account.passkeyRemoveMessage"),
      confirmText: t("account.passkeyRemove"),
      danger: true,
    })
    if (!ok) return
    try {
      await authData(authClient.passkey.deletePasskey({ id: passkey.id }))
      showToast(t("account.passkeyRemoveDone", { name }), "success")
    } catch (error) {
      showToast(t("account.passkeyFailed", { reason: errorReason(language, error) }), "error")
    }
    await refresh()
  }

  return (
    <Group
      id="account-passkeys"
      heading="h2"
      title={t("account.passkeys")}
      count={query.data ? passkeys.length : undefined}
      intro={t("account.passkeysHint")}
      extra={
        supported && query.data && !full ? (
          <button type="button" className="ui-btn ui-btn-sm" onClick={() => setDialog({ kind: "add" })}>
            {t("account.passkeyAdd")}
          </button>
        ) : null
      }
    >
      {query.isPending ? <Loading label={t("account.loading")} /> : null}
      {query.isError && !query.data ? (
        <ErrorState title={t("account.passkeysFailed")} error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {!supported ? <p className="ui-hint">{t("account.passkeysUnsupported")}</p> : null}
      {supported && full ? <p className="ui-hint">{t("account.passkeysFull", { max: PASSKEY_MAX })}</p> : null}
      {query.data && passkeys.length === 0 ? <Empty title={t("account.passkeysEmpty")} /> : null}
      {passkeys.map((passkey) => (
        <div key={passkey.id} className="ui-item">
          <div className="ui-item-main">
            <span className="ui-item-title">
              <bdi dir="auto">{label(passkey)}</bdi>
            </span>
            <span className="ui-item-meta">
              {t("account.passkeyAdded")} <Time value={time(passkey.createdAt)} mode="full" />
            </span>
          </div>
          <div className="ui-item-end">
            <button type="button" className="ui-btn ui-btn-sm" onClick={() => setDialog({ kind: "rename", passkey })}>
              {t("account.passkeyRename")}
            </button>
            <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" onClick={() => void remove(passkey)}>
              {t("account.passkeyRemove")}
            </button>
          </div>
        </div>
      ))}
      {dialog ? (
        <NameDialog
          passkey={dialog.kind === "rename" ? dialog.passkey : null}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null)
            await refresh()
          }}
        />
      ) : null}
    </Group>
  )
}

/**
 * Add a passkey (a name, then the browser's own prompt) or rename one. A refusal keeps the dialog open with its
 * reason; closing it with a name typed asks first.
 */
function NameDialog({
  passkey,
  onClose,
  onDone,
}: {
  passkey: Passkey | null
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const { t } = useI18n()
  const formId = useId()
  const nameId = useId()
  const initial = passkey?.name ?? ""
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guardedClose = useDiscardGuard(name !== initial, onClose)
  const adding = passkey === null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!validName(name)) {
      setError(t("account.passkeyNameInvalid", { max: PASSKEY_NAME_MAX }))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { error: answer } = adding
        ? await authClient.passkey.addPasskey({ name: name.trim() })
        : await authClient.passkey.updatePasskey({ id: passkey.id, name: name.trim() })
      if (answer) {
        setError(failureText(t, answer, adding ? "add" : "change"))
        return
      }
      guardedClose.dismiss()
      showToast(adding ? t("account.passkeyAddDone") : t("account.passkeyRenameDone"), "success")
      await onDone()
    } catch {
      setError(t("auth.error.network"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={adding ? t("account.passkeyAddTitle") : t("account.passkeyRenameTitle")}
      size="sm"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy}>
          {adding
            ? busy
              ? t("account.passkeyAddBusy")
              : t("account.passkeyAddSubmit")
            : busy
              ? t("account.passkeyRenameBusy")
              : t("account.passkeyRenameSubmit")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        {adding ? <p className="ui-hint">{t("account.passkeyAddHint")}</p> : null}
        <div className="ui-field">
          <label className="ui-label" htmlFor={nameId}>
            {t("account.passkeyName")}
          </label>
          <input
            id={nameId}
            className="ui-input"
            dir="auto"
            autoComplete="off"
            maxLength={PASSKEY_NAME_MAX}
            value={name}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        </div>
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Dialog>
  )
}
