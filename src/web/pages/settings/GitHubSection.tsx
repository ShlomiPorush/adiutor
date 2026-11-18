// Settings, GitHub: the server reads GitHub's security alerts and open Issues counts itself, through the owner's GitHub
// App, read only, and only the installations listed here (GET /api/v1/github). The section refreshes by itself, every
// few seconds while a read runs.
//
// Its groups: the App (its id and its private key, fields of the page's one draft and its save bar, SV-1, saved to
// PATCH /github/app with the generation of the view; the key is a secret, FS-3: never shown back, a paste field only
// while there is none or on Replace, and emptied from the draft after the save or a refusal); the installations
// (added by id and removed after a question at once, outside the save bar, like the agent connections); the last
// read with Read now (locked while GitHub is not set up or GitHub asked to wait, FB-1); and the projects GitHub
// cannot read: repositories that moved, projects without current data and projects without a repository, each
// opening its project.

import { useQueryClient } from "@tanstack/react-query"
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { Link } from "react-router"
import { ApiError } from "../../api/client.ts"
import { api, qk } from "../../api/endpoints.ts"
import type {
  GitHubAppPatch,
  GitHubInstallation,
  GitHubInstallationState,
  GitHubNotCoveredReason,
  GitHubState,
  GitHubView,
} from "../../api/types.ts"
import { formatTime } from "../../format/datetime.ts"
import { formatNumber } from "../../format/number.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { Copyable } from "../../ui/Copyable.tsx"
import { confirmDialog } from "../../ui/confirm.tsx"
import { EVERY, usePageQuery } from "../../ui/refresh.ts"
import { Banner, Empty, ErrorState, errorReason, Loading, Locked } from "../../ui/states.tsx"
import { Time } from "../../ui/Time.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tag, type Tone } from "../../ui/tags.tsx"
import { Fact, Facts, Group, Row } from "./parts.tsx"

/** The App id and an installation id: the numbers GitHub shows. */
export const GITHUB_ID = /^[1-9][0-9]{0,15}$/
/** A pasted private key in PEM form: the server reads it, this only catches a paste of something else. */
export const PEM_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/

/** How often the section reads while a pull runs, so its end shows soon. */
export const RUNNING_EVERY = 3_000

/** The GitHub view as Settings reads it: the page's draft and the section share the one read. */
export function useGitHubView(every: number = EVERY.slow) {
  return usePageQuery({ queryKey: qk.github, queryFn: api.github, every })
}

/** The key in the draft: replaced by a pasted one, or removed on save. */
export type GitHubKeyDraft = { mode: "replace"; value: string } | { mode: "remove" }

/** The GitHub fields of the Settings draft, as typed. */
/**
 * The App's fields in the one draft, with the generation of the view the first edit was made on: a save is refused
 * (409) when the settings changed since, even after the page refreshed underneath the draft.
 */
export type GitHubDraft = { githubAppId?: string; githubKey?: GitHubKeyDraft; githubBasedOn?: number }

/** What a save of the App sends: only what differs from the settings in effect, never a locked field (SV-2). */
export function githubChanges(view: GitHubView | undefined, draft: GitHubDraft): GitHubAppPatch {
  if (!view) return {}
  const { appId, key } = view.settings
  const patch: GitHubAppPatch = {}
  if (!appId.locked && draft.githubAppId !== undefined) {
    const typed = draft.githubAppId.trim()
    if (typed !== (appId.value ?? "")) patch.appId = typed || null
  }
  if (!key.locked && draft.githubKey?.mode === "replace" && draft.githubKey.value.trim())
    patch.privateKey = draft.githubKey.value.trim()
  if (!key.locked && draft.githubKey?.mode === "remove" && key.set) patch.privateKey = null
  return patch
}

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

