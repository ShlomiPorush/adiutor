// Every shape the web UI reads from /api/v1, as docs/api.md defines it ("Shapes" and "Routes").
// Request bodies are the zod schemas of src/shared/api.ts. Codes are the English codes of
// src/shared/enums.ts; labels come from the locale files. Times are ISO 8601 strings in UTC. When
// the contract changes, this file and endpoints.ts are the only places to follow it.

import type { DateFormat, TimeFormat } from "../../shared/datetime-formats.ts"
import type {
  ActorKind,
  AuditSource,
  ItemStatus,
  ItemType,
  JobState,
  Language,
  ProposalState,
  SecurityCoverage,
  SecurityFamily,
  Severity,
  Stage,
  SuppressionKind,
  SyncOutcome,
} from "../../shared/enums.ts"

/** Error codes the server sends as {error: {code, message, ...details}}. */
export const API_ERROR_CODES = [
  "unauthorized",
  "session_ended",
  "forbidden",
  "totp_required",
  "not_found",
  "validation_failed",
  "version_conflict",
  "secret_suspected",
  "not_top_level",
  "suppressed",
  "conflict",
  "already_set_up",
  "wrong_password",
  "rate_limited",
  "busy",
  "telegram_failed",
  "telegram_uncertain",
  "internal_error",
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/** Seconds left on the session's clocks (Settings): its maximum length, and the idle limit when it is on. */
export type SessionClocks = {
  max: { remainingSec: number }
  idle: { timeoutSec: number; remainingSec: number } | null
}

export type Session = {
  actor: { kind: ActorKind; label: string }
  via: "token" | "session"
  browserId: string | null
  clocks: SessionClocks | null
}

/** GET /api/setup/status: whether the owner exists, and what this browser's session may do. */
export type SetupStatus = { hasUser: boolean; session: "none" | "enrol" | "active" }

export type AccountSession = {
  id: string
  current: boolean
  signedInAt: string
  activeAt: string
  userAgent: string | null
}

export type Account = { username: string; sessions: AccountSession[] }

export type GoalProgress = { id: string; text: string; createdAt: string; done: number; total: number }
export type Goal = { id: string; projectId: string; text: string; createdAt: string; closedAt: string | null }

export type Project = {
  id: string
  name: string
  slug: string
  t3ProjectId: string | null
  /** GitHub repository as owner/name. */
  githubRepo: string | null
  stage: Stage | null
  whereWeAre: string | null
  openIssuesCount: number | null
  openIssuesAsOf: string | null
  createdAt: string
  updatedAt: string
}

export type ProjectListEntry = Project & { goal: GoalProgress | null; openItems: number; openProposals: number }

export type Item = {
  id: string
  projectId: string | null
  type: ItemType
  status: ItemStatus
  title: string
  body: string | null
  severity: Severity | null
  goalId: string | null
  version: number
  statusSetBy: ActorKind | null
  statusSetAt: string | null
  createdBy: ActorKind
  imported: boolean
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export type ItemSummary = {
  id: string
  projectId: string | null
  projectName: string | null
  type: ItemType
  status: ItemStatus
  title: string
  severity: Severity | null
  goalId: string | null
  version: number
  statusSetBy: ActorKind | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export type ThreadLink = {
  id: string
  itemId: string
  threadId: string
  t3ProjectId: string | null
  title: string | null
  /** T3's own status word: running, waiting, completed, ... */
  lastStatus: string | null
  settled: boolean
  lastActivityAt: string | null
  linkedAt: string
}

export type Comment = {
  id: string
  itemId: string
  authorKind: ActorKind
  authorLabel: string
  text: string
  threadId: string | null
  createdAt: string
}

export type StageProposal = {
  id: string
  projectId: string
  proposedStage: Stage
  reason: string | null
  authorKind: ActorKind
  authorLabel: string
  state: ProposalState
  createdAt: string
  decidedAt: string | null
}

export type SecuritySource = {
  id: string
  projectId: string
  family: SecurityFamily
  coverage: SecurityCoverage
  critical: number
  high: number
  medium: number
  low: number
  /** When the source last succeeded (not when it was synced). */
  asOf: string | null
  updatedAt: string
}

export type SecurityLine = {
  projectId: string
  projectName: string
  stage: Stage | null
  critical: number
  /** Counted only at stage production (0 elsewhere). */
  high: number
  alerts: { critical: number; high: number }
  items: { critical: number; high: number }
  asOf: string | null
  /** The as-of time is unknown or older than 26 hours. */
  stale: boolean
}

export type AuditEntry = {
  id: number
  at: string
  actorKind: ActorKind
  actorLabel: string
  action: string
  entityType: string
  entityId: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  source: AuditSource
}

export type ItemDetail = {
  item: Item
  project: { id: string; name: string; slug: string; stage: Stage | null } | null
  goal: Goal | null
  threads: ThreadLink[]
  /** Oldest first. */
  comments: Comment[]
  /** Newest first, up to 100. */
  audit: AuditEntry[]
}

export type ProjectDetail = {
  project: Project
  goal: GoalProgress | null
  pastGoals: Goal[]
  items: ItemSummary[]
  proposals: StageProposal[]
  securitySources: SecuritySource[]
  security: SecurityLine | null
}

export type WaitingProposal = {
  id: string
  projectId: string
  projectName: string
  currentStage: Stage | null
  proposedStage: Stage
  reason: string | null
  authorKind: ActorKind
  authorLabel: string
  createdAt: string
}

export type WaitingEntry =
  | { kind: "item"; at: string; item: ItemSummary }
  | { kind: "stage_proposal"; at: string; proposal: WaitingProposal }

export type AgentUpdate =
  | {
      kind: "comment"
      at: string
      itemId: string
      itemTitle: string
      actorKind: ActorKind
      actorLabel: string
      text: string
    }
  | {
      kind: "status"
      at: string
      itemId: string
      itemTitle: string
      actorKind: ActorKind
      actorLabel: string
      from: ItemStatus | null
      to: ItemStatus
    }

export type AgentUpdateGroup = { projectId: string | null; projectName: string | null; updates: AgentUpdate[] }

export type MorningProject = {
  id: string
  name: string
  slug: string
  stage: Stage | null
  goal: GoalProgress | null
  whereWeAre: string | null
  openItems: number
  openIssues: number | null
  openIssuesAsOf: string | null
  repo: string | null
}

export type Morning = {
  now: string
  /** This device's previous visit (24 hours ago on a first visit). */
  since: string
  waiting: WaitingEntry[]
  new: { change: "created" | "updated"; item: ItemSummary }[]
  security: SecurityLine[]
  agentUpdates: AgentUpdateGroup[]
  projects: MorningProject[]
  inboxCount: number
  sync: {
    lastSuccessAt: string | null
    stale: boolean
    lastPartialAt: string | null
    securityLastSuccessAt: string | null
  }
}

export type Page<T> = { entries: T[]; nextCursor: string | null }

/** Date and time formats as the server stores them (free text up to 40; these are the ones the UI offers). */
export type { DateFormat, TimeFormat }

export type Settings = {
  id: string
  closedItemDays: number
  dateFormat: string
  timeFormat: string
  language: Language
  sessionMaxDays: number
  sessionIdle: boolean
  sessionIdleMinutes: number
  updatedAt: string
}

export type SettingsPatch = Partial<{
  closedItemDays: number
  dateFormat: DateFormat
  timeFormat: TimeFormat
  language: Language
  sessionMaxDays: number
  sessionIdle: boolean
  sessionIdleMinutes: number
}>

export type SyncRun = {
  id: string
  kind: "t3" | "security"
  startedAt: string
  finishedAt: string | null
  outcome: SyncOutcome | null
  counts: Record<string, number>
  errors: { record: string; code: string }[]
}

/** GET /telegram/status (docs/api.md, Telegram). */
export type TelegramStatus = {
  configured: boolean
  /** The latest getUpdates call of the bot succeeded. */
  polling: boolean
  lastUpdateAt: string | null
  lastMorning: { localDate: string; state: JobState; at: string | null } | null
}

export type Suppression = {
  id: string
  kind: SuppressionKind
  externalId: string
  label: string | null
  createdAt: string
}

export type ItemPatch = Partial<{
  status: ItemStatus
  type: ItemType
  severity: Severity | null
  title: string
  body: string
  projectId: string | null
  goalId: string | null
}>

export type ProjectPatch = Partial<{
  stage: Stage | null
  whereWeAre: string | null
  goal: string | null
  name: string
}>
