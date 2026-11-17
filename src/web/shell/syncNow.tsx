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

/**
 * What Sync now says once the request is saved: it waits for the computer, with no time promised; a computer that went
 * silent or is paused is named, since the request waits until it checks in again or its pause ends.
 */
export function askedMessage(t: (key: string) => string, view: SyncRequests | undefined): string {
  if (view?.client?.silent) return t("syncNow.askedSilent")
  if (view?.client?.paused) return t("syncNow.askedPaused")
  return t("syncNow.asked")
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
      showToast(created ? askedMessage(t, view) : t("syncNow.already"), created ? "success" : "info")
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

export type CardLine = { key: string; tone: "warn" | "fail" | null; text: ReactNode; title?: string }

/**
 * The lines the sync card adds under the last sync: the computer (silent, paused or syncing on its own), then the last
 * sync asked for here in its state, with each part's result once it finished (the whole text in the tooltip).
 */
export function useSyncCardLines(): (view: SyncRequests | undefined) => CardLine[] {
  const { t } = useI18n()
  return (view) => {
    const lines: CardLine[] = []
    const client = view?.client
    if (client?.silent)
      lines.push({
        key: "computer",
        tone: "warn",
        text: (
          <>
            {t("syncNow.silentSince")} <Time value={client.lastCheckinAt} mode="list" />
          </>
        ),
      })
    else if (client?.paused)
      lines.push({
        key: "computer",
        tone: null,
        text: client.pausedUntil ? (
          <>
            {t("syncNow.pausedUntil")} <Time value={client.pausedUntil} mode="list" />
          </>
        ) : (
          t("syncNow.paused")
        ),
      })
    else if (client?.running?.kind === "local")
      lines.push({ key: "computer", tone: null, text: t("syncNow.runningLocal") })
    const request = view?.request
    if (request) {
      const state = t(`syncNow.state.${request.state}`)
      const parts = request.result
        ? t("syncNow.parts", {
            t3: t(`syncNow.part.${request.result.t3}`),
            security: t(`syncNow.part.${request.result.security}`),
          })
        : null
      const tone = REQUEST_TONE[request.state]
      lines.push({
        key: "request",
        tone: tone === "fail" ? "fail" : tone === "warn" ? "warn" : null,
        text: parts ? `${state} · ${parts}` : state,
        title: parts ? `${state}: ${parts}` : state,
      })
    }
    return lines
  }
}
