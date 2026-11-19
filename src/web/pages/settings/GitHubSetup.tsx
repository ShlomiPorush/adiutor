// Settings, GitHub: the App made from a manifest and the installations added after GitHub's install page, both through
// GitHub's own pages in this tab. Create posts the manifest form to GitHub; GitHub sends the browser back to
// /settings/github with `code` and `state` (the App was created) or `installation_id` and `setup_action` (it was
// installed). Those parameters leave the address before anything else, so a reload or Back never repeats them; the
// code is then exchanged once, and the installation is sent once with the state GitHub brought back; the server adds
// it only when that state is the one of the owner's own pending Connect an account.

import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { ApiError } from "../../api/client.ts"
import { api, qk } from "../../api/endpoints.ts"
import { formatTime } from "../../format/datetime.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { Copyable } from "../../ui/Copyable.tsx"
import { Banner, errorReason } from "../../ui/states.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Row } from "./parts.tsx"

/** A GitHub refusal in the owner's language (the server's own sentence is English); others as usual. */
export function githubErrorText(
  t: (key: string, vars?: Record<string, string | number>) => string,
  language: "he" | "en",
  error: unknown,
): string {
  if (!(error instanceof ApiError)) return errorReason(language, error)
  if (error.code === "github_rate_limited" && typeof error.details.until === "string")
    return t("githubSettings.waitUntil", { time: formatTime(error.details.until, { seconds: false }) })
  if (error.code.startsWith("github_") || error.code === "conflict" || error.code === "setting_locked")
    return t(`errors.code.${error.code}`)
  return errorReason(language, error)
}

/** The id of an installation, as GitHub writes it in the address. */
const INSTALLATION_ID = /^[1-9][0-9]{0,15}$/
/** The parameters GitHub adds on its way back; none stays in the address. */
const RETURN_PARAMS = ["code", "state", "installation_id", "setup_action"] as const

/** Where the page leaves for GitHub, in this tab (a seam for tests). */
export const leaveFor = {
  /** Posts the manifest to GitHub as a form: the UI's Content-Security-Policy allows https://github.com as its action. */
  manifest(action: string, manifest: string): void {
    const form = document.createElement("form")
    form.method = "post"
    form.action = action
    form.hidden = true
    const field = document.createElement("input")
    field.type = "hidden"
    field.name = "manifest"
    field.value = manifest
    form.append(field)
    document.body.append(form)
    form.submit()
  },
  /** Opens GitHub's install page. */
  page(url: string): void {
    window.location.assign(url)
  },
}

/** What GitHub's return to Settings, GitHub came to. */
export type GitHubReturn =
  | { kind: "creating" }
  | { kind: "created"; login: string; fingerprint: string | null }
  | { kind: "createFailed"; error: unknown }
  | { kind: "request" }
  | { kind: "connecting" }
  | { kind: "connected"; login: string; added: boolean }
  | { kind: "connectFailed"; error: unknown }

/**
 * Reads GitHub's return from the address once: the parameters are replaced away first, then the App's code is
 * exchanged, or the installation is sent to be added (each once, also under StrictMode's second run of the effect).
 */