/** The parts of the Settings draft this section edits (SettingsPage's form). */
export type GitHubForm = {
  draft: GitHubDraft
  set(change: GitHubDraft): void
  ids: { githubAppId: string; githubKey: string }
  fieldError(field: "githubAppId" | "githubKey"): ReactNode
  invalid(field: "githubAppId" | "githubKey"): Record<string, unknown>
  /** Opens a field's section and brings it into view with the focus. */
  focus(field: "githubAppId" | "githubKey"): void
}

const STATE_TONE: Record<GitHubState, Tone> = { off: "neutral", not_read: "warn", not_covered: "warn", fine: "ok" }
const INSTALLATION_TONE: Record<GitHubInstallationState, Tone> = {
  usable: "ok",
  too_broad: "fail",
  suspended: "warn",
  uninstalled: "warn",
  other_account: "fail",
  error: "fail",
}
const REASON_TONE: Record<GitHubNotCoveredReason, Tone> = { no_access: "warn", stale: "warn", never: "neutral" }
const OUTCOME_TONE = { succeeded: "ok", partial: "warn", failed: "fail" } as const
/** The families of alerts by how they were read, in the order the owner reads them. */
const FAMILY_COUNTS = ["enabled", "not_enabled", "no_access", "error"] as const

/** A rate limit that still holds, by this browser's clock. */
export function rateLimited(view: GitHubView, now = Date.now()): boolean {
  return view.rateLimitedUntil !== null && new Date(view.rateLimitedUntil).getTime() > now
}

/** Why Read now cannot be pressed, or null when it can (FB-1). */
export function readNowBlocked(view: GitHubView, now = Date.now()): "not_set_up" | "rate_limited" | null {
  if (!view.settings.on) return "not_set_up"
  if (rateLimited(view, now)) return "rate_limited"
  return null
}

/** The Settings section. */
export function GitHubSection({ form }: { form: GitHubForm }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  // Faster while a read runs: the view that shows says whether one does.
  const running = queryClient.getQueryData<GitHubView>(qk.github)?.running ?? false
  const query = useGitHubView(running ? RUNNING_EVERY : EVERY.live)
  const view = query.data
  // A read that ended changed the board and the list of runs: read them again.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && view && !view.running) {
      void queryClient.invalidateQueries({ queryKey: qk.morning })
      void queryClient.invalidateQueries({ queryKey: qk.syncRuns })
    }
    wasRunning.current = view?.running ?? false
  }, [view, queryClient])
  const retry = () => void query.refetch()
  if (query.isPending) return <Loading label={t("githubSettings.loading")} />
  if (!view) return <ErrorState title={t("githubSettings.failed")} error={query.error} onRetry={retry} />
  return (
    <>
      {query.isError ? (
        <Banner
          tone="warn"
          title={t("githubSettings.refreshFailed")}
          action={
            <button type="button" className="ui-btn ui-btn-sm" onClick={retry}>
              {t("common.tryAgain")}
            </button>
          }
        />
      ) : null}
      <AppGroup view={view} form={form} />
      <InstallationsGroup view={view} form={form} />
      <PullGroup view={view} />
      <MovedGroup view={view} />
      <NotCoveredGroup view={view} />
      <WithoutRepoGroup view={view} />
    </>
  )
}

/** A stale view (409 conflict): read the settings again and say so. */
function useStale() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  return async (error: unknown): Promise<boolean> => {
    if (!(error instanceof ApiError && error.code === "conflict")) return false
    showToast(t("githubSettings.conflict"), "warning")
    await queryClient.invalidateQueries({ queryKey: qk.github })
    return true
  }
}

