// Every page updates by itself; there is no Refresh button (v3 SV-10). A page reads its data through
// usePageQuery or usePageInfiniteQuery with a pace that fits the data. TanStack Query keeps what is
// shown when a read fails, reads nothing while the browser tab is hidden and catches up when it is
// shown again, and keeps unchanged data identical, so React redraws only what changed.
// refresh.guard.test.ts fails on a page that registers no refresh of its own.

import {
  type InfiniteData,
  keepPreviousData,
  type QueryKey,
  type UseInfiniteQueryResult,
  type UseQueryResult,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query"
import type { Page } from "../api/types.ts"

/** Paces, in milliseconds. */
export const EVERY = {
  /** Work items, the morning view, the bell: they change while the owner looks. */
  live: 30_000,
  /** Settings, devices and suppressions change rarely and only by the owner. */
  slow: 300_000,
} as const

export function usePageQuery<T>(options: {
  queryKey: QueryKey
  queryFn: () => Promise<T>
  every: number
  enabled?: boolean
  /** Keeps showing the previous key's data while a new key loads (a page that changes its key). */
  keepPrevious?: boolean
}): UseQueryResult<T> {
  return useQuery({
    queryKey: options.queryKey,
    queryFn: options.queryFn,
    enabled: options.enabled,
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
    refetchInterval: options.every,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
}

/** A list that loads more as its end scrolls into view, by cursor; a refresh reads every page shown again. */
export function usePageInfiniteQuery<T>(options: {
  queryKey: QueryKey
  queryFn: (cursor: string | null) => Promise<Page<T>>
  every: number
}): UseInfiniteQueryResult<InfiniteData<Page<T>, string | null>> {
  return useInfiniteQuery({
    queryKey: options.queryKey,
    queryFn: ({ pageParam }) => options.queryFn(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: options.every,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
}
