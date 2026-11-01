// Each page names itself: the browser tab title ("Projects · Mikud"), the crumbs in the top bar and
// the page label in the phone top bar (v3 NL-3, NL-5).

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react"
import { useI18n } from "../i18n/i18n.tsx"

export type Crumb = { label: string; to?: string }
type Meta = { title: string; crumbs: Crumb[] }
type MetaContext = { meta: Meta; setMeta(meta: Meta): void }

const PageMetaContext = createContext<MetaContext | null>(null)

export function PageMetaProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta>({ title: "", crumbs: [] })
  const value = useMemo(() => ({ meta, setMeta }), [meta])
  return <PageMetaContext.Provider value={value}>{children}</PageMetaContext.Provider>
}

export function usePageMeta(title: string, crumbs: Crumb[] = []): void {
  const context = useContext(PageMetaContext)
  const { t } = useI18n()
  const key = JSON.stringify(crumbs)
  // biome-ignore lint/correctness/useExhaustiveDependencies: crumbs are compared by their JSON key
  useEffect(() => {
    document.title = title ? `${title} · ${t("app.name")}` : t("app.name")
    context?.setMeta({ title, crumbs })
  }, [title, key, t])
}

export function useCurrentMeta(): Meta {
  return useContext(PageMetaContext)?.meta ?? { title: "", crumbs: [] }
}
