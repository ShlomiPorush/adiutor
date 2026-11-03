// All projects, filtered by stage (unset included) through chips whose counts are the rows a click
// shows. The filter lives in the address (?stage=poc, ?stage=unset); the sort order lives in memory.

import { type CSSProperties, type FormEvent, useId, useMemo, useState } from "react"
import { useNavigate, useSearchParams } from "react-router"
import { STAGES, type Stage } from "../../shared/enums.ts"
import { api, qk } from "../api/endpoints.ts"
import type { ProjectListEntry } from "../api/types.ts"
import { formatNumber } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { useDiscardGuard } from "../ui/confirm.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { Empty, ErrorState, errorReason, Loading, StaleNote } from "../ui/states.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Progress, StageTag } from "../ui/tags.tsx"
import { issuesUrl } from "./MorningPage.tsx"
import { rowKeys, selecting } from "./parts.tsx"

type StageFilter = Stage | "unset" | "all"
type SortKey = "name" | "stage" | "goal" | "open" | "proposals" | "issues"
type Sort = { key: SortKey; dir: "asc" | "desc" }

// The header order survives refreshes and page changes, not a reload (v3 TB-3).
let rememberedSort: Sort = { key: "open", dir: "desc" }

function parseStage(value: string | null): StageFilter {
  if (value === "unset") return "unset"
  return value && (STAGES as readonly string[]).includes(value) ? (value as Stage) : "all"
}

const STAGE_ORDER: Record<string, number> = Object.fromEntries(STAGES.map((stage, index) => [stage, index]))

function sortValue(project: ProjectListEntry, key: SortKey): string | number | null {
  switch (key) {
    case "name":
      return project.name.toLowerCase()
    case "stage":
      return project.stage ? (STAGE_ORDER[project.stage] ?? null) : null
    case "goal":
      return project.goal?.total ? project.goal.done / project.goal.total : null
    case "open":
      return project.openItems
    case "proposals":
      return project.openProposals
    case "issues":
      return project.openIssuesCount
  }
}

export function sortProjects(projects: ProjectListEntry[], sort: Sort): ProjectListEntry[] {
  return [...projects].sort((a, b) => {
    const x = sortValue(a, sort.key)
    const y = sortValue(b, sort.key)
    // Rows with no value stay last in both directions.
    if (x === null && y === null) return a.name.localeCompare(b.name)
    if (x === null) return 1
    if (y === null) return -1
    const order =
      typeof x === "string" && typeof y === "string"
        ? x.localeCompare(y, undefined, { sensitivity: "base" })
        : Number(x) - Number(y)
    return (sort.dir === "asc" ? order : -order) || a.name.localeCompare(b.name)
  })
}

