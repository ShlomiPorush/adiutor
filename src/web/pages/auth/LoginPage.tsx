// Sign-in: username and password, then the code from the authenticator app. `next` (a page of this app only)
// is where it goes afterwards; `ended` says why the last session ended. A wrong password or code stays on its
// form; only a session that ended elsewhere leaves it.

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useId, useRef, useState } from "react"
import { Navigate, useNavigate, useSearchParams } from "react-router"
import { type AuthError, authClient, authFailure, FAILURE_TEXT } from "../../api/auth.ts"
import { api, qk } from "../../api/endpoints.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { safeNext } from "../../shell/Root.tsx"
import { Copyable } from "../../ui/Copyable.tsx"
import { Banner, ErrorState, Loading } from "../../ui/states.tsx"
import { usePageTitle } from "../usePageTitle.ts"
import { AuthFrame, type CodeAnswer, CodeField, FormError, PasswordField } from "./parts.tsx"

export const RECOVERY_COMMAND = "docker compose exec mikud node dist/server/cli.js reset-password"
const ENDED = ["max", "idle", "revoked"]

export function LoginPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [params] = useSearchParams()
  const next = safeNext(params.get("next"))
  const ended = params.get("ended") ?? ""
  const usernameId = useId()
  const passwordRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<"password" | "code">("password")
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
    failure === "other" || failure === "session_ended"
      ? t("auth.error.failed", { reason: answer?.message || String(answer?.status ?? "") })
      : t(FAILURE_TEXT[failure])

  const finish = async () => {
    await queryClient.resetQueries()
    navigate(next, { replace: true })
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
        setStep("code")
        return
      }
      // Signed in without TOTP (a new account, or after a reset on the server): it is set up next.
      await queryClient.resetQueries()
      navigate(withNext("/setup"), { replace: true })
    } catch {
      setError(t("auth.error.network"))
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
        const failure = authFailure(answer, "code")
        if (failure === "code_expired") {
          setStep("password")
          setError(t(FAILURE_TEXT.code_expired))
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

  if (step === "code")
    return (
      <AuthFrame title={t("login.codeTitle")} description={t("login.codeDescription")}>
        <CodeField
          onSubmit={verify}
          busy={busy}
          submitLabel={t("login.verify")}
          busyLabel={t("login.verifying")}
          error={error}
        />
        <button
          type="button"
          className="ui-btn"
          onClick={() => {
            setStep("password")
            setError(null)
          }}
        >
          {t("login.back")}
        </button>
      </AuthFrame>
    )

  return (
    <AuthFrame title={t("login.title")} description={t("login.description")}>
      {ENDED.includes(ended) ? <Banner tone="info" title={t(`auth.ended.${ended}`)} /> : null}
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
