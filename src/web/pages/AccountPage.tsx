// The Account page, /account, opened from the account menu: v3 rows in groups (S-6, FS-8), Signed in, Browsers,
// Password, Two-factor and Recovery. It is the owner's own account, not a setting of the board, so it has a page of its
// own outside Settings and its draft. Everything here is Better Auth's own routes through its client, and acts at once, outside the save bar: the
// signed-in browsers (and a session `mikud connect` left behind) with Sign out per browser and, at the end of the
// list's head, Sign out other browsers and Sign out everywhere (S-12); the password changed in a dialog (FS-22, DS-9:
// it asks before dropping what was typed); new backup codes and a new authenticator, each in a dialog; and the
// recovery command. Signing out of this browser is in the shell's account menu.

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useId, useRef, useState } from "react"
import { UserRound } from "lucide-react"
import { useNavigate } from "react-router"
import { CONNECT_CLIENT_ID, PASSWORD_MAX, PASSWORD_MIN, passwordSchema } from "../../shared/auth.ts"
import { AuthCallError, type AuthError, authClient, authData, authFailure, FAILURE_TEXT } from "../api/auth.ts"
import { api, qk } from "../api/endpoints.ts"
import type { BrowserSession } from "../api/types.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { ACCOUNT_PATH } from "../shell/navigation.ts"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { useSignedOut } from "../shell/signOut.ts"
import { Copyable } from "../ui/Copyable.tsx"
import { confirmDialog, useDiscardGuard } from "../ui/confirm.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { ErrorState, errorReason, Loading } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Tag } from "../ui/tags.tsx"
import { describeAgent } from "./agent.ts"
import { RECOVERY_COMMAND } from "./auth/LoginPage.tsx"
import { BackupCodes, FormError, PasswordField } from "./auth/parts.tsx"
import { Group, Row } from "./settings/parts.tsx"

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

export function AccountPage() {
  const { t } = useI18n()
  usePageMeta(t("account.title"))
  return (
    <div className="ui-page">
      <PageHead title={t("account.title")} description={t("account.description")} icon={UserRound} />
      <div id="account" className="ui-account">
        <AccountSection />
      </div>
    </div>
  )
}

function AccountSection() {
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
  const [dialog, setDialog] = useState<"password" | "codes" | "authenticator" | null>(null)
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
    <>
      <Group id="account-signed-in" heading="h2" title={t("account.signedInGroup")}>
        <Row label={t("account.signedInAs")}>
          <bdi className="ui-mono ui-set-value" dir="ltr">
            {me.data?.actor.label ?? "-"}
          </bdi>
        </Row>
      </Group>
      <Group
        id="account-browsers" heading="h2"
        title={t("account.sessions")}
        count={query.data ? sessions.length : undefined}
        intro={t("account.sessionsHint")}
        extra={
          <>
            {sessions.length > 1 ? (
              <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" onClick={() => void endOthers()}>
                {t("account.endOthers")}
              </button>
            ) : null}
            <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" onClick={() => void signOutEverywhere()}>
              {t("account.endAll")}
            </button>
          </>
        }
      >
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
      </Group>
      <Group id="account-password" heading="h2" title={t("account.passwordGroup")}>
        <Row label={t("account.passwordRow")} hint={t("account.passwordHint")}>
          <button type="button" className="ui-btn" onClick={() => setDialog("password")}>
            {t("account.change")}
          </button>
        </Row>
      </Group>
      <Group id="account-two-factor" heading="h2" title={t("account.twoFactor")}>
        <Row label={t("account.codesRow")} hint={t("account.codesHint")}>
          <button type="button" className="ui-btn" onClick={() => setDialog("codes")}>
            {t("account.newCodes")}
          </button>
        </Row>
        <Row label={t("account.authenticatorRow")} hint={t("account.authenticatorHint")}>
          <button type="button" className="ui-btn" onClick={() => setDialog("authenticator")}>
            {t("account.newAuthenticator")}
          </button>
        </Row>
      </Group>
      <Group id="account-recovery" heading="h2" title={t("account.recovery")}>
        <Row label={t("account.recoveryRow")} hint={t("account.recoveryHint")}>
          <span className="ui-set-command" dir="ltr">
            <Copyable value={RECOVERY_COMMAND} />
          </span>
        </Row>
      </Group>
      {dialog === "password" ? <PasswordDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "codes" ? <NewCodesDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "authenticator" ? (
        <NewAuthenticatorDialog
          onClose={() => setDialog(null)}
          onDisabled={() => {
            setDialog(null)
            navigate(`/setup?next=${encodeURIComponent(ACCOUNT_PATH)}`, { replace: true })
          }}
        />
      ) : null}
    </>
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

type PasswordFieldName = "current" | "next" | "repeat"

/**
 * Change password, in a dialog (S-6): the current one, the new one twice. The page checks what it can before it
 * sends, naming and focusing the field (SV-1); Better Auth signs out the other browsers and this one stays. A refusal
 * keeps the dialog open (only the current password is emptied when it was wrong); a change closes it. Its X, Escape,
 * Back and a pull down ask before dropping what was typed (DS-9).
 */
export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const formId = useId()
  const errorId = useId()
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [repeat, setRepeat] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: PasswordFieldName | null; text: string } | null>(null)
  const currentRef = useRef<HTMLInputElement>(null)
  const nextRef = useRef<HTMLInputElement>(null)
  const repeatRef = useRef<HTMLInputElement>(null)
  const refs = { current: currentRef, next: nextRef, repeat: repeatRef }
  const guardedClose = useDiscardGuard(Boolean(current || next || repeat), onClose)

  const refuse = (field: PasswordFieldName | null, text: string) => {
    setError({ field, text })
    if (field) refs[field].current?.focus()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!current) return refuse("current", t("account.currentMissing"))
    if (!passwordSchema.safeParse(next).success)
      return refuse(
        "next",
        next.length > PASSWORD_MAX
          ? t("auth.error.passwordLong", { max: PASSWORD_MAX })
          : t("auth.error.passwordShort", { min: PASSWORD_MIN }),
      )
    if (next !== repeat) return refuse("repeat", t("auth.error.mismatch"))
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
        refuse(wrong ? "current" : null, failureSentence(t, answer))
        return
      }
      guardedClose.dismiss()
      onClose()
      showToast(t("account.changed"), "success")
      await queryClient.invalidateQueries({ queryKey: qk.account })
    } catch {
      refuse(null, t("auth.error.network"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("account.passwordTitle")}
      size="sm"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("account.changing") : t("account.change")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <p className="ui-hint">{t("account.passwordHint")}</p>
        <PasswordField
          label={t("account.currentPassword")}
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
          invalid={error?.field === "current"}
          inputRef={currentRef}
        />
        <PasswordField
          label={t("account.newPassword")}
          hint={t("auth.passwordHint", { min: PASSWORD_MIN })}
          value={next}
          onChange={setNext}
          autoComplete="new-password"
          invalid={error?.field === "next"}
          inputRef={nextRef}
        />
        <PasswordField
          label={t("account.repeatNewPassword")}
          value={repeat}
          onChange={setRepeat}
          autoComplete="new-password"
          invalid={error?.field === "repeat"}
          inputRef={repeatRef}
        />
        {error ? <FormError id={errorId}>{error.text}</FormError> : null}
      </form>
    </Dialog>
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
      guardedClose.dismiss()
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
      guardedClose.dismiss()
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
