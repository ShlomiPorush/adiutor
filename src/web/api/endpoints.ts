// Every route the web UI calls (docs/api.md), with its request and response shape. Answers arrive as
// {"data": ...}, paged lists as {"data": [...], "nextCursor"}; this file unwraps them.

import type { AuditFilters } from "../../shared/api.ts"
import type { Stage } from "../../shared/enums.ts"
import { query, request } from "./client.ts"
import type {
  AgentConnection,
  AgentSettings,
  AuditCounts,
  AuditEntry,
  AuditPage,
  Comment,
  GitHubAppPatch,
  GitHubCreated,
  GitHubCreateForm,
  GitHubInstallFinished,
  GitHubView,
  Item,
  ItemDetail,
  ItemPatch,
  ItemSummary,
  Morning,
  Note,
  NoteDetail,
  NoteFilters,
  NotePatch,
  NoteSummary,
  NoteVersion,
  NoteVersionSummary,
  Page,
  Project,
  ProjectDetail,
  ProjectListEntry,
  ProjectPatch,
  Session,
  Settings,
  SettingsPatch,
  SetupStatus,
  StageProposal,
  Suppression,
  SyncRequest,
  SyncRequests,
  SyncRun,
  TelegramStatus,
} from "./types.ts"

type Data<T> = { data: T }
type Paged<T> = { data: T[]; nextCursor: string | null }

async function data<T>(method: Parameters<typeof request>[0], path: string, body?: unknown): Promise<T> {
  return (await request<Data<T>>(method, path, body)).data
}

async function page<T>(path: string): Promise<Page<T>> {
  const answer = await request<Paged<T>>("GET", path)
  return { entries: answer.data, nextCursor: answer.nextCursor }
}

/** The activity log keeps the first page's total and counts, which `page` drops. */
async function auditPage(filters: AuditFilters, cursor: string | null): Promise<AuditPage> {
  const answer = await request<Paged<AuditEntry> & { total?: number; counts?: AuditCounts }>(
    "GET",
    `/audit${query({ ...filters, cursor, limit: 50 })}`,
  )
  return {
    entries: answer.data,
    nextCursor: answer.nextCursor,
    total: answer.total ?? null,
    counts: answer.counts ?? null,
  }
}

const id = (value: string) => encodeURIComponent(value)

