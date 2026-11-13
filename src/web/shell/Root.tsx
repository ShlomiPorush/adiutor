// The app root: the session gate, the unsaved-changes guard, and the one confirm and toast hosts.
// GET /session answering 401 goes to sign-in (/login?next=...); totp_required goes to the two-factor setup
// (/setup). Any later 401 does the same, without asking about unsaved changes, and the page comes back afterwards.
// A wrong password or code on the sign-in pages stays on its form: those pages are outside the gate.
// The gate also mounts Better Auth's useSession: its own refresh (on opening, coming back to the front or online,
// and another tab's change) is what keeps the session alive; Adiutor's polling never extends it.

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useEffect, useRef } from "react"
import { Navigate, Outlet, useLocation, useNavigate } from "react-router"
import { authClient } from "../api/auth.ts"
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

/** Where a 401 or totp_required takes the page: sign-in or the two-factor setup. */
export function authPath(error: ApiError, here: string): string {
  const params = new URLSearchParams()
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
      <SessionKeeper />
      {children}
    </>
  )
}

/**
 * Better Auth's client session: mounted, it refreshes the session by itself (a GET, then the POST that extends it
 * when the answer says needsRefresh). When it learns that the session is gone (signed out in another tab), the
 * gate checks again and goes to sign-in.
 */
function SessionKeeper() {
  const queryClient = useQueryClient()
  const { data, isPending } = authClient.useSession()
  const seen = useRef(false)
  const signedIn = Boolean(data)
  useEffect(() => {
    if (signedIn) seen.current = true
    else if (!isPending && seen.current) void queryClient.invalidateQueries({ queryKey: qk.session })
  }, [signedIn, isPending, queryClient])
  return null
}