export function useGitHubReturn() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const handled = useRef(false)
  const [state, setState] = useState<GitHubReturn | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for each address; the rest is read as it is then
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (!RETURN_PARAMS.some((name) => params.has(name))) return
    const code = params.get("code")
    const returned = params.get("state")
    const installation = params.get("installation_id")
    const action = params.get("setup_action")
    for (const name of RETURN_PARAMS) params.delete(name)
    const search = params.toString()
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash },
      { replace: true },
    )
    if (handled.current) return
    handled.current = true
    if (code && returned) {
      setState({ kind: "creating" })
      api.finishGitHubApp(code, returned).then(
        async (created) => {
          // A read that started before the save would otherwise land after it with the view of before.
          await queryClient.cancelQueries({ queryKey: qk.github })
          queryClient.setQueryData(qk.github, created.view)
          setState({ kind: "created", login: created.owner.login, fingerprint: created.view.settings.key.fingerprint })
        },
        (error: unknown) => {
          setState({ kind: "createFailed", error })
          void queryClient.invalidateQueries({ queryKey: qk.github })
        },
      )
    } else if (action === "request") {
      // An organization's owner must approve the install: GitHub may send no installation id yet.
      setState({ kind: "request" })
    } else if (installation && INSTALLATION_ID.test(installation) && !returned) {
      // A return without a state is not a Connect an account (GitHub's Configure, or a change of repositories): it adds
      // nothing, and the list is read again.
      void queryClient.invalidateQueries({ queryKey: qk.github })
    } else if (installation && INSTALLATION_ID.test(installation) && returned) {
      setState({ kind: "connecting" })
      api
        .finishGitHubInstall(Number(installation), returned)
        .then((connected) => {
          // An answer outside the contract is no confirmation: it shows as a failure, with what to check.
          if (typeof connected?.login !== "string" || typeof connected.added !== "boolean")
            throw new Error("The answer is not the expected one.")
          setState({ kind: "connected", login: connected.login || installation, added: connected.added })
        })
        .catch((error: unknown) => setState({ kind: "connectFailed", error }))
        // Read the settings again either way, so the list shows what was saved: a read that started before the save
        // is cancelled first, since one without data yet would otherwise be joined instead of read again.
        .finally(async () => {
          await queryClient.cancelQueries({ queryKey: qk.github })
          await queryClient.invalidateQueries({ queryKey: qk.github })
        })
    }
  }, [location.search])

  return { state, dismiss: () => setState(null) }
}

/**
 * Leaving this tab for GitHub: the server's answer, then the page goes. The buttons are disabled while the Settings
 * draft holds unsaved changes, and the draft is read again when the answer arrives, so the page never leaves with a
 * draft and the unsaved guards are never touched. An answer that arrives after the button left the screen does
 * nothing. The button is usable again when the browser shows this page again from its back-forward cache.
 */
function useLeaveForGitHub<T>(
  unsaved: boolean,
  start: () => Promise<T>,
  go: (answer: T) => void,
  failed: (failure: unknown) => void,
) {
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false)
  const unsavedNow = useRef(unsaved)
  unsavedNow.current = unsaved
  // A layout effect: its cleanup runs as the button leaves the screen, before any passive cleanup.
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    const shown = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false)
    }
    window.addEventListener("pageshow", shown)
    return () => window.removeEventListener("pageshow", shown)
  }, [])
  const leave = async () => {
    setBusy(true)
    let answer: T
    try {
      answer = await start()
    } catch (failure) {
      if (!mounted.current) return
      failed(failure)
      setBusy(false)
      return
    }
    if (!mounted.current) return
    // Changes made while the request ran: stay, and the row says to save or discard them first.
    if (unsavedNow.current) {
      setBusy(false)
      return
    }
    go(answer)
  }
  return { busy, leave }
}

/** A leave for GitHub: its button, disabled with a line that says why while the Settings draft has changes. */
function LeaveRow({
  label,
  hint,
  action,
  busyText,
  busy,
  unsaved,
  blocked = false,
  onLeave,
}: {
  label: string
  hint: string
  action: string
  busyText: string
  busy: boolean
  unsaved: boolean
  /** Disabled for another reason the row already shows. */
  blocked?: boolean
  onLeave: () => void
}) {
  const { t } = useI18n()
  const noteId = useId()
  return (
    <Row label={label} hint={hint}>
      <button
        type="button"
        className="ui-btn ui-btn-primary"
        disabled={busy || unsaved || blocked}
        aria-describedby={unsaved ? noteId : undefined}
        onClick={onLeave}
      >
        {busy ? busyText : action}
      </button>
      {unsaved ? (
        <span id={noteId} className="ui-hint">
          {t("githubSettings.saveFirst")}
        </span>
      ) : null}
    </Row>
  )
}