export const api = {
  session: () => data<Session>("GET", "/session"),
  setupStatus: () => data<SetupStatus>("GET", "/api/setup/status"),

  morning: () => data<Morning>("GET", "/morning"),
  /** The morning view with a fixed "new since" boundary: the morning page keeps its first read's. */
  morningSince: (since: string) => data<Morning>("GET", `/morning?since=${encodeURIComponent(since)}`),
  /** Records that the morning view was shown, at the time of the read shown (its `now`). */
  visit: (at: string) => data<{ at: string; previous: string | null }>("POST", "/visits", { at }),

  projects: () => data<ProjectListEntry[]>("GET", "/projects"),
  project: (projectId: string) => data<ProjectDetail>("GET", `/projects/${id(projectId)}`),
  createProject: (name: string) => data<Project>("POST", "/projects", { name }),
  updateProject: (projectId: string, patch: ProjectPatch) =>
    data<Project>("PATCH", `/projects/${id(projectId)}`, patch),
  deleteProject: (projectId: string) => request<null>("DELETE", `/projects/${id(projectId)}`),
  proposeStage: (projectId: string, stage: Stage, reason?: string) =>
    data<StageProposal>("POST", `/projects/${id(projectId)}/stage-proposals`, reason ? { stage, reason } : { stage }),
  decideProposal: (proposalId: string, decision: "accept" | "reject") =>
    data<{ proposal: StageProposal; project: Project }>("POST", `/stage-proposals/${id(proposalId)}/decision`, {
      decision,
    }),

  item: (itemId: string) => data<ItemDetail>("GET", `/items/${id(itemId)}`),
  /** Optimistic concurrency: the server refuses with version_conflict when `version` is stale. */
  updateItem: (itemId: string, version: number, patch: ItemPatch) =>
    data<Item>("PATCH", `/items/${id(itemId)}`, { version, ...patch }),
  deleteItem: (itemId: string, version?: number) =>
    request<null>("DELETE", `/items/${id(itemId)}${query({ version })}`),
  addComment: (itemId: string, text: string) => data<Comment>("POST", `/items/${id(itemId)}/comments`, { text }),

  /** Type idea, status future, in the inbox unless a project is given; the first line is the title. */
  capture: (text: string, projectId: string | null) => data<Item>("POST", "/capture", { text, projectId }),
  inbox: () => data<ItemSummary[]>("GET", "/inbox"),
  archive: (cursor: string | null) => page<ItemSummary>(`/archive${query({ cursor, limit: 50 })}`),
  /** The activity log narrowed by its filters; `lang` goes with `q` (the labels the search also matches). */
  audit: (filters: AuditFilters, cursor: string | null) => auditPage(filters, cursor),
  /** The PC's latest T3 runs: the server's hourly GitHub pulls would push them out of a mixed list. */
  syncRuns: () => data<SyncRun[]>("GET", "/sync/runs?kind=t3&limit=10"),
  syncRequests: () => data<SyncRequests>("GET", "/sync/requests"),
  /** Sync now: a new request, or the one already waiting or running (`created` false). */
  requestSync: () => data<{ request: SyncRequest; created: boolean }>("POST", "/sync/requests", {}),
  /** Cancels a request that still waits for the computer. */
  cancelSyncRequest: (requestId: string) => data<SyncRequest>("DELETE", `/sync/requests/${id(requestId)}`),

  notes: (filters: NoteFilters, cursor: string | null) =>
    page<NoteSummary>(
      `/notes${query({ ...filters, general: filters.general ? "true" : undefined, cursor, limit: 50 })}`,
    ),
  note: (noteId: string) => data<NoteDetail>("GET", `/notes/${id(noteId)}`),
  createNote: (input: { title: string; body?: string; projectId?: string | null }) =>
    data<Note>("POST", "/notes", input),
  /** Optimistic concurrency: the server refuses with version_conflict when `version` is stale. */
  updateNote: (noteId: string, version: number, patch: NotePatch) =>
    data<Note>("PATCH", `/notes/${id(noteId)}`, { version, ...patch }),
  /** Deletes the note with its versions, only at the version the owner saw. */
  deleteNote: (noteId: string, version: number) => request<null>("DELETE", `/notes/${id(noteId)}${query({ version })}`),
  noteVersions: (noteId: string, cursor: string | null) =>
    page<NoteVersionSummary>(`/notes/${id(noteId)}/versions${query({ cursor, limit: 50 })}`),
  noteVersion: (noteId: string, version: number) =>
    data<NoteVersion>("GET", `/notes/${id(noteId)}/versions/${version}`),
  restoreNote: (noteId: string, expectedVersion: number, fromVersion: number) =>
    data<Note>("POST", `/notes/${id(noteId)}/restore`, { expectedVersion, fromVersion }),

  settings: () => data<Settings>("GET", "/settings"),
  updateSettings: (patch: SettingsPatch) => data<Settings>("PATCH", "/settings", patch),
  telegramStatus: () => data<TelegramStatus>("GET", "/telegram/status"),
  /** Sends today's morning message to the owner's chat now, without touching the 08:00 run. */
  telegramTestMessage: () =>
    data<{ sent: true; warning?: "outcome_not_recorded" }>("POST", "/telegram/test-message", {}),

  suppressions: () => data<Suppression[]>("GET", "/suppressions"),
  deleteSuppression: (suppressionId: string) => request<null>("DELETE", `/suppressions/${id(suppressionId)}`),

  // GitHub, read by the server through the owner's App. Each change names the generation of the view it was based on.
  github: () => data<GitHubView>("GET", "/github"),
  updateGitHubApp: (generation: number, patch: GitHubAppPatch) =>
    data<GitHubView>("PATCH", "/github/app", { generation, ...patch }),
  addGitHubInstallation: (generation: number, installationId: number) =>
    data<GitHubView>("POST", "/github/installations", { generation, installationId }),
  removeGitHubInstallation: (generation: number, installationId: number) =>
    data<GitHubView>("DELETE", `/github/installations/${installationId}${query({ generation })}`),
  // The App made from a manifest, and GitHub's install page; GitHub sends the browser back to Settings, GitHub.
  startGitHubApp: () => data<GitHubCreateForm>("POST", "/github/create", {}),
  finishGitHubApp: (code: string, state: string) =>
    data<GitHubCreated>("POST", "/github/create/finish", { code, state }),
  gitHubInstallLink: () => data<{ url: string }>("POST", "/github/install", {}),
  finishGitHubInstall: (installationId: number, state: string) =>
    data<GitHubInstallFinished>("POST", "/github/install/finish", { installationId, state }),
  /** Read now: starts a pull, or joins the one running (`joined`); does not wait for it. */
  readGitHub: () => data<{ joined: boolean; view: GitHubView }>("POST", "/github/pull", {}),

  // Agent access by approval (/api/v1/agents): answered without the {data} wrapper.
  agentSettings: () => request<AgentSettings>("GET", "/agents/settings"),
  updateAgentSettings: (patch: { enabled?: boolean; idleDays?: number }) =>
    request<AgentSettings>("PATCH", "/agents/settings", patch),
  agentConnections: async () =>
    (await request<{ connections: AgentConnection[] }>("GET", "/agents/connections")).connections,
  disconnectAgent: (connectionId: string) => request<null>("DELETE", `/agents/connections/${id(connectionId)}`),
  disconnectAllAgents: () => request<{ ended: number }>("POST", "/agents/connections/disconnect-all", {}),
}

/** Query keys, one place, so a change invalidates exactly what it changed. */
export const qk = {
  session: ["session"] as const,
  morning: ["morning"] as const,
  morningSince: (since: string) => ["morning", since] as const,
  projects: ["projects"] as const,
  project: (projectId: string) => ["project", projectId] as const,
  item: (itemId: string) => ["item", itemId] as const,
  inbox: ["inbox"] as const,
  archive: ["archive"] as const,
  audit: ["audit"] as const,
  /** One list per set of filters: a change of filters is a new list from its first page. */
  auditFiltered: (filters: AuditFilters) => ["audit", filters] as const,
  /** Every notes list; one per set of filters, so a change of filters is a new list from its first page. */
  notes: ["notes"] as const,
  notesFiltered: (filters: NoteFilters) => ["notes", filters] as const,
  note: (noteId: string) => ["note", noteId] as const,
  noteVersions: (noteId: string) => ["note", noteId, "versions"] as const,
  noteVersion: (noteId: string, version: number) => ["note", noteId, "version", version] as const,
  settings: ["settings"] as const,
  syncRuns: ["sync-runs"] as const,
  syncRequests: ["sync-requests"] as const,
  telegram: ["telegram"] as const,
  setupStatus: ["setup-status"] as const,
  /** Better Auth's list of this owner's browsers. */
  account: ["account"] as const,
  /** Better Auth's list of this owner's passkeys. */
  passkeys: ["passkeys"] as const,
  agentKeys: ["agent-keys"] as const,
  agentSettings: ["agent-settings"] as const,
  agentConnections: ["agent-connections"] as const,
  suppressions: ["suppressions"] as const,
  github: ["github"] as const,
}
