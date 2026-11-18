import { z } from "zod"

// Codes stored in the database and sent over the API. They are English and never shown as-is:
// user-visible labels for the labelled groups come from src/shared/locales/*.json.

// --- Labelled codes (every code has a label in each locale file) ---

export const STAGES = ["idea", "poc", "development", "production", "redesign", "frozen"] as const
export const ITEM_STATUSES = ["future", "todo", "in_progress", "waiting_on_you", "done", "not_relevant"] as const
export const ITEM_TYPES = ["bug", "decision", "security", "task", "idea"] as const
export const SEVERITIES = ["critical", "high", "medium", "low"] as const

/** Statuses that close an item. A closed item has closed_at set and is archived by query. */
export const CLOSED_STATUSES = ["done", "not_relevant"] as const satisfies readonly ItemStatus[]

// --- Internal codes ---

/** Who made a change. Services enforce the rights of each. */
export const ACTOR_KINDS = ["owner", "agent", "bot", "sync", "system"] as const
/**
 * Where a change came in. `cli` is the recovery command run on the server (dist/server/cli.js); `github` the server's
 * own pull from GitHub (server/github/).
 */
export const AUDIT_SOURCES = ["ui", "api", "mcp", "telegram", "sync", "cli", "github"] as const
export const PROPOSAL_STATES = ["open", "accepted", "rejected"] as const
export const SECURITY_FAMILIES = ["dependabot", "code_scanning", "secret_scanning", "overview"] as const
export const SECURITY_COVERAGES = ["enabled", "not_enabled", "no_access", "error", "unknown"] as const
/** Where a project's stored security or Issues data came from: the sync's push from the PC, or the server's pull. */
export const SECURITY_ORIGINS = ["push", "github"] as const
/** How the server's last attempt to read a source from GitHub ended. */
export const SECURITY_ATTEMPTS = ["ok", "error"] as const
/** What a suppression keeps the sync from recreating. */
export const SUPPRESSION_KINDS = ["thread", "project"] as const
export const SYNC_OUTCOMES = ["succeeded", "partial", "failed"] as const
/**
 * A sync requested from Adiutor ("Sync now"): `waiting` for the computer, `claimed` by the sync on it (under a lease),
 * then `done`, `partial` or `failed` as its run reported, `unknown` when the lease passed without a check-in (a late
 * result still lands), or `cancelled` by the owner while it waited. done, partial, failed and cancelled are final.
 */
export const SYNC_REQUEST_STATES = ["waiting", "claimed", "done", "partial", "failed", "unknown", "cancelled"] as const
/** What one part of a sync run (T3, security) came to, as the sync reports it (src/sync/contract.ts PartResult). */
export const SYNC_PART_RESULTS = ["accepted", "partial", "failed", "outcome_unknown", "not_run"] as const
/**
 * A morning run: `sending` before the send, then `sent`; `failed` (Telegram refused it; retried until the
 * cutoff), `unknown` (it may have gone out; never resent) or `skipped` (the cutoff passed without a send).
 */
export const JOB_STATES = ["sending", "sent", "failed", "unknown", "skipped"] as const
export const TELEGRAM_OUTCOMES = ["item_created", "note_created", "ignored", "refused"] as const
export const LANGUAGES = ["he", "en"] as const

// --- Agent connections (the OAuth authorization server; labels come with the pages that show them) ---

/** What a connection may do: read, write (act on items, projects and notes) and sync (push T3 snapshots, REST only). */
export const AGENT_AREAS = ["read", "write", "sync"] as const
/** How a connection was approved: `code` is the device flow (the skill, the sync), `browser` an MCP client's sign-in. */
export const AGENT_CONNECTION_METHODS = ["code", "browser"] as const
/** The resource a connection's tokens are for: `/mcp` or `/api/v1`. */
export const AGENT_RESOURCES = ["mcp", "rest"] as const
/** The areas a resource offers: `sync` belongs to the REST API alone (D3). */
export const RESOURCE_AREAS: Record<(typeof AGENT_RESOURCES)[number], readonly (typeof AGENT_AREAS)[number][]> = {
  mcp: ["read", "write"],
  rest: AGENT_AREAS,
}
/**
 * Why a connection ended: the owner disconnected it, disconnected all, or turned agents off; it went unused for the
 * idle days; a spent refresh token or code came back; the owner's password or two-factor changed; the public URL
 * changed.
 */
export const AGENT_END_REASONS = [
  "disconnected",
  "all_disconnected",
  "turned_off",
  "unused",
  "refresh_reused",
  "code_reused",
  "person_changed",
  "issuer_changed",
] as const

/**
 * Every audit action written today, then the ones only older rows hold. Each has a label in `audit.action` of
 * each locale file, keyed with its dots as underscores (locales.test.ts). No database check uses the list: an
 * unknown code in an old row is still read, shown by its code and filtered by it. Add a new action here.
 */
