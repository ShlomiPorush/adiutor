// The app root: the session gate, the unsaved-changes guard, and the one confirm and toast hosts.
// GET /session answering 401 goes to sign-in (/login?next=...), with the reason when the session clocks ended
// it (/login?ended=...); totp_required goes to the TOTP setup (/setup). Any later 401 does the same, without
// asking about unsaved changes, and the page comes back afterwards. A wrong password or code on the sign-in
// pages stays on its form: those pages are outside the gate.

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useEffect, useRef } from "react"
import { Navigate, Outlet, useLocation, useNavigate } from "react-router"
import { ACTIVITY_REPORT_MS } from "../../shared/auth.ts"
import { ApiError, onUnauthorized } from "../api/client.ts"
import { api, qk } from "../api/endpoints.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { ConfirmHost } from "../ui/confirm.tsx"
import { ErrorState, Loading } from "../ui/states.tsx"
import { ToastHost } from "../ui/Toast.tsx"
import { UnsavedProvider, useClearUnsaved } from "../ui/unsaved.tsx"

/** Pages outside the gate: they work without a session. */
const AUTH_PAGES = ["/login", "/setup"]
const onAuthPage = (pathname: string) => AUTH_PAGES.includes(pathname)

/** Only a local path of this app is a place to come back to after signing in. */
export function safeNext(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || value.length > 2048) return "/"
  if (/^\/(login|setup|api|mcp)(\/|\?|$)/.test(value)) return "/"
  return value
}

/** Where a 401 or totp_required takes the page: sign-in (with why the session ended) or the TOTP setup. */
export function authPath(error: ApiError, here: string): string {
  const params = new URLSearchParams()
  if (error.code === "session_ended" && error.reason) params.set("ended", error.reason)
  const next = safeNext(here)
  if (next !== "/") params.set("next", next)
  const query = params.toString()
  const page = error.code === "totp_required" ? "/setup" : "/login"
  return query ? `${page}?${query}` : page
}

export function Root() {
  return (
    <UnsavedProvider>
      <SessionGate>
        <Outlet />
      </SessionGate>
      <ConfirmHost />
      <ToastHost />
    </UnsavedProvider>
  )
}

function SessionGate({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const clearUnsaved = useClearUnsaved()
  const here = `${location.pathname}${location.search}`
  const hereRef = useRef(here)
  hereRef.current = here
  const open = onAuthPage(location.pathname)

  const session = useQuery({
    queryKey: qk.session,
    queryFn: api.session,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    enabled: !open,
  })

  useEffect(() => {
    onUnauthorized((error) => {
      if (onAuthPage(window.location.pathname)) return
      clearUnsaved()
      queryClient.setQueryData(qk.session, undefined)
      navigate(authPath(error, hereRef.current), { replace: true })
    })
    return () => onUnauthorized(null)
  }, [clearUnsaved, navigate, queryClient])

  if (open) return children
  if (session.isPending) return <Loading label={t("app.loading")} />
  if (session.isError) {
    const error = session.error
    if (error instanceof ApiError && (error.status === 401 || error.code === "totp_required"))
      return <Navigate to={authPath(error, here)} replace />
    return (
      <div className="ui-auth">
        <ErrorState title={t("app.unreachable")} error={error} onRetry={() => void session.refetch()} />
      </div>
    )
  }
  return (
    <>
      {session.data.via === "session" ? <ActivityReporter /> : null}
      {children}
    </>
  )
}

/** Input that shows the owner is at the page. Scrolling alone is left out: the page scrolls by itself too. */
const INPUT_EVENTS = ["keydown", "pointerdown", "wheel", "touchstart"] as const

/**
 * Reports real input to the server at most every 30 seconds (the idle clock in Settings, and "last active" in
 * the account's session list); the last input of a quiet spell is still sent. Polling never counts.
 */
function ActivityReporter() {
  useEffect(() => {
    let last = 0
    let trailing: number | undefined
    const report = () => {
      last = Date.now()
      trailing = undefined
      void api.activity().catch(() => {
        // A 401 is handled by the gate; anything else is retried with the next input.
      })
    }
    const onInput = () => {
      const wait = last + ACTIVITY_REPORT_MS - Date.now()
      if (wait <= 0) report()
      else trailing ??= window.setTimeout(report, wait)
    }
    for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, { capture: true, passive: true })
    return () => {
      for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, { capture: true })
      window.clearTimeout(trailing)
    }
  }, [])
  return null
}