export function ProjectsPage() {
  const { t, tc } = useI18n()
  usePageMeta(t("projects.title"))
  const [params, setParams] = useSearchParams()
  const stage = parseStage(params.get("stage"))
  const query = usePageQuery({ queryKey: qk.projects, queryFn: api.projects, every: EVERY.live })
  const [sort, setSortState] = useState<Sort>(rememberedSort)
  const [creating, setCreating] = useState(false)
  const setSort = (next: Sort) => {
    rememberedSort = next
    setSortState(next)
  }

  const projects = query.data ?? []
  const counts = useMemo(() => {
    const map: Record<string, number> = { all: projects.length, unset: 0 }
    for (const project of projects) {
      const key = project.stage ?? "unset"
      map[key] = (map[key] ?? 0) + 1
    }
    return map
  }, [projects])
  const shown = sortProjects(
    projects.filter(
      (project) => stage === "all" || (stage === "unset" ? project.stage === null : project.stage === stage),
    ),
    sort,
  )

  const pick = (next: StageFilter) =>
    setParams((current) => {
      if (next === "all") current.delete("stage")
      else current.set("stage", next)
      return current
    })

  return (
    <div className="ui-page">
      <PageHead
        title={t("projects.title")}
        description={t("projects.description")}
        actions={
          <button type="button" className="ui-btn" onClick={() => setCreating(true)}>
            {t("projects.new")}
          </button>
        }
      />
      <StaleNote failed={query.isError && !!query.data} />
      <fieldset className="ui-chips ui-plain-fieldset">
        <legend className="ui-sr-only">{t("projects.filterLegend")}</legend>
        {(["all", ...STAGES, "unset"] as StageFilter[]).map((option) => (
          <button
            key={option}
            type="button"
            className="ui-chip"
            aria-pressed={stage === option}
            onClick={() => pick(option)}
          >
            {option === "all"
              ? t("projects.allStages")
              : option === "unset"
                ? t("common.stageUnset")
                : t(`stage.${option}`)}
            <small>{formatNumber(counts[option] ?? 0)}</small>
          </button>
        ))}
      </fieldset>
      {query.data ? (
        <p className="ui-list-summary" aria-live="polite">
          <b>{tc("projects.count", shown.length)}</b>
        </p>
      ) : null}
      {query.isPending ? <Loading label={t("projects.loading")} /> : null}
      {query.isError && !query.data ? (
        <ErrorState title={t("projects.failed")} error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.data && shown.length === 0 ? (
        <div className="ui-panel">
          <Empty
            title={stage === "all" ? t("projects.empty") : t("projects.emptyFiltered")}
            hint={stage === "all" ? t("projects.emptyHint") : undefined}
          />
        </div>
      ) : null}
      {shown.length > 0 ? <SortableProjects projects={shown} sort={sort} onSort={setSort} /> : null}
      {creating ? <NewProjectDialog onClose={() => setCreating(false)} /> : null}
    </div>
  )
}

function SortableProjects({
  projects,
  sort,
  onSort,
}: {
  projects: ProjectListEntry[]
  sort: Sort
  onSort: (sort: Sort) => void
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const header = (key: SortKey, label: string, end = false) => {
    const state = sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
    // Text starts A to Z, numbers start high to low; a further click turns the order around (TB-1).
    const first: Sort["dir"] = key === "name" || key === "stage" ? "asc" : "desc"
    return (
      <span className={end ? "ui-td-end" : undefined} data-sort-state={state}>
        <button
          type="button"
          className="ui-sort"
          onClick={() => onSort({ key, dir: sort.key === key ? (sort.dir === "asc" ? "desc" : "asc") : first })}
        >
          {label}
          <span className="ui-sr-only">{state === "none" ? "" : t(`sort.${state}`)}</span>
        </button>
      </span>
    )
  }
  return (
    <div
      className="ui-table ui-stack"
      style={
        {
          "--ui-cols": "minmax(0, 1.3fr) 120px minmax(0, 1fr) minmax(0, 1.5fr) 70px 80px 70px",
          "--ui-table-min": "900px",
        } as CSSProperties
      }
    >
      <div className="ui-tr ui-tr-head">
        {header("name", t("projects.colName"))}
        {header("stage", t("projects.colStage"))}
        {header("goal", t("projects.colGoal"))}
        <span>{t("projects.colWhere")}</span>
        {header("open", t("projects.colOpen"), true)}
        {header("proposals", t("projects.colProposals"), true)}
        {header("issues", t("projects.colIssues"), true)}
      </div>
      {projects.map((project) => {
        const open = () => navigate(`/projects/${project.id}`)
        return (
          // biome-ignore lint/a11y/useSemanticElements: a whole row opens it (v3 TB-8); it holds block content and links, so it cannot be a <button>
          <div
            key={project.id}
            className="ui-tr"
            data-row-open=""
            role="button"
            tabIndex={0}
            aria-label={t("projects.openNamed", { name: project.name })}
            onClick={(event) => {
              if (!selecting(event) && !(event.target as HTMLElement).closest("a")) open()
            }}
            onKeyDown={rowKeys(open)}
          >
            <span className="ui-td ui-td-first">
              <b dir="auto">{project.name}</b>
            </span>
            <span className="ui-td">
              <StageTag stage={project.stage} />
            </span>
            <span className="ui-td" title={project.goal?.text}>
              {project.goal ? (
                <Progress done={project.goal.done} total={project.goal.total} />
              ) : (
                <span className="ui-muted">{t("projects.noGoal")}</span>
              )}
            </span>
            <span
              className={project.whereWeAre ? "ui-td" : "ui-td ui-td-blank"}
              dir="auto"
              title={project.whereWeAre ?? undefined}
            >
              {project.whereWeAre ?? <span className="ui-muted">-</span>}
            </span>
            <span className="ui-td ui-td-end">
              <span className="ui-td-label">{t("projects.colOpen")} </span>
              {formatNumber(project.openItems)}
            </span>
            <span className={project.openProposals ? "ui-td ui-td-end ui-text-warn" : "ui-td ui-td-end"}>
              <span className="ui-td-label">{t("projects.colProposals")} </span>
              {formatNumber(project.openProposals)}
            </span>
            <span className="ui-td ui-td-end">
              <span className="ui-td-label">{t("projects.colIssues")} </span>
              {project.githubRepo && project.openIssuesCount !== null ? (
                <a
                  href={issuesUrl(project.githubRepo)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t("projects.issuesTitle", { repo: project.githubRepo })}
                >
                  {formatNumber(project.openIssuesCount)}
                </a>
              ) : (
                <span className="ui-muted">-</span>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const { t, language } = useI18n()
  const fieldId = useId()
  const navigate = useNavigate()
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = useDiscardGuard(name.trim() !== "" && !busy, onClose)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) {
      setError(t("projects.nameRequired"))
      return
    }
    setBusy(true)
    try {
      const project = await api.createProject(name.trim())
      showToast(t("projects.created", { name: project.name }), "success")
      onClose()
      navigate(`/projects/${project.id}`)
    } catch (failure) {
      setBusy(false)
      setError(t("projects.createFailed", { reason: errorReason(language, failure) }))
    }
  }
  return (
    <Dialog
      size="sm"
      title={t("projects.new")}
      onClose={() => void close()}
      foot={
        <>
          <button type="button" className="ui-btn" onClick={() => void close()} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" form={`${fieldId}-form`} className="ui-btn ui-btn-primary" disabled={busy}>
            {t("projects.create")}
          </button>
        </>
      }
    >
      <form id={`${fieldId}-form`} className="ui-form-stack" onSubmit={submit} noValidate>
        <div className="ui-field">
          <label className="ui-label" htmlFor={fieldId}>
            {t("projects.name")}
          </label>
          <input
            id={fieldId}
            className="ui-input"
            dir="auto"
            maxLength={120}
            value={name}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
          />
          {error ? (
            <p className="ui-field-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="ui-hint">{t("projects.newHint")}</p>
          )}
        </div>
      </form>
    </Dialog>
  )
}
