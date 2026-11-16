// Sync now (the sync tray plan, section 4): the owner asks the sync on the computer for a run from the sync card and
// from Settings, Sync. The server never calls the computer: the tray takes the request at its next check-in, within a
// minute. A button that cannot be used stays in place, disabled, with the reason (v3 FB-1); while it asks it says so
// (FB-7), and the result is a toast that names it (FB-2, FB-4). The state updates by itself (SV-10).

import { useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useState } from "react"
import type { SyncRequestState } from "../../shared/enums.ts"
import { api, qk } from "../api/endpoints.ts"
import type { SyncRequest, SyncRequests } from "../api/types.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { errorReason } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import type { Tone } from "../ui/tags.tsx"

/** Where the tray app comes from: the repository's releases (the installer is attached to each release). */
export const TRAY_RELEASES_URL = "https://github.com/ShlomiPorush/adiutor/releases"

/** One tone per request state (v3 FB-14): running is information, a finish says how it went. */
export const REQUEST_TONE: Record<SyncRequestState, Tone> = {
  waiting: "info",
  claimed: "info",
  done: "ok",
  partial: "warn",
  failed: "fail",
  unknown: "warn",
  cancelled: "neutral",
}

/** The latest request and the computer, read every 30 seconds while a page shows them. */
export function useSyncRequests() {
  return usePageQuery({ queryKey: qk.syncRequests, queryFn: api.syncRequests, every: EVERY.live })
}

/** Why Sync now cannot be used, in words, or null when it can. */
export function useSyncNowBlocked(): (view: SyncRequests | undefined) => string | null {
  const { t } = useI18n()
  return (view) => {
    if (view?.unavailable === "no_client") return t("syncNow.noClient")
    if (view?.unavailable === "older_client") return t("syncNow.olderClient")
    return null
  }
}

/** The Sync now button: disabled with the reason when no computer would take it, busy while it asks. */
export function SyncNowButton({
  view,
  className = "ui-btn ui-btn-sm",
}: {
  view: SyncRequests | undefined
  className?: string
}) {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const blocked = useSyncNowBlocked()(view)
  const [busy, setBusy] = useState(false)
  const ask = async () => {
    setBusy(true)
    try {
      const { created } = await api.requestSync()
      showToast(created ? t("syncNow.asked") : t("syncNow.already"), created ? "success" : "info")
    } catch (error) {
      showToast(t("syncNow.failed", { reason: errorReason(language, error) }), "error")
    } finally {
      setBusy(false)
    }
    await queryClient.invalidateQueries({ queryKey: qk.syncRequests })
  }
  return (
    <button
      type="button"
      className={className}
      disabled={!view || blocked !== null || busy}
      title={blocked ?? undefined}
      onClick={() => void ask()}
    >
      {busy ? t("syncNow.busy") : t("syncNow.button")}
    </button>
  )
}

/** Cancel for a request that still waits for the computer: it acts at once, and Sync now asks again. */
export function CancelRequestButton({ request }: { request: SyncRequest }) {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const cancel = async () => {
    setBusy(true)
    try {
      await api.cancelSyncRequest(request.id)
      showToast(t("syncNow.cancelled"), "success")
    } catch (error) {
      showToast(t("syncNow.cancelFailed", { reason: errorReason(language, error) }), "error")
    } finally {
      setBusy(false)
    }
    await queryClient.invalidateQueries({ queryKey: qk.syncRequests })
  }
  return (
    <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => void cancel()}>
      {busy ? t("syncNow.cancelling") : t("syncNow.cancel")}
    </button>
  )
}

/**
 * The one line the sync card adds, most pressing first: the computer went silent, a request waits or runs, the
 * computer is paused, or it syncs on its own. Null when there is nothing to add.
 */
export function useSyncCardLine(): (view: SyncRequests | undefined) => { tone: "warn" | null; text: ReactNode } | null {
  const { t } = useI18n()
  return (view) => {
    const client = view?.client
    const state = view?.request?.state
    if (client?.silent)
      return {
        tone: "warn",
        text: (
          <>
            {t("syncNow.silentSince")} <Time value={client.lastCheckinAt} mode="list" />
          </>
        ),
      }
    if (state === "waiting" || state === "claimed") return { tone: null, text: t(`syncNow.state.${state}`) }
    if (client?.paused)
      return {
        tone: null,
        text: client.pausedUntil ? (
          <>
            {t("syncNow.pausedUntil")} <Time value={client.pausedUntil} mode="list" />
          </>
        ) : (
          t("syncNow.paused")
        ),
      }
    if (client?.running?.kind === "local") return { tone: null, text: t("syncNow.runningLocal") }
    return null
  }
}