/** The App id and the private key: fields of the page's one draft, saved with the save bar. */
function AppGroup({ view, form }: { view: GitHubView; form: GitHubForm }) {
  const { t } = useI18n()
  const { draft, set, ids, fieldError, invalid } = form
  const { appId, key } = view.settings
  const edit = (patch: GitHubDraft) => {
    const next = { ...draft, ...patch }
    const empty = next.githubAppId === undefined && next.githubKey === undefined
    set({ ...patch, githubBasedOn: empty ? undefined : (draft.githubBasedOn ?? view.settings.generation) })
  }
  const appLock = appId.locked ? { variable: appId.variable } : null
  const keyLock = key.locked ? { variable: key.variable } : null
  // A locked field shows what the environment sets, never an edit made before it was locked.
  const typedAppId = (appLock ? undefined : draft.githubAppId) ?? appId.value ?? ""
  return (
    <Group id="settings-github-app" title={t("githubSettings.appTitle")} intro={t("githubSettings.appIntro")}>
      <Row
        label={t("githubSettings.appId")}
        hint={t("githubSettings.appIdHint")}
        htmlFor={ids.githubAppId}
        lock={appLock}
        onClear={typedAppId.trim() ? () => edit({ githubAppId: "" }) : null}
      >
        <input
          id={ids.githubAppId}
          className="ui-input"
          inputMode="numeric"
          dir="ltr"
          maxLength={16}
          autoComplete="off"
          disabled={Boolean(appLock)}
          placeholder={appLock ? t("settings.env.pill") : t("githubSettings.notSet")}
          value={typedAppId}
          {...invalid("githubAppId")}
          onChange={(event) => edit({ githubAppId: event.target.value })}
        />
        {fieldError("githubAppId")}
      </Row>
      <Row label={t("githubSettings.key")} hint={t("githubSettings.keyHint")} htmlFor={ids.githubKey} lock={keyLock}>
        <KeyField
          id={ids.githubKey}
          saved={key}
          draft={draft.githubKey}
          onChange={(githubKey) => edit({ githubKey })}
          invalidProps={invalid("githubKey")}
        />
        {fieldError("githubKey")}
      </Row>
    </Group>
  )
}

/**
 * The private key: never shown. Stored, with its fingerprint (as GitHub lists it beside each key of the App), Replace
 * and Remove; a paste field while there is none, on Replace, or when the stored one cannot be read (FS-3).
 */
function KeyField({
  id,
  saved,
  draft,
  onChange,
  invalidProps,
}: {
  id: string
  saved: GitHubView["settings"]["key"]
  draft: GitHubKeyDraft | undefined
  onChange: (next: GitHubKeyDraft | undefined) => void
  invalidProps: Record<string, unknown>
}) {
  const { t } = useI18n()
  const fingerprint = saved.fingerprint ? (
    <span className="ui-github-fingerprint">
      <span className="ui-muted">{t("githubSettings.fingerprint")}</span> <Copyable value={saved.fingerprint} />
    </span>
  ) : null
  const verification =
    saved.verified === true ? (
      <Tag tone="ok">{t("githubSettings.keyAccepted")}</Tag>
    ) : saved.verified === false && saved.set && saved.readable ? (
      <Tag tone="warn">{t("githubSettings.keyNotVerified")}</Tag>
    ) : null
  if (saved.locked)
    return (
      <>
        <span id={id} tabIndex={-1} className={`ui-set-secret${saved.readable ? "" : " is-removing"}`}>
          {saved.readable ? t("githubSettings.keySetByEnv") : t("githubSettings.keyEnvUnreadable")}
        </span>
        {fingerprint}
      </>
    )
  const paste = (
    <textarea
      id={id}
      className="ui-textarea ui-github-key"
      dir="ltr"
      rows={4}
      maxLength={10_000}
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      placeholder={t("githubSettings.keyPlaceholder")}
      value={draft?.mode === "replace" ? draft.value : ""}
      {...invalidProps}
      onChange={(event) => onChange({ mode: "replace", value: event.target.value })}
      // biome-ignore lint/a11y/noAutofocus: Replace puts the cursor where the new key goes (v3 FS-3)
      autoFocus={draft?.mode === "replace" && saved.set && saved.readable}
    />
  )
  if (!saved.set) return paste
  if (!saved.readable && draft?.mode !== "remove")
    return (
      <>
        <span className="ui-set-secret is-removing">{t("githubSettings.keyUnreadable")}</span>
        {paste}
        <button type="button" className="ui-link-btn" onClick={() => onChange({ mode: "remove" })}>
          {t("githubSettings.keyRemove")}
        </button>
      </>
    )
  if (draft?.mode === "replace")
    return (
      <>
        {paste}
        <button type="button" className="ui-link-btn" onClick={() => onChange(undefined)}>
          {t("githubSettings.keyKeep")}
        </button>
      </>
    )
  return (
    <>
      <span className="ui-set-secret-row">
        <span className={`ui-set-secret${draft?.mode === "remove" ? " is-removing" : ""}`}>
          {draft?.mode === "remove" ? t("githubSettings.keyRemovedOnSave") : t("githubSettings.keyStored")}
        </span>
        {draft?.mode === "remove" ? (
          <button type="button" className="ui-btn ui-btn-sm" onClick={() => onChange(undefined)}>
            {t("githubSettings.keyKeep")}
          </button>
        ) : (
          <>
            <button
              id={id}
              type="button"
              className="ui-btn ui-btn-sm"
              onClick={() => onChange({ mode: "replace", value: "" })}
            >
              {t("githubSettings.keyReplace")}
            </button>
            <button type="button" className="ui-btn ui-btn-sm" onClick={() => onChange({ mode: "remove" })}>
              {t("githubSettings.keyRemove")}
            </button>
          </>
        )}
      </span>
      {draft?.mode === "remove" ? null : (
        <span className="ui-github-key-state">
          {verification}
          {fingerprint}
        </span>
      )}
      {saved.verified === false && draft?.mode !== "remove" ? (
        <span className="ui-hint">{t("githubSettings.keyNotVerifiedHint")}</span>
      ) : null}
    </>
  )
}

