// The audit log: every change by anyone, newest first, loaded by cursor as the end scrolls into view.
// An item entry opens the item; a project entry opens the project.

import { Link } from "react-router"
import { api, qk } from "../api/endpoints.ts"
import type { AuditEntry } from "../api/types.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { useOpenItem } from "../shell/items.ts"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { EVERY, usePageInfiniteQuery } from "../ui/refresh.ts"
import { Empty, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { ActorTag, Tag } from "../ui/tags.tsx"
import { actionText, changesOf } from "./audit.ts"
import { ListEnd } from "./ListEnd.tsx"
import { Panel } from "./parts.tsx"

export function ActivityPage() {
  const { t } = useI18n()
  usePageMeta(t("activity.title"))
  const query = usePageInfiniteQuery({ queryKey: qk.audit, queryFn: api.audit, every: EVERY.live })
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? []
  const unique = entries.filter((entry, index) => entries.findIndex((other) => other.id === entry.id) === index)
  return (
    <div className="ui-page">
      <div className="ui-page-narrow ui-section">
        <div className="ui-page-head">
          <div>
            <h1 className="ui-h1">{t("activity.title")}</h1>
            <p>{t("activity.description")}</p>
          </div>
        </div>
        <StaleNote failed={query.isRefetchError} />
        {query.isPending ? <Loading label={t("activity.loading")} /> : null}
        {query.isError && !query.data ? (
          <ErrorState title={t("activity.failed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {query.data ? (
          <Panel id="activity" title={t("activity.listTitle")}>
            {unique.length === 0 ? (
              <Empty title={t("activity.empty")} hint={t("activity.emptyHint")} />
            ) : (
              <>
                {unique.map((entry) => (
                  <ActivityRow key={entry.id} entry={entry} />
                ))}
                <ListEnd
                  hasMore={!!query.hasNextPage}
                  loading={query.isFetchingNextPage}
                  failed={query.isFetchNextPageError}
                  shown={unique.length}
                  onMore={() => void query.fetchNextPage()}
                  allShownKey="activity.allShown"
                />
              </>
            )}
          </Panel>
        ) : null}
      </div>
    </div>
  )
}

/** The name of what changed, from the entry itself: an item title or a project name. */
function entityLabel(entry: AuditEntry): string | null {
  for (const side of [entry.after, entry.before]) {
    for (const field of ["title", "name", "label"]) {
      const value = side?.[field]
      if (typeof value === "string" && value.trim()) return value
    }
  }
  return null
}

function EntityLink({ entry }: { entry: AuditEntry }) {
  const { t } = useI18n()
  const openItem = useOpenItem()
  const label = entityLabel(entry) ?? t(`audit.entity.${entry.entityType}`)
  const gone = entry.action.endsWith(".delete")
  if (entry.entityType === "item" && !gone) {
    return (
      <button type="button" className="ui-row-title" dir="auto" onClick={() => openItem(entry.entityId)}>
        {label}
      </button>
    )
  }
  if (entry.entityType === "project" && !gone) {
    return (
      <Link to={`/projects/${entry.entityId}`} className="ui-row-title" dir="auto">
        {label}
      </Link>
    )
  }
  return (
    <b className="ui-user" dir="auto">
      {label}
    </b>
  )
}

function ActivityRow({ entry }: { entry: AuditEntry }) {
  const { t, language } = useI18n()
  const changes = changesOf(language, entry)
  return (
    <div className="ui-item">
      <div className="ui-item-main">
        <EntityLink entry={entry} />
        <span className="ui-item-meta">
          <ActorTag kind={entry.actorKind} label={entry.actorLabel} />
          <span>{actionText(language, entry)}</span>
          {changes.map((change) => (
            <span key={change.field} className="ui-change">
              {change.field}: <bdi dir="auto">{change.before}</bdi> {t("common.arrow")}{" "}
              <bdi dir="auto">{change.after}</bdi>
            </span>
          ))}
        </span>
      </div>
      <div className="ui-item-end">
        <Tag tone="neutral" line>
          {t(`audit.source.${entry.source}`)}
        </Tag>
        <Time value={entry.at} />
      </div>
    </div>
  )
}
