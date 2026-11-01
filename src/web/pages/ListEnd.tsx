// The end of a list that loads more as it scrolls (v3 TB-6): a sentinel 400px before the end asks for
// the next page by cursor; the line under the list says "Loading more...", that everything is shown,
// or that a page failed with Try again (which never asks again by itself).

import { useEffect, useRef } from "react"
import { useI18n } from "../i18n/i18n.tsx"

export function ListEnd({
  hasMore,
  loading,
  failed,
  shown,
  onMore,
  allShownKey,
}: {
  hasMore: boolean
  loading: boolean
  failed: boolean
  shown: number
  onMore: () => void
  allShownKey: string
}) {
  const { t, tc } = useI18n()
  const sentinel = useRef<HTMLParagraphElement>(null)
  const more = useRef(onMore)
  more.current = onMore
  useEffect(() => {
    const element = sentinel.current
    if (!element || !hasMore || loading || failed) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) more.current()
      },
      { rootMargin: "0px 0px 400px 0px" },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasMore, loading, failed])
  return (
    <p ref={sentinel} className="ui-list-end" aria-live="polite">
      {failed ? (
        <>
          {t("list.moreFailed")}{" "}
          <button type="button" className="ui-link" onClick={onMore}>
            {t("common.tryAgain")}
          </button>
        </>
      ) : hasMore ? (
        t("list.loadingMore")
      ) : (
        tc(allShownKey, shown)
      )}
    </p>
  )
}
