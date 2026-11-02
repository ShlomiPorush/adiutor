// Sign-in on Better Auth's routes: username and password, then the second factor: the code from the authenticator
// app, a backup code, or (when the owner turned it on) a code sent to Telegram. `next` (a page of this app only) is
// where it goes afterwards. A wrong password or code stays on its form.

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useId, useRef, useState } from "react"
import { Navigate, useNavigate, useSearchParams } from "react-router"
import { type AuthError, authClient, authFailure, FAILURE_TEXT } from "../../api/auth.ts"
import { api, qk } from "../../api/endpoints.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { safeNext } from "../../shell/Root.tsx"
import { Copyable } from "../../ui/Copyable.tsx"
import { ErrorState, Loading } from "../../ui/states.tsx"
import { usePageTitle } from "../usePageTitle.ts"
import { AuthFrame, BackupCodeField, type CodeAnswer, CodeField, FormError, PasswordField } from "./parts.tsx"

export const RECOVERY_COMMAND = "docker compose exec mikud node dist/server/cli.js reset-password"

type Method = "totp" | "backup" | "otp"

export function LoginPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [params] = useSearchParams()
  const next = safeNext(params.get("next"))
  const usernameId = useId()
  const passwordRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<"password" | "code">("password")
  const [method, setMethod] = useState<Method>("totp")
  const [otpAvailable, setOtpAvailable] = useState(false)
  const [otpSent, setOtpSent] = useState(false)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  usePageTitle(step === "code" ? t("login.codeTitle") : t("login.title"))

  const status = useQuery({ queryKey: qk.setupStatus, queryFn: api.setupStatus, retry: false })
  if (status.isPending) return <Loading label={t("app.loading")} />
  if (status.isError)
    return (
      <div className="ui-auth">
        <ErrorState title={t("app.unreachable")} error={status.error} onRetry={() => void status.refetch()} />
      </div>
    )
  const withNext = (page: string) => (next === "/" ? page : `${page}?next=${encodeURIComponent(next)}`)
  if (!status.data.hasUser) return <Navigate to={withNext("/setup")} replace />
  if (status.data.session === "active") return <Navigate to={next} replace />
  if (status.data.session === "enrol") return <Navigate to={withNext("/setup")} replace />

  const failureText = (failure: ReturnType<typeof authFailure>, answer: AuthError) =>
    failure === "other"
      ? t("auth.error.failed", { reason: answer?.message || String(answer?.status ?? "") })
      : t(FAILURE_TEXT[failure])

  const finish = async () => {
    await queryClient.resetQueries()
    navigate(next, { replace: true })
  }

  const backToPassword = (message: string | null) => {
    setStep("password")
    setMethod("totp")
    setOtpSent(false)
    setError(message)
  }

  const signIn = async (event: FormEvent) => {
    event.preventDefault()
    if (!username || !password) {
      setError(t("auth.error.wrongPassword"))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { data, error: answer } = await authClient.signIn.username({ username, password })
      if (answer) {
        const failure = authFailure(answer, "password")
        if (failure === "wrong_password") {
          setPassword("")
          passwordRef.current?.focus()
        }
        setError(failureText(failure, answer))
        return
      }
      setPassword("")
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
        const methods = (data as { twoFactorMethods?: string[] }).twoFactorMethods ?? []
        setOtpAvailable(methods.includes("otp"))
        setStep("code")
        return
      }
      // Signed in without two-factor (a new account): it is set up next.
      await queryClient.resetQueries()
      navigate(withNext("/setup"), { replace: true })
    } catch {
      setError(t("auth.error.network"))
    } finally {
      setBusy(false)
    }
  }

  /** Sends the second factor; an expired challenge goes back to the password. */
  const verify = async (call: () => Promise<{ error: AuthError }>): Promise<CodeAnswer> => {
    setBusy(true)
    setError(null)
    try {
      const { error: answer } = await call()
      if (answer) {
        const failure = authFailure(answer, "code")
        if (failure === "code_expired") {
          backToPassword(t(FAILURE_TEXT.code_expired))
          return "refused"
        }
        setError(failureText(failure, answer))
        return failure === "network" ? "kept" : "refused"
      }
      await finish()
      return "done"
    } catch {
      setError(t("auth.error.network"))
      return "kept"
    } finally {
      setBusy(false)
    }
  }

  const sendOtp = async () => {
    setBusy(true)
    setError(null)
    try {
      const { error: answer } = await authClient.twoFactor.sendOtp()
      if (answer) {
        const failure = authFailure(answer, "code")
        if (failure === "code_expired") backToPassword(t(FAILURE_TEXT.code_expired))
        else setError(failureText(failure, answer))
        return
      }
      setOtpSent(true)
    } catch {
      setError(t("auth.error.network"))
    } finally {
      setBusy(false)
    }
  }

  const choose = (next: Method) => {
    setMethod(next)
    setError(null)
  }

  if (step === "code")
    return (
      <AuthFrame
        title={t("login.codeTitle")}
        description={t(
          method === "backup"
            ? "login.backupDescription"
            : method === "otp"
              ? "login.otpDescription"
              : "login.codeDescription",
        )}
      >
        {method === "totp" ? (
          <CodeField
            onSubmit={(code) => verify(() => authClient.twoFactor.verifyTotp({ code }))}
            busy={busy}
            submitLabel={t("login.verify")}
            busyLabel={t("login.verifying")}
            error={error}
          />
        ) : method === "backup" ? (
          <BackupCodeField
            onSubmit={(code) => verify(() => authClient.twoFactor.verifyBackupCode({ code }))}
            busy={busy}
            error={error}
          />
        ) : otpSent ? (
          <CodeField
            onSubmit={(code) => verify(() => authClient.twoFactor.verifyOtp({ code }))}
            busy={busy}
            submitLabel={t("login.verify")}
            busyLabel={t("login.verifying")}
            error={error}
            hint={t("login.otpHint")}
          />
        ) : (
          <div className="ui-form-stack">
            {error ? <FormError>{error}</FormError> : null}
            <button type="button" className="ui-btn ui-btn-primary" disabled={busy} onClick={() => void sendOtp()}>
              {busy ? t("login.otpSending") : t("login.otpSend")}
            </button>
          </div>
        )}
        <div className="ui-auth-alt">
          {method !== "totp" ? (
            <button type="button" className="ui-link-btn" onClick={() => choose("totp")}>
              {t("login.useApp")}
            </button>
          ) : null}
          {method !== "backup" ? (
            <button type="button" className="ui-link-btn" onClick={() => choose("backup")}>
              {t("login.useBackup")}
            </button>
          ) : null}
          {otpAvailable && method !== "otp" ? (
            <button type="button" className="ui-link-btn" onClick={() => choose("otp")}>
              {t("login.useOtp")}
            </button>
          ) : null}
        </div>
        <button type="button" className="ui-btn" onClick={() => backToPassword(null)}>
          {t("login.back")}
        </button>
      </AuthFrame>
    )

  return (
    <AuthFrame title={t("login.title")} description={t("login.description")}>
      <form className="ui-form-stack" onSubmit={signIn} noValidate>
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
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            // biome-ignore lint/a11y/noAutofocus: the sign-in page has one job; the username is where it starts
            autoFocus
          />
        </div>
        <PasswordField
          label={t("auth.password")}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          inputRef={passwordRef}
          invalid={Boolean(error)}
        />
        {error ? <FormError>{error}</FormError> : null}
        <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("login.signingIn") : t("login.submit")}
        </button>
      </form>
      <div className="ui-auth-note">
        <p>{t("auth.recovery")}</p>
        <Copyable value={RECOVERY_COMMAND} />
      </div>
    </AuthFrame>
  )
}
