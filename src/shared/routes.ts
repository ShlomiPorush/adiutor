// Paths of the web UI that other parts link to (Telegram messages, the GitHub App's return addresses). The UI must serve
// these paths.

export const UI_ROUTES = {
  home: "/",
  item: (id: string) => `/items/${encodeURIComponent(id)}`,
  note: (id: string) => `/notes/${encodeURIComponent(id)}`,
  /** Settings, GitHub: where GitHub sends the browser back after creating or installing the App. */
  githubSettings: "/settings/github",
} as const

/** An absolute link under the public URL, keeping any path prefix it has. */
export function uiUrl(publicUrl: URL | string, path: string): string {
  const base = new URL(String(publicUrl))
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`
  return new URL(path.replace(/^\/+/, ""), base).toString()
}
