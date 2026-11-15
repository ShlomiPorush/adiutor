// /connect/approve/<uid>: the owner approves or denies an agent that asks the authorization server for access (v3
// FS-24, adapted: Adiutor's areas are single checkboxes, and the lifetime is the idle rule, not a period to pick).
// Inside the session gate, so a signed-out browser signs in first and comes back here; outside the frame. The page
// reads the request once (the first read binds it to this browser session) and never refreshes it on its own (SV-10
// exception): the request only changes when this page answers it. Nothing takes the focus and the page opens at its
// top, where the owner checks who asks, so Approve is pressed on purpose. After the answer the browser follows the
// server's address (back to the agent, or the code flow's done page); without one the page says what happened.

import { useQuery } from "@tanstack/react-query"
import { type ReactNode, useId, useState } from "react"
import { Link, Navigate, useLocation, useParams } from "react-router"
import type { AgentArea } from "../../../shared/enums.ts"
import { ApiError } from "../../api/client.ts"
import { ConsentError, type ConsentFailure, consentApi, sameOrigin } from "../../api/consent.ts"
import { api, qk } from "../../api/endpoints.ts"
import type { ConsentDetails } from "../../api/types.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { authPath } from "../../shell/Root.tsx"
import { Banner, Loading } from "../../ui/states.tsx"
import { Tag } from "../../ui/tags.tsx"
import { usePageTitle } from "../usePageTitle.ts"
import { AuthFrame, FormError } from "./parts.tsx"

/** How the page leaves for the server's next address; replaced in tests. */
export const away = { go: (address: string) => window.location.assign(address) }

const reasonOf = (error: unknown): ConsentFailure => (error instanceof ConsentError ? error.reason : "other")

/** Signed out or without two-factor: the gate's own pages, then back here. */
function authRedirect(reason: ConsentFailure, here: string): string | null {
  if (reason === "unauthorized") return authPath(new ApiError(401, "unauthorized", null), here)
  if (reason === "totp_required") return authPath(new ApiError(403, "totp_required", null), here)
  return null
}

