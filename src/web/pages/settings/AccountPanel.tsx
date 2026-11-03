// Settings, Account: everything here is Better Auth's own routes through its client, and acts at once (outside the
// save bar): the signed-in browsers (and a session `mikud connect` left behind) with sign out one of them, sign out
// the others and sign out everywhere, the password, a new
// authenticator, new backup codes and the recovery note. Signing out of this browser is in the shell's account menu.

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useId, useState } from "react"
import { useNavigate } from "react-router"
import { CONNECT_CLIENT_ID, PASSWORD_MAX, PASSWORD_MIN, passwordSchema } from "../../../shared/auth.ts"
import { AuthCallError, type AuthError, authClient, authData, authFailure, FAILURE_TEXT } from "../../api/auth.ts"
import { api, qk } from "../../api/endpoints.ts"
import type { BrowserSession } from "../../api/types.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { useSignedOut } from "../../shell/signOut.ts"
import { Copyable } from "../../ui/Copyable.tsx"
import { confirmDialog, useDiscardGuard } from "../../ui/confirm.tsx"
import { Dialog } from "../../ui/Dialog.tsx"
import { EVERY, usePageQuery } from "../../ui/refresh.ts"
import { ErrorState, errorReason, Loading } from "../../ui/states.tsx"
import { Time } from "../../ui/Time.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tag } from "../../ui/tags.tsx"
import { describeAgent } from "../agent.ts"
import { RECOVERY_COMMAND } from "../auth/LoginPage.tsx"
import { BackupCodes, FormError, PasswordField } from "../auth/parts.tsx"
import { Panel } from "../parts.tsx"

/** "Sign out everywhere": asks first, then Better Auth's revokeSessions and on to sign-in. */
export function useSignOutEverywhere() {
  const { t, language } = useI18n()
  const signedOut = useSignedOut()
  return async () => {
    const ok = await confirmDialog({
      title: t("account.endAllTitle"),
      message: t("account.endAllMessage"),
      confirmText: t("account.endAll"),
      danger: true,
    })
    if (!ok) return
    try {
      await authData(authClient.revokeSessions())
      signedOut()
    } catch (error) {
      showToast(t("account.endFailed", { reason: errorReason(language, error) }), "error")
    }
  }
}

const time = (value: Date | string) => (typeof value === "string" ? value : value.toISOString())