/** An account's name as GitHub gave it, or its id while it is not known (an installation the environment lists). */
const accountName = (installation: { id: number; login: string | null }, unknown: string) =>
  installation.login || `${unknown} ${installation.id}`

/** The installations the server may read: added by id and removed at once, outside the save bar. */
function InstallationsGroup({ view, form }: { view: GitHubView; form: GitHubForm }) {
  const { t, tc, language } = useI18n()
  const queryClient = useQueryClient()
  const stale = useStale()
  const fieldId = useId()
  const errorId = `${fieldId}-error`
  const [typed, setTyped] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<number | null>(null)
  const { installations: allowed, appId, key } = view.settings
  const locked = allowed.locked
  const setUp = Boolean(appId.value) && key.set && key.readable
  const unknown = t("githubSettings.installation")

  const add = async (event: FormEvent) => {
    event.preventDefault()
    const text = typed.trim()
    if (!text) return
    if (!GITHUB_ID.test(text) || !Number.isSafeInteger(Number(text))) {
      setError(t("githubSettings.installationIdInvalid"))
      return
    }
    setAdding(true)
    setError(null)
    try {
      const next = await api.addGitHubInstallation(view.settings.generation, Number(text))
      queryClient.setQueryData(qk.github, next)
      const added = next.installations.find((installation) => installation.id === Number(text))
      showToast(t("githubSettings.added", { name: added ? accountName(added, unknown) : text }), "success")
      // Only a success empties the field, so a typo is not lost (FS-16).
      setTyped("")
    } catch (failure) {
      if (await stale(failure)) return
      const reason = githubErrorText(t, language, failure)
      setError(reason)
      showToast(t("githubSettings.addFailed", { reason }), "error")
    } finally {
      setAdding(false)
    }
  }

  const remove = async (installation: GitHubInstallation) => {
    const name = accountName(installation, unknown)
    const ok = await confirmDialog({
      title: t("githubSettings.removeTitle", { name }),
      message: t("githubSettings.removeMessage", { name }),
      confirmText: t("githubSettings.remove"),
      danger: true,
    })
    if (!ok) return
    setRemoving(installation.id)
    try {
      const next = await api.removeGitHubInstallation(view.settings.generation, installation.id)
      queryClient.setQueryData(qk.github, next)
      showToast(t("githubSettings.removed", { name }), "success")
    } catch (failure) {
      if (await stale(failure)) return
      showToast(t("githubSettings.removeFailed", { name, reason: githubErrorText(t, language, failure) }), "error")
    } finally {
      setRemoving(null)
    }
  }

  return (
    <Group
      id="settings-github-installations"
      title={t("githubSettings.installationsTitle")}
      count={view.installations.length}
      intro={
        locked
          ? t("githubSettings.installationsLocked", { variable: allowed.variable ?? "" })
          : t("githubSettings.installationsIntro")
      }
    >
      {view.installations.length === 0 ? (
        <Empty title={t("githubSettings.installationsEmpty")} hint={t("githubSettings.installationsEmptyHint")} />
      ) : null}
      {view.installations.map((installation) => {
        const name = accountName(installation, unknown)
        const type = installation.accountType
        return (
          <div
            key={installation.id}
            className="ui-item"
            data-tone={installation.state ? INSTALLATION_TONE[installation.state] : undefined}
            data-testid="github-installation"
          >
            <div className="ui-item-main">
              <span className="ui-item-title">
                <bdi dir="auto">{name}</bdi>{" "}
                {type ? (
                  <Tag tone="neutral">
                    {type === "User" || type === "Organization" ? t(`githubSettings.accountType.${type}`) : type}
                  </Tag>
                ) : null}{" "}
                <Tag tone={installation.state ? INSTALLATION_TONE[installation.state] : "neutral"}>
                  {t(`githubSettings.installationState.${installation.state ?? "not_read"}`)}
                </Tag>
              </span>
              <span className="ui-item-meta">
                <span>
                  {t("githubSettings.installationId")} <Copyable value={String(installation.id)} />
                </span>
                <span>
                  {installation.inventory
                    ? installation.inventory.complete
                      ? tc("githubSettings.repos", installation.inventory.repos)
                      : tc("githubSettings.reposIncomplete", installation.inventory.repos)
                    : t("githubSettings.reposUnknown")}
                </span>
              </span>
              {installation.state && installation.state !== "usable" ? (
                <span className="ui-item-meta">{t(`githubSettings.installationHint.${installation.state}`)}</span>
              ) : null}
            </div>
            {locked ? null : (
              <div className="ui-item-end">
                <button
                  type="button"
                  className="ui-btn ui-btn-sm ui-btn-danger"
                  disabled={removing === installation.id}
                  onClick={() => void remove(installation)}
                >
                  {removing === installation.id ? t("githubSettings.removing") : t("githubSettings.remove")}
                </button>
              </div>
            )}
          </div>
        )
      })}
      {locked ? null : setUp ? (
        <Row label={t("githubSettings.addLabel")} hint={t("githubSettings.addHint")} htmlFor={fieldId}>
          <form className="ui-domain-add" onSubmit={(event) => void add(event)} noValidate>
            <input
              id={fieldId}
              className="ui-input"
              inputMode="numeric"
              dir="ltr"
              maxLength={16}
              autoComplete="off"
              placeholder={t("githubSettings.addPlaceholder")}
              value={typed}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => {
                setTyped(event.target.value)
                setError(null)
              }}
            />
            <button type="submit" className="ui-btn" disabled={adding || !typed.trim()}>
              {adding ? t("githubSettings.adding") : t("githubSettings.add")}
            </button>
          </form>
          {error ? (
            <p id={errorId} className="ui-field-error">
              {error}
            </p>
          ) : null}
        </Row>
      ) : (
        <div className="ui-set-locked">
          <Locked
            title={t("githubSettings.addLocked")}
            action={
              <button
                type="button"
                className="ui-btn ui-btn-sm"
                onClick={() => form.focus(appId.value || appId.locked ? "githubKey" : "githubAppId")}
              >
                {t("githubSettings.setUpApp")}
              </button>
            }
          >
            {t("githubSettings.addNeeds")}
          </Locked>
        </div>
      )}
    </Group>
  )
}