export function ConsentPage() {
  const { t } = useI18n()
  const { uid = "" } = useParams()
  const location = useLocation()
  const here = `${location.pathname}${location.search}`
  usePageTitle(t("consent.title"))
  const request = useQuery({
    queryKey: ["consent", uid],
    queryFn: () => consentApi.details(uid),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  if (request.isPending) return <Loading label={t("consent.loading")} />
  if (request.isError) {
    const reason = reasonOf(request.error)
    const to = authRedirect(reason, here)
    if (to) return <Navigate to={to} replace />
    return <Unavailable reason={reason} />
  }
  return <Request uid={uid} here={here} details={request.data} />
}

/** The request cannot be answered here: why, and where to go. */
function Unavailable({ reason }: { reason: ConsentFailure }) {
  const { t } = useI18n()
  const shown = (["gone", "not_configured", "forbidden", "network"] as const).find((r) => r === reason) ?? "other"
  return (
    <AuthFrame title={t("consent.title")}>
      <Banner tone="fail" title={t("consent.unavailable")}>
        {t(`consent.reason.${shown}`)}
      </Banner>
      {reason === "not_configured" ? (
        <Link className="ui-btn" to="/settings/agents">
          {t("consent.toSettings")}
        </Link>
      ) : (
        <Link className="ui-btn" to="/">
          {t("consent.toBoard")}
        </Link>
      )}
    </AuthFrame>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="ui-consent-sec" aria-labelledby={id}>
      <h2 className="ui-consent-h" id={id}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Request({ uid, here, details }: { uid: string; here: string; details: ConsentDetails }) {
  const { t, tc } = useI18n()
  const areasId = useId()
  const me = useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: Number.POSITIVE_INFINITY })
  const [chosen, setChosen] = useState<AgentArea[]>(details.areas)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<"noArea" | "validation" | "other" | null>(null)
  const [ended, setEnded] = useState<ConsentFailure | null>(null)
  // The answer was sent and none came back: the server may have recorded it, and the request is then gone.
  const [unknown, setUnknown] = useState(false)
  const [answered, setAnswered] = useState<{ outcome: "approved" | "denied"; leaving: boolean } | null>(null)

  const { client, via, resource, redirect, idleDays } = details
  const acting = chosen.some((area) => area !== "read")

  const answer = async (approve: boolean) => {
    if (approve && chosen.length === 0) {
      setProblem("noArea")
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      const result = await consentApi.decide(
        uid,
        approve,
        details.areas.filter((area) => chosen.includes(area)),
      )
      const next = sameOrigin(result.redirectTo, window.location.origin)
      setAnswered({ outcome: result.outcome, leaving: next !== null })
      if (next) away.go(next)
    } catch (error) {
      const reason = reasonOf(error)
      // Only a refusal proves that nothing was decided, so only then may the owner answer again.
      if (reason === "network" || reason === "lost") setUnknown(true)
      else if (reason === "validation" || reason === "other") {
        setProblem(reason)
        setBusy(false)
      } else setEnded(reason)
    }
  }

  if (unknown)
    return (
      <AuthFrame title={t("consent.title")}>
        <Banner tone="warn" title={t("consent.unknownTitle")}>
          {t("consent.unknownText")}
        </Banner>
        <Link className="ui-btn" to="/settings/agents">
          {t("consent.toSettings")}
        </Link>
      </AuthFrame>
    )
  if (ended) {
    const to = authRedirect(ended, here)
    return to ? <Navigate to={to} replace /> : <Unavailable reason={ended} />
  }
  if (answered?.leaving) return <Loading label={t("consent.returning")} />
  if (answered)
    return (
      <AuthFrame title={t("consent.title")}>
        <Banner tone={answered.outcome === "approved" ? "ok" : "info"} title={t(`consent.${answered.outcome}`)}>
          {t("consent.closeWindow")}
        </Banner>
      </AuthFrame>
    )

  const toggle = (area: AgentArea, on: boolean) => {
    setProblem(null)
    setChosen((current) => (on ? [...current, area] : current.filter((a) => a !== area)))
  }

  return (
    <AuthFrame title={t("consent.title")} description={t("consent.lead")}>
      <Section id="consent-who" title={t("consent.who")}>
        <p className="ui-consent-name" data-testid="consent-name">
          <bdi dir="auto">{client.name}</bdi>
        </p>
        <p className="ui-consent-id">
          <Tag tone="warn">{client.builtIn ? t("consent.builtInTag") : t("consent.nameTag")}</Tag>{" "}
          {client.builtIn ? t("consent.builtInText") : t("consent.otherText")}
        </p>
        <dl className="ui-consent-facts">
          <div>
            <dt>{t("consent.via")}</dt>
            <dd>{t(via === "code" ? "consent.viaCode" : "consent.viaBrowser")}</dd>
          </div>
          <div>
            <dt>{t("consent.resource")}</dt>
            <dd>{t(resource === "mcp" ? "consent.resourceMcp" : "consent.resourceRest")}</dd>
          </div>
          {redirect ? (
            <div>
              <dt>{t("consent.returnsTo")}</dt>
              <dd>
                {/* An app's own scheme (com.example.app:/callback) has no host: the scheme names it. */}
                <bdi className="ui-mono ui-consent-host" dir="ltr" data-testid="consent-host">
                  {redirect.host || `${redirect.scheme}:`}
                </bdi>{" "}
                <Tag tone={redirect.loopback ? "ok" : "warn"}>
                  {t(redirect.loopback ? "consent.loopback" : redirect.host ? "consent.remote" : "consent.app")}
                </Tag>
              </dd>
            </div>
          ) : null}
        </dl>
      </Section>
      <Section id="consent-what" title={t("consent.what")}>
        <fieldset className="ui-consent-areas" aria-describedby={problem === "noArea" ? areasId : undefined}>
          <legend className="ui-sr-only">{t("consent.what")}</legend>
          {details.areas.map((area) => (
            <label key={area} className="ui-consent-area">
              <input
                type="checkbox"
                className="ui-check"
                name="area"
                value={area}
                checked={chosen.includes(area)}
                disabled={busy}
                onChange={(event) => toggle(area, event.target.checked)}
              />
              <span>
                <b>{t(`consent.areas.${area}.name`)}</b>
                <span className="ui-hint">{t(`consent.areas.${area}.hint`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="ui-consent-id">{t("consent.never")}</p>
        {acting ? (
          <Banner tone="warn" title={t("consent.warnTitle")}>
            {t("consent.warnText")}
          </Banner>
        ) : null}
      </Section>
      <Section id="consent-long" title={t("consent.howLong")}>
        <p>{tc("consent.lifetime", idleDays)}</p>
      </Section>
      {problem ? (
        <FormError id={areasId}>{t(problem === "noArea" ? "consent.noArea" : `consent.failed.${problem}`)}</FormError>
      ) : null}
      <p>
        {me.data ? `${t("consent.signedInAs", { user: me.data.actor.label })} ` : ""}
        {t("consent.footnote")}
      </p>
      <div className="ui-consent-actions">
        <button type="button" className="ui-btn" disabled={busy} onClick={() => void answer(false)}>
          {t("consent.deny")}
        </button>
        <button type="button" className="ui-btn ui-btn-primary" disabled={busy} onClick={() => void answer(true)}>
          {busy ? t("consent.sending") : t("consent.approve")}
        </button>
      </div>
    </AuthFrame>
  )
}
