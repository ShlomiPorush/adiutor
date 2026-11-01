// The pages in the navigation, in one list for the sidebar, the rail, the phone tab bar and the
// phone More sheet.

import { Archive, FolderKanban, History, Inbox, type LucideIcon, Settings, Sunrise } from "lucide-react"

export type NavPage = {
  id: "morning" | "projects" | "inbox" | "archive" | "activity" | "settings"
  to: string
  icon: LucideIcon
  /** In the phone tab bar; the others are in the More sheet. */
  tab: boolean
}

export const NAV: readonly NavPage[] = [
  { id: "morning", to: "/", icon: Sunrise, tab: true },
  { id: "projects", to: "/projects", icon: FolderKanban, tab: true },
  { id: "inbox", to: "/inbox", icon: Inbox, tab: true },
  { id: "activity", to: "/activity", icon: History, tab: true },
  { id: "archive", to: "/archive", icon: Archive, tab: false },
  { id: "settings", to: "/settings", icon: Settings, tab: false },
]

/** The navigation item that a path belongs to. */
export function navIdFor(pathname: string): NavPage["id"] | null {
  if (pathname === "/") return "morning"
  const found = NAV.find((page) => page.to !== "/" && (pathname === page.to || pathname.startsWith(`${page.to}/`)))
  return found?.id ?? null
}
