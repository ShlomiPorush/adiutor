// Quick add from anywhere (button in the top bar, or N): a line of text and an optional project,
// sent to POST /capture. Without a project it lands in the inbox. A dialog with typed input: a
// click outside does not close it, and closing with text asks before dropping it (v3 DS-9).

import { useQuery } from "@tanstack/react-query"
import { type FormEvent, useId, useState } from "react"
import { LIMITS } from "../../shared/api.ts"
import { ApiError } from "../api/client.ts"
import { api, qk } from "../api/endpoints.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { confirmDialog } from "../ui/confirm.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { errorReason } from "../ui/states.tsx"
import { showToast } from "../ui/Toast.tsx"
import { useOpenItem, useRefreshItems } from "./items.ts"

const CAPTURE_MAX = LIMITS.body

export function QuickAdd({ onClose, projectId: initialProject = "" }: { onClose: () => void; projectId?: string }) {
  const { t, language } = useI18n()
  const textId = useId()
  const projectFieldId = useId()
  const errorId = useId()
  const [text, setText] = useState("")
  const [projectId, setProjectId] = useState(initialProject)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const projects = useQuery({ queryKey: qk.projects, queryFn: api.projects, staleTime: 60_000 })
  const openItem = useOpenItem()
  const refresh = useRefreshItems()
  const dirty = text.trim() !== "" || projectId !== initialProject

  const close = async () => {
    if (dirty && !busy) {
      const discard = await confirmDialog({
        title: t("unsaved.discardTitle"),
        message: t("unsaved.discardMessage"),
        confirmText: t("unsaved.discard"),
        cancelText: t("unsaved.keepEditing"),
        focusCancel: true,
      })
      if (!discard) return
    }
    onClose()
  }

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    const value = text.trim()
    if (!value) {
      setError(t("quickAdd.empty"))
      document.getElementById(textId)?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      const item = await api.capture(value, projectId || null)
      await refresh()
      onClose()
      const project = projects.data?.find((entry) => entry.id === projectId)
      showToast(project ? t("quickAdd.addedTo", { project: project.name }) : t("quickAdd.addedToInbox"), "success", {
        action: {
          label: t("common.open"),
          ariaLabel: t("quickAdd.openAdded", { title: item.title }),
          onAction: () => openItem(item.id),
        },
        duration: 6000,
      })
    } catch (failure) {
      setBusy(false)
      setError(
        failure instanceof ApiError && failure.code === "secret_suspected"
          ? t("errors.secretSuspected")
          : t("quickAdd.failed", { reason: errorReason(language, failure) }),
      )
    }
  }

  return (
    <Dialog
      size="sm"
      title={t("quickAdd.title")}
      onClose={() => void close()}
      initialFocus={() => document.getElementById(textId)}
      foot={
        <>
          <button type="button" className="ui-btn" onClick={() => void close()} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" form={`${textId}-form`} className="ui-btn ui-btn-primary" disabled={busy}>
            {busy ? t("quickAdd.adding") : t("quickAdd.add")}
          </button>
        </>
      }
    >
      <form id={`${textId}-form`} className="ui-form-stack" onSubmit={submit} noValidate>
        <div className="ui-field">
          <label className="ui-label" htmlFor={textId}>
            {t("quickAdd.text")}
          </label>
          <textarea
            id={textId}
            className="ui-textarea"
            dir="auto"
            rows={3}
            maxLength={CAPTURE_MAX}
            value={text}
            placeholder={t("quickAdd.placeholder")}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void submit()
            }}
          />
          {error ? (
            <p id={errorId} className="ui-field-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="ui-hint">{t("quickAdd.hint")}</p>
          )}
        </div>
        <div className="ui-field">
          <label className="ui-label" htmlFor={projectFieldId}>
            {t("quickAdd.project")}
          </label>
          <select
            id={projectFieldId}
            className="ui-select"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">{t("quickAdd.noProject")}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      </form>
    </Dialog>
  )
}