/** The last read, the state of the data, and Read now (locked while it cannot run, FB-1). */
function PullGroup({ view }: { view: GitHubView }) {
  const { t, tc, language } = useI18n()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const blocked = readNowBlocked(view)
  const run = view.lastRun
  const counts = run?.counts ?? {}
  const unknown = t("githubSettings.installation")
  const failedInstallations = (run?.errors ?? []).flatMap((error) => {
    if (!error.record.startsWith("installation:")) return []
    const id = Number(error.record.slice("installation:".length))
    const known = view.installations.find((installation) => installation.id === id)
    return [known ? accountName(known, unknown) : `${unknown} ${id}`]
  })
  const readNow = async () => {
    setBusy(true)
    try {
      const { joined, view: next } = await api.readGitHub()
      queryClient.setQueryData(qk.github, next)
      showToast(joined ? t("githubSettings.readJoined") : t("githubSettings.readStarted"), "info")
    } catch (failure) {
      showToast(t("githubSettings.readFailed", { reason: githubErrorText(t, language, failure) }), "error")
      await queryClient.invalidateQueries({ queryKey: qk.github })
    } finally {
      setBusy(false)
    }
  }
  const status = view.status
  return (
    <Group
      id="settings-github-pull"
      title={t("githubSettings.pullTitle")}
      extra={
        <button
          type="button"
          className="ui-btn ui-btn-sm"
          disabled={busy || blocked !== null}
          title={blocked ? t(`githubSettings.readBlocked.${blocked}`) : undefined}
          onClick={() => void readNow()}
        >
          {busy ? t("githubSettings.reading") : t("githubSettings.readNow")}
        </button>
      }
      intro={
        blocked === "not_set_up" ? (
          t("githubSettings.readBlocked.not_set_up")
        ) : blocked === "rate_limited" && view.rateLimitedUntil ? (
          <span className="ui-text-warn">
            {t("githubSettings.rateLimited")} <Time value={view.rateLimitedUntil} mode="full" />
          </span>
        ) : (
          t("githubSettings.pullIntro")
        )
      }
    >
      <Facts>
        <Fact label={t("githubSettings.dataState")}>
          <Tag tone={STATE_TONE[status.state]}>
            {status.state === "not_covered"
              ? tc("githubSettings.state.not_covered", status.notCovered)
              : t(`githubSettings.state.${status.state}`)}
          </Tag>
          {status.state === "not_covered" && status.oldestGoodReadAt ? (
            <span className="ui-muted">
              {t("githubSettings.oldestRead")} <Time value={status.oldestGoodReadAt} mode="full" />
            </span>
          ) : null}
        </Fact>
        <Fact label={t("githubSettings.lastRead")}>
          {view.running ? <Tag tone="info">{t("githubSettings.running")}</Tag> : null}
          {run ? (
            <>
              <Time value={run.finishedAt ?? run.startedAt} mode="full" />
              {run.outcome ? <Tag tone={OUTCOME_TONE[run.outcome]}>{t(`settings.outcome.${run.outcome}`)}</Tag> : null}
            </>
          ) : view.running ? null : (
            t("githubSettings.neverRead")
          )}
        </Fact>
        {run ? (
          <>
            <Fact label={t("githubSettings.accountsRead")}>
              {t("githubSettings.ofTotal", {
                done: formatNumber(counts.installationsRead ?? 0),
                total: formatNumber(counts.installations ?? 0),
              })}
            </Fact>
            <Fact label={t("githubSettings.reposRead")}>
              {t("githubSettings.ofTotal", {
                done: formatNumber(counts.projectsWritten ?? 0),
                total: formatNumber(counts.projects ?? 0),
              })}
            </Fact>
            <Fact label={t("githubSettings.families")}>
              <span>
                {FAMILY_COUNTS.map((coverage) =>
                  t("githubSettings.familyCount", {
                    label: t(`security.coverage.${coverage}`),
                    count: formatNumber(counts[coverage] ?? 0),
                  }),
                ).join(t("common.listSeparator"))}
              </span>
            </Fact>
            {failedInstallations.length > 0 ? (
              <Fact label={t("githubSettings.failedAccounts")}>
                <span className="ui-text-warn">
                  <bdi dir="auto">{failedInstallations.join(t("common.listSeparator"))}</bdi>
                </span>
              </Fact>
            ) : null}
          </>
        ) : null}
      </Facts>
    </Group>
  )
}

