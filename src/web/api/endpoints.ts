// Every route the web UI calls (docs/api.md), with its request and response shape. Answers arrive as
// {"data": ...}, paged lists as {"data": [...], "nextCursor"}; this file unwraps them.

import type { Stage } from "../../shared/enums.ts"
import { query, request } from "./client.ts"
import type {
  AuditEntry,
  Comment,
  Device,
  Item,
  ItemDetail,
  ItemPatch,
  ItemSummary,
  Morning,
  Page,
  Project,
  ProjectDetail,
  ProjectListEntry,
  ProjectPatch,
  Session,
  Settings,
  SettingsPatch,
  StageProposal,
  Suppression,
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

const id = (value: string) => encodeURIComponent(value)

export const api = {
  session: () => data<Session>("GET", "/session"),
  pair: (token: string, label: string) => data<{ device: Device }>("POST", "/pair", { token, label }),

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
  audit: (cursor: string | null) => page<AuditEntry>(`/audit${query({ cursor, limit: 50 })}`),
  syncRuns: () => data<SyncRun[]>("GET", "/sync/runs?limit=10"),

  settings: () => data<Settings>("GET", "/settings"),
  updateSettings: (patch: SettingsPatch) => data<Settings>("PATCH", "/settings", patch),
  telegramStatus: () => data<TelegramStatus>("GET", "/telegram/status"),
  /** Sends today's morning message to the owner's chat now, without touching the 08:00 run. */
  telegramTestMessage: () => data<{ sent: true }>("POST", "/telegram/test-message", {}),

  devices: () => data<Device[]>("GET", "/devices"),
  revokeDevice: (deviceId: string) => request<null>("DELETE", `/devices/${id(deviceId)}`),
  endAllDevices: () => data<{ ended: number }>("POST", "/devices/end-all", {}),

  suppressions: () => data<Suppression[]>("GET", "/suppressions"),
  deleteSuppression: (suppressionId: string) => request<null>("DELETE", `/suppressions/${id(suppressionId)}`),
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
  settings: ["settings"] as const,
  syncRuns: ["sync-runs"] as const,
  telegram: ["telegram"] as const,
  devices: ["devices"] as const,
  suppressions: ["suppressions"] as const,
}
