// First run and two-factor enrolment, on Better Auth's routes. With no owner: create the account (Better Auth's
// sign-up signs it in), then set up the authenticator app, then save the backup codes. With a session of an account
// without two-factor: enrolment only. Signed in with two-factor already: on to `next`. Two-factor is required;
// there is no skipping it. Right after enrolment the page signs out every other browser (Better Auth's
// revokeOtherSessions), so a browser that signed in with the password alone does not keep a session.

import { useQuery, useQueryClient } from "@tanstack/react-query"
import QRCode from "qrcode"
import { type FormEvent, useEffect, useId, useState } from "react"
import { Navigate, useNavigate, useSearchParams } from "react-router"
import {
  authenticatorUri,
  ownerEmail,
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordSchema,
  USERNAME_MAX,
  USERNAME_MIN,
  usernameSchema,
} from "../../../shared/auth.ts"
import { type AuthError, authClient, authFailure, FAILURE_TEXT } from "../../api/auth.ts"
import { api, qk } from "../../api/endpoints.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { safeNext } from "../../shell/Root.tsx"
import { Copyable } from "../../ui/Copyable.tsx"
import { ErrorState, Loading } from "../../ui/states.tsx"
import { usePageTitle } from "../usePageTitle.ts"
import { AuthFrame, BackupCodes, type CodeAnswer, CodeField, FormError, PasswordField } from "./parts.tsx"