/** A project's name, opening its page. */
function ProjectLink({ id, name }: { id: string; name: string }) {
  return (
    <Link to={`/projects/${id}`} className="ui-item-title ui-link">
      <bdi dir="auto">{name}</bdi>
    </Link>
  )
}

/** A repository, left to right in every language. */
function Repo({ value }: { value: string }) {
  return (
    <span className="ui-mono" dir="ltr">
      {value}
    </span>
  )
}

/** Repositories GitHub knows under a new name: the owner sets the new one on the project's page. */
function MovedGroup({ view }: { view: GitHubView }) {
  const { t } = useI18n()
  if (view.moved.length === 0) return null
  return (
    <Group
      id="settings-github-moved"
      title={t("githubSettings.movedTitle")}
      count={view.moved.length}
      intro={t("githubSettings.movedIntro")}
    >
      {view.moved.map((entry) => (
        <div key={entry.id} className="ui-item" data-tone="warn">
          <div className="ui-item-main">
            <ProjectLink id={entry.id} name={entry.name} />
            <span className="ui-item-meta">
              {entry.repo
                ? t("githubSettings.movedFromTo", { from: entry.repo, to: entry.movedTo })
                : t("githubSettings.movedNow", { to: entry.movedTo })}
            </span>
          </div>
        </div>
      ))}
    </Group>
  )
}

