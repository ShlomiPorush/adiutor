// The app root: the session gate, the unsaved-changes guard, and the one confirm and toast hosts.
// GET /session answering 401 shows the pairing page (not a login: there is no account), and any
// later 401 does the same, without asking about unsaved changes, and comes back afterwards.

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useEffect, useRef } from "react"
import { Navigate, Outlet, useLocation, useNavigate } from "react-router"
import { ApiError, onUnauthorized } from "../api/client.ts"
import { api, qk } from "../api/endpoints.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { ConfirmHost } from "../ui/confirm.tsx"
import { ErrorState, Loading } from "../ui/states.tsx"
import { ToastHost } from "../ui/Toast.tsx"
import { UnsavedProvider, useClearUnsaved } from "../ui/unsaved.tsx"

/** Only a local path of this app is a place to come back to after pairing. */
export function safeNext(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.length > 2048) return "/"
  if (value.startsWith("/pair") || value.startsWith("/api") || value.startsWith("/mcp")) return "/"
  return value
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
  const onPair = location.pathname === "/pair"

  const session = useQuery({
    queryKey: qk.session,
    queryFn: api.session,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    onUnauthorized(() => {
      if (hereRef.current.startsWith("/pair")) return
      clearUnsaved()
      queryClient.setQueryData(qk.session, undefined)
      void queryClient.invalidateQueries({ queryKey: qk.session })
      navigate(`/pair?next=${encodeURIComponent(hereRef.current)}`, { replace: true })
    })
    return () => onUnauthorized(null)
  }, [clearUnsaved, navigate, queryClient])

  if (onPair) return children
  if (session.isPending) return <Loading label={t("app.loading")} />
  if (session.isError) {
    if (session.error instanceof ApiError && session.error.code === "unauthorized") {
      return <Navigate to={`/pair?next=${encodeURIComponent(here)}`} replace />
    }
    return (
      <div className="ui-pair">
        <ErrorState title={t("app.unreachable")} error={session.error} onRetry={() => void session.refetch()} />
      </div>
    )
  }
  return children
}
