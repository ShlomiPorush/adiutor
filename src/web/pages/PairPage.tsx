// Pairing a browser, once per device (not a login: there is no account and no password). The owner
// pastes the owner token, which is sent once in the request body and never put in an address or
// stored in the browser; the server answers with an HttpOnly device cookie. A show button, a Caps
// Lock note and an announced error help with the paste (v3 FS-23).

import { useQueryClient } from "@tanstack/react-query"
import { Eye, EyeOff } from "lucide-react"
import { type FormEvent, type KeyboardEvent, type MouseEvent, useId, useState } from "react"
import { useNavigate, useSearchParams } from "react-router"
import { ApiError } from "../api/client.ts"
import { api, qk } from "../api/endpoints.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { safeNext } from "../shell/Root.tsx"
import { BrandIcon } from "../shell/Shell.tsx"
import { errorReason } from "../ui/states.tsx"
import { usePageTitle } from "./usePageTitle.ts"

export const TOKEN_MIN = 32

function guessLabel(t: (key: string) => string): string {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent
  return /iphone|android|mobile/i.test(agent) ? t("pair.defaultPhone") : t("pair.defaultDesktop")
}

export function PairPage() {
  const { t, language } = useI18n()
  usePageTitle(t("pair.title"))
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [params] = useSearchParams()
  const tokenId = useId()
  const labelId = useId()
  const capsId = useId()
  const [token, setToken] = useState("")
  const [label, setLabel] = useState(() => guessLabel(t))
  const [shown, setShown] = useState(false)
  const [caps, setCaps] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const readCaps = (event: KeyboardEvent | MouseEvent) => setCaps(event.getModifierState("CapsLock"))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = token.trim()
    if (value.length < TOKEN_MIN) {
      setError(value ? t("pair.tooShort", { min: TOKEN_MIN }) : t("pair.tokenRequired"))
      document.getElementById(tokenId)?.focus()
      return
    }
    if (!label.trim()) {
      setError(t("pair.labelRequired"))
      document.getElementById(labelId)?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.pair(value, label.trim())
      setToken("")
      await queryClient.resetQueries()
      await queryClient.fetchQuery({ queryKey: qk.session, queryFn: api.session })
      navigate(safeNext(params.get("next")), { replace: true })
    } catch (failure) {
      setBusy(false)
      setToken("")
      if (failure instanceof ApiError && failure.code === "unauthorized") setError(t("pair.rejected"))
      else if (failure instanceof ApiError && failure.code === "rate_limited") setError(t("pair.rateLimited"))
      else if (failure instanceof ApiError && failure.code === "forbidden") setError(t("pair.forbidden"))
      else if (failure instanceof ApiError && failure.code === "network") setError(t("pair.network"))
      else setError(t("pair.failed", { reason: errorReason(language, failure) }))
      document.getElementById(tokenId)?.focus()
    }
  }

  return (
    <main className="ui-pair">
      <form className="ui-pair-col" onSubmit={submit} noValidate>
        <div className="ui-brand">
          <span className="ui-brand-mark" aria-hidden="true">
            <BrandIcon />
          </span>
          <span>{t("app.name")}</span>
        </div>
        <div>
          <h1 className="ui-h1">{t("pair.title")}</h1>
          <p>{t("pair.description")}</p>
        </div>
        {error ? (
          <div className="ui-banner ui-banner-fail" role="alert">
            <div>{error}</div>
          </div>
        ) : null}
        <div className="ui-field">
          <label className="ui-label" htmlFor={tokenId}>
            {t("pair.token")}
          </label>
          <div className="ui-pass">
            <input
              id={tokenId}
              className="ui-input ui-mono-input"
              type={shown ? "text" : "password"}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              dir="ltr"
              value={token}
              aria-describedby={caps ? capsId : undefined}
              aria-invalid={error ? true : undefined}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={readCaps}
              onKeyUp={readCaps}
              onMouseDown={readCaps}
              onBlur={() => setCaps(false)}
              // biome-ignore lint/a11y/noAutofocus: the pairing page has one job; the token field is where it starts
              autoFocus
            />
            <button
              type="button"
              className="ui-pass-toggle"
              aria-pressed={shown}
              aria-label={shown ? t("pair.hide") : t("pair.show")}
              title={shown ? t("pair.hide") : t("pair.show")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setShown((value) => !value)}
            >
              {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </button>
          </div>
          {caps ? (
            <p id={capsId} className="ui-caps">
              {t("pair.capsLock")}
            </p>
          ) : (
            <p className="ui-hint">{t("pair.tokenHint")}</p>
          )}
        </div>
        <div className="ui-field">
          <label className="ui-label" htmlFor={labelId}>
            {t("pair.label")}
          </label>
          <input
            id={labelId}
            className="ui-input"
            dir="auto"
            maxLength={60}
            autoComplete="off"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <p className="ui-hint">{t("pair.labelHint")}</p>
        </div>
        <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("pair.pairing") : t("pair.submit")}
        </button>
        <p className="ui-hint">{t("pair.footnote")}</p>
      </form>
    </main>
  )
}