export function AccountPanel() {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const signOutEverywhere = useSignOutEverywhere()
  const navigate = useNavigate()
  const me = useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: Number.POSITIVE_INFINITY })
  const current = authClient.useSession().data?.session.id
  const query = usePageQuery({
    queryKey: qk.account,
    queryFn: () => authData(authClient.listSessions()) as Promise<BrowserSession[]>,
    every: EVERY.slow,
  })
  const [dialog, setDialog] = useState<"codes" | "authenticator" | null>(null)
  const sessions = [...(query.data ?? [])].sort(
    (a, b) => Number(b.id === current) - Number(a.id === current) || time(b.createdAt).localeCompare(time(a.createdAt)),
  )

  /** One other session: Better Auth's revokeSession with that session's token. */
  const endOne = async (session: BrowserSession, name: string) => {
    const ok = await confirmDialog({
      title: t("account.endOneTitle", { name }),
      message: t("account.endOneMessage"),
      confirmText: t("account.endOne"),
      danger: true,
    })
    if (!ok) return
    try {
      await authData(authClient.revokeSession({ token: session.token }))
      showToast(t("account.endOneDone", { name }), "success")
    } catch (error) {
      showToast(t("account.endFailed", { reason: errorReason(language, error) }), "error")
    }
    await queryClient.invalidateQueries({ queryKey: qk.account })
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
      await authData(authClient.revokeOtherSessions())
      showToast(t("account.endOthersDone"), "success")
      await queryClient.invalidateQueries({ queryKey: qk.account })
    } catch (error) {
      showToast(t("account.endFailed", { reason: errorReason(language, error) }), "error")
    }
  }

  return (
    <Panel id="account" title={t("account.title")}>
      <div className="ui-kv">
        <span>{t("account.signedInAs")}</span>
        <bdi className="ui-mono" dir="ltr">
          {me.data?.actor.label ?? "-"}
        </bdi>
      </div>
      <div className="ui-panel-body">
        <h3 className="ui-h3">{t("account.sessions")}</h3>
        <p className="ui-hint">{t("account.sessionsHint")}</p>
      </div>
      {query.isPending ? <Loading label={t("account.loading")} /> : null}
      {query.isError && !query.data ? (
        <ErrorState title={t("account.failed")} error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {sessions.map((session) => {
        const agent = describeAgent(session.userAgent ?? null)
        const connecting = session.userAgent === CONNECT_CLIENT_ID
        const name = connecting
          ? t("account.connectSession")
          : agent
            ? t("account.browserOn", agent)
            : t("account.unknownBrowser")
        return (
          <div key={session.id} className="ui-item">
            <div className="ui-item-main">
              <span className="ui-item-title">
                <bdi dir="auto">{name}</bdi>{" "}
                {session.id === current ? <Tag tone="info">{t("account.thisBrowser")}</Tag> : null}
              </span>
              <span className="ui-item-meta">
                {connecting ? `${t("account.connectSessionHint")} ` : ""}
                {t("account.signedIn")} <Time value={time(session.createdAt)} mode="full" /> · {t("account.until")}{" "}
                <Time value={time(session.expiresAt)} mode="full" />
              </span>
            </div>
            {session.id !== current ? (
              <div className="ui-item-end">
                <button
                  type="button"
                  className="ui-btn ui-btn-sm ui-btn-danger"
                  onClick={() => void endOne(session, name)}
                >
                  {t("account.endOne")}
                </button>
              </div>
            ) : null}
          </div>
        )
      })}
      <div className="ui-panel-body ui-account-actions">
        {sessions.length > 1 ? (
          <button type="button" className="ui-btn ui-btn-danger" onClick={() => void endOthers()}>
            {t("account.endOthers")}
          </button>
        ) : null}
        <button type="button" className="ui-btn ui-btn-danger" onClick={() => void signOutEverywhere()}>
          {t("account.endAll")}
        </button>
      </div>
      <PasswordForm />
      <div className="ui-panel-body ui-account-form">
        <div>
          <h3 className="ui-h3">{t("account.twoFactor")}</h3>
          <p className="ui-hint">{t("account.twoFactorHint")}</p>
        </div>
        <div className="ui-account-actions">
          <button type="button" className="ui-btn" onClick={() => setDialog("codes")}>
            {t("account.newCodes")}
          </button>
          <button type="button" className="ui-btn" onClick={() => setDialog("authenticator")}>
            {t("account.newAuthenticator")}
          </button>
        </div>
      </div>
      <div className="ui-panel-body ui-auth-note">
        <h3 className="ui-h3">{t("account.recovery")}</h3>
        <p className="ui-hint">{t("account.recoveryHint")}</p>
        <Copyable value={RECOVERY_COMMAND} />
      </div>
      {dialog === "codes" ? <NewCodesDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "authenticator" ? (
        <NewAuthenticatorDialog
          onClose={() => setDialog(null)}
          onDisabled={() => {
            setDialog(null)
            navigate("/setup?next=%2Fsettings", { replace: true })
          }}
        />
      ) : null}
    </Panel>
  )
}

const failureSentence = (t: (key: string, values?: Record<string, string | number>) => string, answer: AuthError) => {
  const failure = authFailure(answer, "password")
  return failure === "other"
    ? t("auth.error.failed", { reason: answer?.message || String(answer?.status ?? "") })
    : failure === "wrong_password"
      ? t("account.wrongCurrent")
      : t(FAILURE_TEXT[failure])
}

/** Change password: the current one, the new one twice. Better Auth signs out the other browsers; this one stays. */
function PasswordForm() {
  const { t } = useI18n()
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
      const { error: answer } = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      })
      if (answer) {
        const wrong = authFailure(answer, "password") === "wrong_password"
        if (wrong) setCurrent("")
        setError({ field: wrong ? "current" : null, text: failureSentence(t, answer) })
        return
      }
      setCurrent("")
      setNext("")
      setRepeat("")
      showToast(t("account.changed"), "success")
      await queryClient.invalidateQueries({ queryKey: qk.account })
    } catch {
      setError({ field: null, text: t("auth.error.network") })
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

/** New backup codes: the password, then the ten new codes shown once; the old ones stop working. */
function NewCodesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const formId = useId()
  const [password, setPassword] = useState("")
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guardedClose = useDiscardGuard(Boolean(password) && !codes, onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { data, error: answer } = await authClient.twoFactor.generateBackupCodes({ password })
      if (answer || !data) {
        setError(failureSentence(t, answer))
        return
      }
      setPassword("")
      setCodes(data.backupCodes)
    } catch {
      setError(t("auth.error.network"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("account.newCodesTitle")}
      size="sm"
      onClose={codes ? onClose : () => void guardedClose()}
      foot={
        codes ? null : (
          <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy || !password}>
            {busy ? t("account.newCodesBusy") : t("account.newCodesSubmit")}
          </button>
        )
      }
    >
      {codes ? (
        <BackupCodes codes={codes} doneLabel={t("account.done")} onDone={onClose} />
      ) : (
        <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
          <p className="ui-hint">{t("account.newCodesHint")}</p>
          <PasswordField
            label={t("account.currentPassword")}
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            invalid={Boolean(error)}
            autoFocus
          />
          {error ? <FormError>{error}</FormError> : null}
        </form>
      )}
    </Dialog>
  )
}

/**
 * A new authenticator: Better Auth's disable with the password, then the setup page enrols the new one (the
 * account must have two-factor before Mikud answers again).
 */
function NewAuthenticatorDialog({ onClose, onDisabled }: { onClose: () => void; onDisabled: () => void }) {
  const { t } = useI18n()
  const formId = useId()
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guardedClose = useDiscardGuard(Boolean(password), onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await authData(authClient.twoFactor.disable({ password }))
      onDisabled()
    } catch (failure) {
      setError(failure instanceof AuthCallError ? failureSentence(t, failure.answer) : t("auth.error.network"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("account.newAuthenticatorTitle")}
      size="sm"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-danger" disabled={busy || !password}>
          {busy ? t("account.newAuthenticatorBusy") : t("account.newAuthenticatorSubmit")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <p className="ui-hint">{t("account.newAuthenticatorHint")}</p>
        <PasswordField
          label={t("account.currentPassword")}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          invalid={Boolean(error)}
          autoFocus
        />
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Dialog>
  )
}
