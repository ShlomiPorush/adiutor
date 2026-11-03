// The unsorted inbox: quick captures with no project yet. Each row assigns a project and a type in
// place; a project picked in the row's picker (with a search above more than ten) moves the item out of
// the inbox at once, with Undo.

import { useQuery } from "@tanstack/react-query"
import { useId } from "react"
import { ITEM_TYPES, type ItemType } from "../../shared/enums.ts"
import { api, qk } from "../api/endpoints.ts"
import type { ItemSummary, ProjectListEntry } from "../api/types.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { useItemActions, useOpenItem } from "../shell/items.ts"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { Picker } from "../ui/Picker.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { Empty, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { Panel } from "./parts.tsx"

export function InboxPage() {
  const { t } = useI18n()
  usePageMeta(t("inbox"))
  const query = usePageQuery({ queryKey: qk.inbox, queryFn: api.inbox, every: EVERY.live })
  const projects = useQuery({ queryKey: qk.projects, queryFn: api.projects, staleTime: 60_000 })
  const items = query.data ?? []
  return (
    <div className="ui-page">
      <div className="ui-section">
        <PageHead title={t("inbox")} description={t("inboxPage.description")} />
        <StaleNote failed={query.isError && !!query.data} />
        {query.isPending ? <Loading label={t("inboxPage.loading")} /> : null}
        {query.isError && !query.data ? (
          <ErrorState title={t("inboxPage.failed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {query.data ? (
          <Panel id="inbox" title={t("inboxPage.listTitle")} count={items.length}>
            {items.length === 0 ? <Empty title={t("inboxPage.empty")} hint={t("inboxPage.emptyHint")} /> : null}
            {items.map((item) => (
              <InboxRow key={item.id} item={item} projects={projects.data ?? []} />
            ))}
          </Panel>
        ) : null}
      </div>
    </div>
  )
}

function InboxRow({ item, projects }: { item: ItemSummary; projects: ProjectListEntry[] }) {
  const { t } = useI18n()
  const openItem = useOpenItem()
  const actions = useItemActions()
  const typeId = useId()
  return (
    <div className="ui-item ui-inbox-row">
      <div className="ui-item-main">
        <button
          type="button"
          className="ui-row-title ui-item-title"
          dir="auto"
          title={item.title}
          onClick={() => openItem(item.id)}
        >
          {item.title}
        </button>
        <span className="ui-item-meta">
          {t("inboxPage.captured")} <Time value={item.createdAt} />
        </span>
      </div>
      <div className="ui-item-end">
        <Picker
          variant="action"
          label={t("item.project")}
          text={t("inboxPage.pickProject")}
          ariaLabel={t("inboxPage.projectFor", { title: item.title })}
          searchLabel={t("picker.searchProjects")}
          align="end"
          value=""
          options={projects.map((project) => ({ value: project.id, label: project.name }))}
          onChange={(next) => {
            const name = projects.find((project) => project.id === next)?.name ?? null
            void actions.moveTo(item, next, name)
          }}
        />
        <label className="ui-sr-only" htmlFor={typeId}>
          {t("inboxPage.typeFor", { title: item.title })}
        </label>
        <select
          id={typeId}
          className="ui-select ui-select-sm"
          value={item.type}
          onChange={(event) => void actions.setType(item, event.target.value as ItemType)}
        >
          {ITEM_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`itemType.${type}`)}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