export const AUDIT_ACTIONS = [
  "item.create",
  "item.update",
  "item.delete",
  "comment.create",
  "note.create",
  "note.update",
  "note.restore",
  "note.delete",
  "thread.link",
  "thread.update",
  "thread.move",
  "thread.unlink",
  "project.create",
  "project.update",
  "project.delete",
  "goal.create",
  "goal.close",
  "proposal.create",
  "proposal.update",
  "proposal.accept",
  "proposal.reject",
  "security.update",
  // One row per pull from GitHub: every time-only change and every attempt (server/github/).
  "security.pull",
  "sync_request.create",
  "sync_request.cancel",
  "suppression.create",
  "suppression.delete",
  "settings.update",
  "telegram.test_message",
  "account.setup",
  "account.totp_enable",
  "account.totp_disable",
  "account.password_change",
  "account.password_reset",
  "account.backup_codes_new",
  "account.passkey_add",
  "account.passkey_rename",
  "account.passkey_delete",
  "session.sign_in",
  "session.sign_out",
  "session.end",
  "session.connect",
  "session.revoke",
  "api_key.create",
  "api_key.delete",
  "device.approve",
  "device.deny",
  // Agent connections through the authorization server (written only where it is mounted).
  "agent.approve",
  "agent.deny",
  "agent.end",
  "agent.end_all",
  "agent.blocked",
  "agent.settings_update",
  // One row per call of an agent connected by approval, reads included (agents/channel.ts).
  "agent.api_call",
  "agent.tool_call",
  // Older rows only.
  "device.pair",
  "device.revoke",
  "device.revoke_all",
  "session.end_others",
  "session.end_all",
  "session.sweep",
  "auth.repair",
] as const
/** What an audit row is about; each has a label in `audit.entity` of each locale file. */
export const AUDIT_ENTITY_TYPES = [
  "item",
  "note",
  "project",
  "settings",
  "device",
  "suppression",
  "goal",
  "proposal",
  "comment",
  "thread",
  "session",
  "account",
  "api_key",
  "device_code",
  "agent_connection",
  "sync_request",
  "github",
] as const

export type Stage = (typeof STAGES)[number]
export type ItemStatus = (typeof ITEM_STATUSES)[number]
export type ItemType = (typeof ITEM_TYPES)[number]
export type Severity = (typeof SEVERITIES)[number]
export type ActorKind = (typeof ACTOR_KINDS)[number]
export type AuditSource = (typeof AUDIT_SOURCES)[number]
export type ProposalState = (typeof PROPOSAL_STATES)[number]
export type SecurityFamily = (typeof SECURITY_FAMILIES)[number]
export type SecurityCoverage = (typeof SECURITY_COVERAGES)[number]
export type SecurityOrigin = (typeof SECURITY_ORIGINS)[number]
export type SecurityAttempt = (typeof SECURITY_ATTEMPTS)[number]
export type SuppressionKind = (typeof SUPPRESSION_KINDS)[number]
export type SyncOutcome = (typeof SYNC_OUTCOMES)[number]
export type SyncRequestState = (typeof SYNC_REQUEST_STATES)[number]
export type SyncPartResult = (typeof SYNC_PART_RESULTS)[number]
export type JobState = (typeof JOB_STATES)[number]
export type TelegramOutcome = (typeof TELEGRAM_OUTCOMES)[number]
export type Language = (typeof LANGUAGES)[number]
export type AgentArea = (typeof AGENT_AREAS)[number]
export type AgentConnectionMethod = (typeof AGENT_CONNECTION_METHODS)[number]
export type AgentResource = (typeof AGENT_RESOURCES)[number]
export type AgentEndReason = (typeof AGENT_END_REASONS)[number]
export type AuditAction = (typeof AUDIT_ACTIONS)[number]
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number]

export const stageSchema = z.enum(STAGES)
export const itemStatusSchema = z.enum(ITEM_STATUSES)
export const itemTypeSchema = z.enum(ITEM_TYPES)
export const severitySchema = z.enum(SEVERITIES)
export const actorKindSchema = z.enum(ACTOR_KINDS)
export const auditSourceSchema = z.enum(AUDIT_SOURCES)
export const proposalStateSchema = z.enum(PROPOSAL_STATES)
export const securityFamilySchema = z.enum(SECURITY_FAMILIES)
export const securityCoverageSchema = z.enum(SECURITY_COVERAGES)
export const suppressionKindSchema = z.enum(SUPPRESSION_KINDS)
export const syncOutcomeSchema = z.enum(SYNC_OUTCOMES)
export const syncRequestStateSchema = z.enum(SYNC_REQUEST_STATES)
export const syncPartResultSchema = z.enum(SYNC_PART_RESULTS)
export const jobStateSchema = z.enum(JOB_STATES)
export const telegramOutcomeSchema = z.enum(TELEGRAM_OUTCOMES)
export const languageSchema = z.enum(LANGUAGES)
export const agentAreaSchema = z.enum(AGENT_AREAS)
export const agentConnectionMethodSchema = z.enum(AGENT_CONNECTION_METHODS)
export const agentResourceSchema = z.enum(AGENT_RESOURCES)
export const agentEndReasonSchema = z.enum(AGENT_END_REASONS)

/** The labelled groups, keyed by their section name in the locale files. */
export const LABELLED_CODES = {
  stage: STAGES,
  itemStatus: ITEM_STATUSES,
  itemType: ITEM_TYPES,
  severity: SEVERITIES,
} as const