/** Projects with a repository and no current GitHub data, with the reason and the last good read. */
function NotCoveredGroup({ view }: { view: GitHubView }) {
  const { t } = useI18n()
  if (view.notCovered.length === 0) return null
  return (
    <Group
      id="settings-github-not-covered"
      title={t("githubSettings.notCoveredTitle")}
      count={view.notCovered.length}
      intro={t("githubSettings.notCoveredIntro")}
    >
      {view.notCovered.map((entry) => (
        <div key={entry.id} className="ui-item" data-tone={REASON_TONE[entry.reason]}>
          <div className="ui-item-main">
            <ProjectLink id={entry.id} name={entry.name} />
            <span className="ui-item-meta">
              <Repo value={entry.repo} />
              <Tag tone={REASON_TONE[entry.reason]}>{t(`githubSettings.reason.${entry.reason}`)}</Tag>
              <span>
                {entry.lastGoodReadAt ? (
                  <>
                    {t("githubSettings.lastGoodRead")} <Time value={entry.lastGoodReadAt} mode="full" />
                  </>
                ) : (
                  t("githubSettings.neverGoodRead")
                )}
              </span>
            </span>
          </div>
        </div>
      ))}
    </Group>
  )
}

/** Projects without a repository: GitHub is not read for them; each opens its page, where the repository is set. */
function WithoutRepoGroup({ view }: { view: GitHubView }) {
  const { t } = useI18n()
  if (view.withoutRepo.length === 0) return null
  return (
    <Group
      id="settings-github-without-repo"
      title={t("githubSettings.withoutRepoTitle")}
      count={view.withoutRepo.length}
      intro={t("githubSettings.withoutRepoIntro")}
    >
      {view.withoutRepo.map((entry) => (
        <div key={entry.id} className="ui-item">
          <div className="ui-item-main">
            <ProjectLink id={entry.id} name={entry.name} />
          </div>
        </div>
      ))}
    </Group>
  )
}
