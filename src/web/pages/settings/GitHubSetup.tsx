// Settings, GitHub: the App made from a manifest and the installations added after GitHub's install page, both through
// GitHub's own pages in this tab. Create posts the manifest form to GitHub; GitHub sends the browser back to
// /settings/github with `code` and `state` (the App was created) or `installation_id` and `setup_action` (it was
// installed). Those parameters leave the address before anything else, so a reload or Back never repeats them; the
// code is then exchanged once, and an installation is only shown until the owner adds it with his own click.

import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { ApiError } from "../../api/client.ts"
import { api, qk } from "../../api/endpoints.ts"
import type { GitHubInstallationPreview, GitHubPreviewState, GitHubView } from "../../api/types.ts"
import { formatTime } from "../../format/datetime.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { Copyable } from "../../ui/Copyable.tsx"
import { Banner, errorReason } from "../../ui/states.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tag, type Tone } from "../../ui/tags.tsx"
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
  | { kind: "preview"; id: number; preview: GitHubInstallationPreview | null; error: unknown }

/**
 * Reads GitHub's return from the address once: the parameters are replaced away first, then the App's code is
 * exchanged (once, also under StrictMode's second run of the effect), or the installation is read for a preview.
 */
export function useGitHubReturn() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const handled = useRef(false)
  const [state, setState] = useState<GitHubReturn | null>(null)

  const preview = (id: number) => {
    setState({ kind: "preview", id, preview: null, error: null })
    api.previewGitHubInstallation(id).then(
      (answer) => setState({ kind: "preview", id, preview: answer, error: null }),
      (error: unknown) => setState({ kind: "preview", id, preview: null, error }),
    )
  }

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
    } else if (installation && INSTALLATION_ID.test(installation)) preview(Number(installation))
  }, [location.search])

  return { state, dismiss: () => setState(null), retryPreview: preview }
}

/**
 * Leaving this tab for GitHub: the server's answer, then the page goes. The buttons are disabled while the Settings
 * draft holds unsaved changes, so the page never leaves with a draft and the unsaved guards are never touched. An
 * answer that arrives after the section was left does nothing. The button is usable again when the browser shows
 * this page again from its back-forward cache.
 */
function useLeaveForGitHub<T>(start: () => Promise<T>, go: (answer: T) => void, failed: (failure: unknown) => void) {
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    const shown = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false)
    }
    window.addEventListener("pageshow", shown)
    return () => {
      mounted.current = false
      window.removeEventListener("pageshow", shown)
    }
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
    if (mounted.current) go(answer)
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
  onLeave,
}: {
  label: string
  hint: string
  action: string
  busyText: string
  busy: boolean
  unsaved: boolean
  onLeave: () => void
}) {
  const { t } = useI18n()
  const noteId = useId()
  return (
    <Row label={label} hint={hint}>
      <button
        type="button"
        className="ui-btn ui-btn-primary"
        disabled={busy || unsaved}
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
export function CreateAppRow({ unsaved }: { unsaved: boolean }) {
  const { t, language } = useI18n()
  const { busy, leave } = useLeaveForGitHub(
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

/** One tone per preview state, for its banner and its tag. */
const PREVIEW_TONE: Record<GitHubPreviewState, Exclude<Tone, "neutral">> = {
  usable: "info",
  too_broad: "fail",
  suspended: "warn",
  already_added: "ok",
  locked: "warn",
}

/**
 * GitHub's return after an install: an organization's request waits for its owner; otherwise the installation as
 * GitHub answers it, with Add for one that can be added. Nothing is added until the owner presses Add.
 */
export function InstallReturn({
  result,
  view,
  onDismiss,
  onRetry,
}: {
  result: GitHubReturn
  view: GitHubView
  onDismiss: () => void
  onRetry: (id: number) => void
}) {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
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
  if (result.kind !== "preview") return null
  if (result.error)
    return (
      <Banner
        tone="fail"
        title={t("githubSettings.previewFailed")}
        action={
          <span className="ui-banner-actions">
            <button type="button" className="ui-btn ui-btn-sm" onClick={() => onRetry(result.id)}>
              {t("common.tryAgain")}
            </button>
            {close}
          </span>
        }
      >
        {githubErrorText(t, language, result.error)}
      </Banner>
    )
  if (!result.preview) return <Banner tone="info" title={t("githubSettings.previewLoading")} />
  const { account, state } = result.preview
  const add = async () => {
    setAdding(true)
    try {
      const next = await api.addGitHubInstallation(view.settings.generation, result.id)
      queryClient.setQueryData(qk.github, next)
      showToast(t("githubSettings.added", { name: account.login || String(result.id) }), "success")
      onDismiss()
    } catch (failure) {
      showToast(t("githubSettings.addFailed", { reason: githubErrorText(t, language, failure) }), "error")
      if (failure instanceof ApiError && failure.code === "conflict")
        await queryClient.invalidateQueries({ queryKey: qk.github })
    } finally {
      setAdding(false)
    }
  }
  const type =
    account.type === "User" || account.type === "Organization"
      ? t(`githubSettings.accountType.${account.type}`)
      : account.type
  return (
    <Banner
      tone={PREVIEW_TONE[state]}
      title={t("githubSettings.previewTitle", { name: account.login || String(result.id) })}
      action={
        <span className="ui-banner-actions">
          {state === "usable" ? (
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-btn-primary"
              disabled={adding}
              onClick={() => void add()}
            >
              {adding ? t("githubSettings.adding") : t("githubSettings.add")}
            </button>
          ) : null}
          {close}
        </span>
      }
    >
      <Tag tone="neutral">{type}</Tag> <Tag tone={PREVIEW_TONE[state]}>{t(`githubSettings.previewState.${state}`)}</Tag>{" "}
      {t(`githubSettings.previewHint.${state}`, {
        variable: view.settings.installations.variable ?? "ADIUTOR_GITHUB_INSTALLATIONS",
        id: String(result.id),
      })}
    </Banner>
  )
}
