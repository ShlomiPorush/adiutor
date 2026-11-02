// Closed items (done and not relevant). They leave the morning view after the closed-item days set
// in Settings and stay here. Newest closed first; more load as the end scrolls into view.

import { api, qk } from "../api/endpoints.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { EVERY, usePageInfiniteQuery } from "../ui/refresh.ts"
import { Empty, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { ListEnd } from "./ListEnd.tsx"
import { ItemRow, Panel } from "./parts.tsx"

export function ArchivePage() {
  const { t } = useI18n()
  usePageMeta(t("archive.title"))
  const query = usePageInfiniteQuery({ queryKey: qk.archive, queryFn: api.archive, every: EVERY.live })
  const items = query.data?.pages.flatMap((page) => page.entries) ?? []
  // A row that moved between pages while they loaded shows once.
  const unique = items.filter((item, index) => items.findIndex((other) => other.id === item.id) === index)
  return (
    <div className="ui-page">
      <div className="ui-page-narrow ui-section">
        <PageHead title={t("archive.title")} description={t("archive.description")} />
        <StaleNote failed={query.isRefetchError} />
        {query.isPending ? <Loading label={t("archive.loading")} /> : null}
        {query.isError && !query.data ? (
          <ErrorState title={t("archive.failed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {query.data ? (
          <Panel id="archive" title={t("archive.listTitle")}>
            {unique.length === 0 ? (
              <Empty title={t("archive.empty")} hint={t("archive.emptyHint")} />
            ) : (
              <>
                {unique.map((item) => (
                  <ItemRow key={item.id} item={item} time="closedAt" />
                ))}
                <ListEnd
                  hasMore={!!query.hasNextPage}
                  loading={query.isFetchingNextPage}
                  failed={query.isFetchNextPageError}
                  shown={unique.length}
                  onMore={() => void query.fetchNextPage()}
                  allShownKey="archive.allShown"
                />
              </>
            )}
          </Panel>
        ) : null}
      </div>
    </div>
  )
}