/** The App made from a manifest: the primary action while no App is set and nothing is locked. */
export function CreateAppRow({ unsaved, finishing }: { unsaved: boolean; finishing: boolean }) {
  const { t, language } = useI18n()
  const { busy, leave } = useLeaveForGitHub(
    unsaved,
    () => api.startGitHubApp(),
    (form) => leaveFor.manifest(form.action, form.manifest),
    (failure) =>
      showToast(t("githubSettings.createStartFailed", { reason: githubErrorText(t, language, failure) }), "error"),
  )
  return (
    <LeaveRow
      label={t("githubSettings.createLabel")}
      hint={t("githubSettings.createHint")}
      action={t("githubSettings.create")}
      busyText={t("githubSettings.creating")}
      busy={busy}
      // While GitHub's return is being finished, no second creation starts.
      blocked={finishing}
      unsaved={unsaved}
      onLeave={() => void leave()}
    />
  )
}

/** The result of GitHub's return after it created the App: saved with its owner and fingerprint, or what to do. */
export function CreateResult({ result, onDismiss }: { result: GitHubReturn; onDismiss: () => void }) {
  const { t, language } = useI18n()
  const close = (
    <button type="button" className="ui-btn ui-btn-sm" onClick={onDismiss}>
      {t("githubSettings.dismiss")}
    </button>
  )
  if (result.kind === "creating") return <Banner tone="info" title={t("githubSettings.finishing")} />
  if (result.kind === "created")
    return (
      <Banner tone="ok" title={t("githubSettings.created")} action={close}>
        {t("githubSettings.createdOwner", { login: result.login })}
        {result.fingerprint ? (
          <span className="ui-github-fingerprint">
            {" "}
            <span className="ui-muted">{t("githubSettings.fingerprint")}</span> <Copyable value={result.fingerprint} />
          </span>
        ) : null}
      </Banner>
    )
  if (result.kind === "createFailed")
    return (
      <Banner tone="fail" title={t("githubSettings.createFailed")} action={close}>
        {githubErrorText(t, language, result.error)}. {t("githubSettings.createRecovery")}
      </Banner>
    )
  return null
}

/** GitHub's install page, from the installations while the App is set and the list is not locked. */
export function InstallRow({ unsaved }: { unsaved: boolean }) {
  const { t, language } = useI18n()
  const { busy, leave } = useLeaveForGitHub(
    unsaved,
    () => api.gitHubInstallLink(),
    ({ url }) => leaveFor.page(url),
    (failure) =>
      showToast(t("githubSettings.installFailed", { reason: githubErrorText(t, language, failure) }), "error"),
  )
  return (
    <LeaveRow
      label={t("githubSettings.installLabel")}
      hint={t("githubSettings.installHint")}
      action={t("githubSettings.install")}
      busyText={t("githubSettings.installing")}
      busy={busy}
      unsaved={unsaved}
      onLeave={() => void leave()}
    />
  )
}

/**
 * GitHub's return after Connect an account: an organization's request waits for its owner; otherwise the account is
 * being connected, was connected (or was on the list already), or could not be, with what to do.
 */
export function InstallReturn({ result, onDismiss }: { result: GitHubReturn; onDismiss: () => void }) {
  const { t, language } = useI18n()
  const close = (
    <button type="button" className="ui-btn ui-btn-sm" onClick={onDismiss}>
      {t("githubSettings.dismiss")}
    </button>
  )
  if (result.kind === "request")
    return (
      <Banner tone="info" title={t("githubSettings.requestTitle")} action={close}>
        {t("githubSettings.requestBody")}
      </Banner>
    )
  if (result.kind === "connecting") return <Banner tone="info" title={t("githubSettings.connecting")} />
  if (result.kind === "connected")
    return (
      <Banner
        tone="ok"
        title={t(result.added ? "githubSettings.connected" : "githubSettings.alreadyConnected", { name: result.login })}
        action={close}
      >
        {result.added ? t("githubSettings.connectedHint") : null}
      </Banner>
    )
  if (result.kind === "connectFailed")
    return (
      <Banner tone="fail" title={t("githubSettings.connectFailed")} action={close}>
        {githubErrorText(t, language, result.error)}. {t("githubSettings.connectRecovery")}
      </Banner>
    )
  return null
}
