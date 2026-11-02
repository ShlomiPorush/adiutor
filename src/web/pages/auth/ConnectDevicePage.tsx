// /connect/device: the owner approves an agent that ran `mikud connect` (Better Auth's device authorization). Inside
// the session gate, so a signed-out browser signs in first and comes back here with its code. GET /device claims the
// code for this session and says whether it is still waiting; Allow and Deny answer it once. The page reads the
// request once and never refreshes it on its own (SV-10 exception): Better Auth limits GET /device to 5 reads per code
// lifetime, and the answer only changes when this page gives it. Nothing takes the focus, so a stray Enter cannot
// allow (texts and order after mailcow Logs Viewer's consent page).

import { useQuery } from "@tanstack/react-query"
import { type FormEvent, useId, useState } from "react"
import { Link, useSearchParams } from "react-router"
import { authClient, authData } from "../../api/auth.ts"
import { api, qk } from "../../api/endpoints.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { Loading } from "../../ui/states.tsx"
import { Tag } from "../../ui/tags.tsx"
import { usePageTitle } from "../usePageTitle.ts"
import { AuthFrame, FormError } from "./parts.tsx"

type Verification = { user_code: string; status: "pending" | "approved" | "denied"; client_id?: string }

/** Codes are letters and digits; the page shows them as ABCD-EFGH and sends them without the dash. */
const plainCode = (value: string) => value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase()
const groupedCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code)

/** Better Auth's device routes answer errors as { error, error_description }. */
function deviceError(error: unknown): string {
  const answer = (error as { answer?: { error?: string; code?: string; status?: number } }).answer
  if (!answer?.status) return "network"
  if (answer.status === 429) return "rate_limited"
  if (answer.error === "expired_token") return "expired"
  if (answer.error === "invalid_request" && answer.status === 400) return "unknown"
  return "other"
}

export function ConnectDevicePage() {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const userCode = plainCode(params.get("user_code") ?? "")
  usePageTitle(t("connect.title"))

  if (!userCode) return <CodeForm onCode={(code) => setParams({ user_code: code }, { replace: true })} />
  return <Request userCode={userCode} />
}

/** Without a code in the link: type the one the agent shows. */
function CodeForm({ onCode }: { onCode: (code: string) => void }) {
  const { t } = useI18n()
  const id = useId()
  const [value, setValue] = useState("")
  const [error, setError] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const code = plainCode(value)
    if (code.length !== 8) {
      setError(true)
      return
    }
    onCode(code)
  }
  return (
    <AuthFrame title={t("connect.title")} description={t("connect.enterCode")}>
      <form className="ui-form-stack" onSubmit={submit} noValidate>
        <div className="ui-field">
          <label className="ui-label" htmlFor={id}>
            {t("connect.code")}
          </label>
          <input
            id={id}
            className="ui-input ui-code-input"
            dir="ltr"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={9}
            value={value}
            aria-invalid={error || undefined}
            onChange={(event) => {
              setValue(event.target.value)
              setError(false)
            }}
          />
        </div>
        {error ? <FormError>{t("connect.codeInvalid")}</FormError> : null}
        <button type="submit" className="ui-btn ui-btn-primary">
          {t("connect.continue")}
        </button>
      </form>
    </AuthFrame>
  )
}

function Request({ userCode }: { userCode: string }) {
  const { t } = useI18n()
  const me = useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: Number.POSITIVE_INFINITY })
  const request = useQuery({
    queryKey: ["device", userCode],
    queryFn: () =>
      authData(
        authClient.$fetch<Verification>("/device", { method: "GET", query: { user_code: userCode } }) as Promise<{
          data: Verification | null
          error: { status?: number; code?: string; message?: string } | null
        }>,
      ),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const [busy, setBusy] = useState(false)
  const [answered, setAnswered] = useState<"allowed" | "denied" | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const answer = async (allow: boolean) => {
    setBusy(true)
    setFailure(null)
    try {
      await authData(
        authClient.$fetch(allow ? "/device/approve" : "/device/deny", {
          method: "POST",
          body: { userCode },
        }) as Promise<{ data: unknown; error: { status?: number; code?: string; message?: string } | null }>,
      )
      setAnswered(allow ? "allowed" : "denied")
    } catch (error) {
      setFailure(deviceError(error))
      setBusy(false)
    }
  }

  if (request.isPending) return <Loading label={t("connect.loading")} />

  const unavailable = (reason: string) => (
    <AuthFrame title={t("connect.title")}>
      <div className="ui-banner ui-banner-fail" role="alert">
        <div>
          <b>{t("connect.unavailable")}</b>
          <p>
            {t(`connect.reason.${reason}`)} {t("connect.nothingShared")}
          </p>
        </div>
      </div>
      <Link className="ui-btn" to="/">
        {t("connect.toBoard")}
      </Link>
    </AuthFrame>
  )

  if (request.isError) return unavailable(deviceError(request.error))
  if (answered)
    return (
      <AuthFrame title={t("connect.title")}>
        <div className={answered === "allowed" ? "ui-banner ui-banner-ok" : "ui-banner"} role="status">
          <div>
            <b>{t(answered === "allowed" ? "connect.allowed" : "connect.denied")}</b>
            <p>{t("connect.closeWindow")}</p>
          </div>
        </div>
      </AuthFrame>
    )
  if (request.data.status !== "pending") return unavailable("answered")
  if (failure && failure !== "network" && failure !== "rate_limited" && failure !== "other")
    return unavailable(failure === "unknown" ? "answered" : failure)

  return (
    <AuthFrame title={t("connect.title")} description={t("connect.lead")}>
      <section className="ui-consent-sec" aria-labelledby="consent-who">
        <h2 className="ui-consent-h" id="consent-who">
          {t("connect.who")}
        </h2>
        <p className="ui-auth-lead">{t("connect.client")}</p>
        <div className="ui-consent-code">
          <span className="ui-label">{t("connect.code")}</span>
          <b className="ui-mono" dir="ltr" data-testid="connect-code">
            {groupedCode(userCode)}
          </b>
        </div>
        <p className="ui-consent-id">
          <Tag tone="warn">{t("connect.identityTag")}</Tag> {t("connect.identity")}
        </p>
      </section>
      <section className="ui-consent-sec" aria-labelledby="consent-what">
        <h2 className="ui-consent-h" id="consent-what">
          {t("connect.what")}
        </h2>
        <p>{t("connect.whatKey")}</p>
        <p>{t("connect.never")}</p>
        <div className="ui-banner ui-banner-warn" role="note">
          <div>
            <b>{t("connect.warnTitle")}</b>
            <p>{t("connect.warnText")}</p>
          </div>
        </div>
      </section>
      {failure ? <FormError>{t(`connect.failed.${failure}`)}</FormError> : null}
      <p>
        {me.data ? `${t("connect.signedInAs", { user: me.data.actor.label })} ` : ""}
        {t("connect.footnote")}
      </p>
      <div className="ui-consent-actions">
        <button type="button" className="ui-btn" disabled={busy} onClick={() => void answer(false)}>
          {t("connect.deny")}
        </button>
        <button type="button" className="ui-btn ui-btn-primary" disabled={busy} onClick={() => void answer(true)}>
          {t("connect.allow")}
        </button>
      </div>
    </AuthFrame>
  )
}
