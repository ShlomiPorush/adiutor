// Every page and its address. refresh.guard.test.ts reads PAGES and fails on a page module that
// registers no refresh of its own (v3 SV-10), unless it is listed there with its reason.

import type { ComponentType } from "react"
import { createBrowserRouter, Navigate, useParams } from "react-router"
import { ActivityPage } from "./pages/ActivityPage.tsx"
import { ArchivePage } from "./pages/ArchivePage.tsx"
import { InboxPage } from "./pages/InboxPage.tsx"
import { MorningPage } from "./pages/MorningPage.tsx"
import { NotFoundPage } from "./pages/NotFoundPage.tsx"
import { PairPage } from "./pages/PairPage.tsx"
import { ProjectPage } from "./pages/ProjectPage.tsx"
import { ProjectsPage } from "./pages/ProjectsPage.tsx"
import { SettingsPage } from "./pages/SettingsPage.tsx"
import { Root } from "./shell/Root.tsx"
import { Shell } from "./shell/Shell.tsx"

type PageRoute = { id: string; path: string; Component: ComponentType }

export const PAGES: readonly PageRoute[] = [
  { id: "morning", path: "/", Component: MorningPage },
  { id: "projects", path: "/projects", Component: ProjectsPage },
  { id: "project", path: "/projects/:projectId", Component: ProjectPage },
  { id: "inbox", path: "/inbox", Component: InboxPage },
  { id: "archive", path: "/archive", Component: ArchivePage },
  { id: "activity", path: "/activity", Component: ActivityPage },
  { id: "settings", path: "/settings", Component: SettingsPage },
  { id: "not-found", path: "*", Component: NotFoundPage },
]

/** A deep link /items/:id (Telegram) opens the item over the morning view. */
function ItemLink() {
  const { itemId = "" } = useParams()
  return <Navigate to={`/?item=${encodeURIComponent(itemId)}`} replace />
}

export function createRouter() {
  return createBrowserRouter([
    {
      element: <Root />,
      children: [
        { path: "/pair", element: <PairPage /> },
        {
          element: <Shell />,
          children: [
            ...PAGES.map(({ path, Component }) => ({ path, element: <Component /> })),
            { path: "/items/:itemId", element: <ItemLink /> },
          ],
        },
      ],
    },
  ])
}