export function SetupPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [params] = useSearchParams()
  const next = safeNext(params.get("next"))
  const status = useQuery({ queryKey: qk.setupStatus, queryFn: api.setupStatus, retry: false })
  // The password typed in the account step starts enrolment without asking for it again.
  const [password, setPassword] = useState<string | null>(null)
  // The backup codes, once enrolment succeeded: shown before the page moves on, whatever the status says now.
  const [codes, setCodes] = useState<string[] | null>(null)
  const step = codes
    ? "codes"
    : !status.data
      ? null
      : !status.data.hasUser
        ? "account"
        : status.data.session === "enrol"
          ? "totp"
          : null
  usePageTitle(step === "totp" ? t("setup.totpTitle") : step === "codes" ? t("setup.codesTitle") : t("setup.title"))

  if (codes)
    return (
      <AuthFrame title={t("setup.codesTitle")} description={t("setup.codesDescription")} above={<Steps current={2} />}>
        <BackupCodes
          codes={codes}
          doneLabel={t("setup.continue")}
          onDone={() => {
            void queryClient.resetQueries().then(() => navigate(next, { replace: true }))
          }}
        />
      </AuthFrame>
    )
  if (status.isPending) return <Loading label={t("app.loading")} />
  if (status.isError)
    return (
      <div className="ui-auth">
        <ErrorState title={t("setup.loadFailed")} error={status.error} onRetry={() => void status.refetch()} />
      </div>
    )
  if (status.data.session === "active") return <Navigate to={next} replace />
  if (!step) return <Navigate to={next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`} replace />

  const steps = <Steps current={step === "account" ? 0 : 1} />
  if (step === "account")
    return (
      <AuthFrame title={t("setup.title")} description={t("setup.description")} above={steps}>
        <AccountStep
          onCreated={async (typed) => {
            setPassword(typed)
            await status.refetch()
          }}
        />
      </AuthFrame>
    )
  return (
    <AuthFrame title={t("setup.totpTitle")} description={t("setup.totpDescription")} above={steps}>
      <TotpStep known={password} onEnrolled={setCodes} />
    </AuthFrame>
  )
}

function Steps({ current }: { current: number }) {
  const { t } = useI18n()
  const names = [t("setup.stepAccount"), t("setup.stepTotp"), t("setup.stepCodes")]
  return (
    <ol className="ui-steps" aria-label={t("setup.steps")}>
      {names.map((name, index) => (
        <li key={name} aria-current={index === current ? "step" : undefined} data-done={index < current || undefined}>
          <span className="ui-step-n" aria-hidden="true">
            {index + 1}
          </span>
          {name}
          {index < current ? <span className="ui-sr-only"> ({t("setup.stepDone")})</span> : null}
        </li>
      ))}
    </ol>
  )
}

function AccountStep({ onCreated }: { onCreated: (password: string) => Promise<void> }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const usernameId = useId()
  const usernameHintId = useId()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [repeat, setRepeat] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: "username" | "password" | "repeat" | null; text: string } | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    // The same rules Better Auth applies (src/shared/auth.ts); what was typed is sent as it is.
    if (!usernameSchema.safeParse(username).success)
      return setError({
        field: "username",
        text: t("auth.error.usernameInvalid", { min: USERNAME_MIN, max: USERNAME_MAX }),
      })
    if (!passwordSchema.safeParse(password).success)
      return setError({
        field: "password",
        text:
          password.length > PASSWORD_MAX
            ? t("auth.error.passwordLong", { max: PASSWORD_MAX })
            : t("auth.error.passwordShort", { min: PASSWORD_MIN }),
      })
    if (password !== repeat) return setError({ field: "repeat", text: t("auth.error.mismatch") })
    setBusy(true)
    setError(null)
    try {
      const { error: answer } = await authClient.signUp.email({
        name: username,
        email: ownerEmail(username),
        username,
        displayUsername: username,
        password,
      })
      if (answer) {
        if (answer.code === "ALREADY_SET_UP") {
          navigate("/login", { replace: true })
          return
        }
        const failure = authFailure(answer, "password")
        setError({
          field: null,
          text:
            failure === "rate_limited" || failure === "network" || failure === "server"
              ? t(FAILURE_TEXT[failure])
              : t("auth.error.failed", { reason: answer.message || String(answer.status ?? "") }),
        })
        return
      }
      await onCreated(password)
    } catch {
      setError({ field: null, text: t("auth.error.network") })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ui-form-stack" onSubmit={submit} noValidate>
      <div className="ui-field">
        <label className="ui-label" htmlFor={usernameId}>
          {t("auth.username")}
        </label>
        <input
          id={usernameId}
          className="ui-input"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          dir="ltr"
          maxLength={USERNAME_MAX}
          value={username}
          readOnly={busy}
          aria-invalid={error?.field === "username" ? true : undefined}
          aria-describedby={usernameHintId}
          onChange={(event) => setUsername(event.target.value)}
          // biome-ignore lint/a11y/noAutofocus: the setup page has one job; the username is where it starts
          autoFocus
        />
        <p id={usernameHintId} className="ui-hint">
          {t("auth.usernameHint", { min: USERNAME_MIN, max: USERNAME_MAX })}
        </p>
      </div>
      <PasswordField
        label={t("auth.password")}
        hint={t("auth.passwordHint", { min: PASSWORD_MIN })}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        invalid={error?.field === "password"}
        readOnly={busy}
      />
      <PasswordField
        label={t("auth.repeatPassword")}
        value={repeat}
        onChange={setRepeat}
        autoComplete="new-password"
        invalid={error?.field === "repeat"}
        readOnly={busy}
      />
      {error ? <FormError>{error.text}</FormError> : null}
      <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
        {busy ? t("setup.creating") : t("setup.create")}
      </button>
    </form>
  )
}

/**
 * Enrolment: the password starts it (Better Auth returns the authenticator link and the backup codes), the first
 * code finishes it. Then every other browser is signed out, with retries, before the codes are handed on. Settings
 * uses it too, to set up a new authenticator.
 */
export function TotpStep({
  known,
  onEnrolled,
  finishLabel,
}: {
  known: string | null
  onEnrolled: (backupCodes: string[]) => void
  finishLabel?: string
}) {
  const { t } = useI18n()
  const [password, setPassword] = useState("")
  const [uri, setUri] = useState<string | null>(null)
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [signOutOthersFailed, setSignOutOthersFailed] = useState(false)

  const failureText = (answer: AuthError, step: "password" | "code") => {
    const failure = authFailure(answer, step)
    return failure === "other"
      ? t("auth.error.failed", { reason: answer?.message || String(answer?.status ?? "") })
      : t(FAILURE_TEXT[failure])
  }

  const start = async (typed: string) => {
    setBusy(true)
    setError(null)
    try {
      const { data, error: answer } = await authClient.twoFactor.enable({ password: typed })
      if (answer || !data || !("totpURI" in data)) {
        setError(failureText(answer, "password"))
        return
      }
      setPassword("")
      // The QR code names the account after the username, not the synthetic e-mail (authenticatorUri).
      setUri(authenticatorUri(data.totpURI))
      setBackupCodes(data.backupCodes)
    } catch {
      setError(t("auth.error.network"))
    } finally {
      setBusy(false)
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once, as soon as the password is known
  useEffect(() => {
    if (known && !uri) void start(known)
  }, [known])

  useEffect(() => {
    if (!uri) return
    let current = true
    void QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: "M" }).then((url) => {
      if (current) setQr(url)
    })
    return () => {
      current = false
    }
  }, [uri])

  /** Better Auth's documented revokeOtherSessions, tried three times; the owner can try again when all fail. */
  const signOutOthers = async (codes: string[]) => {
    setBusy(true)
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const answer = await authClient.revokeOtherSessions().catch(() => ({ error: { status: 0 } }))
        if (!answer.error) {
          setSignOutOthersFailed(false)
          onEnrolled(codes)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      }
      setSignOutOthersFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const verify = async (code: string): Promise<CodeAnswer> => {
    setBusy(true)
    setError(null)
    try {
      const { error: answer } = await authClient.twoFactor.verifyTotp({ code })
      if (answer) {
        setError(failureText(answer, "code"))
        return authFailure(answer, "code") === "network" ? "kept" : "refused"
      }
    } catch {
      setError(t("auth.error.network"))
      return "kept"
    } finally {
      setBusy(false)
    }
    await signOutOthers(backupCodes)
    return "done"
  }

  if (signOutOthersFailed)
    return (
      <div className="ui-form-stack">
        <FormError>{t("setup.signOutOthersFailed")}</FormError>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={busy}
          onClick={() => void signOutOthers(backupCodes)}
        >
          {t("setup.signOutOthersRetry")}
        </button>
      </div>
    )

  if (!uri)
    return known && !error ? (
      <Loading label={t("setup.starting")} />
    ) : (
      <form
        className="ui-form-stack"
        onSubmit={(event) => {
          event.preventDefault()
          void start(password)
        }}
        noValidate
      >
        <PasswordField
          label={t("setup.confirmPassword")}
          hint={t("setup.confirmPasswordHint")}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          invalid={Boolean(error)}
          autoFocus
        />
        {error ? <FormError>{error}</FormError> : null}
        <button type="submit" className="ui-btn ui-btn-primary" disabled={busy || !password}>
          {busy ? t("setup.starting") : t("setup.start")}
        </button>
      </form>
    )

  const secret = new URL(uri).searchParams.get("secret") ?? ""
  return (
    <div className="ui-form-stack">
      <div className="ui-qr">
        {qr ? <img src={qr} alt={t("setup.qrAlt")} width={220} height={220} /> : <div className="ui-qr-wait" />}
      </div>
      <div className="ui-field">
        <p className="ui-hint">{t("setup.manual")}</p>
        <span className="ui-secret" data-testid="totp-secret">
          <Copyable value={secret} />
        </span>
      </div>
      <p className="ui-auth-lead">{t("setup.enterCode")}</p>
      <CodeField
        onSubmit={verify}
        busy={busy}
        submitLabel={finishLabel ?? t("setup.finish")}
        busyLabel={t("setup.finishing")}
        error={error}
      />
    </div>
  )
}
