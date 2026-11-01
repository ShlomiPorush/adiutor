import { type SQL, sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import {
  ACTOR_KINDS,
  AUDIT_SOURCES,
  CLOSED_STATUSES,
  ITEM_STATUSES,
  ITEM_TYPES,
  JOB_STATES,
  LANGUAGES,
  PROPOSAL_STATES,
  SECURITY_COVERAGES,
  SECURITY_FAMILIES,
  SEVERITIES,
  STAGES,
  SUPPRESSION_KINDS,
  SYNC_OUTCOMES,
  TELEGRAM_OUTCOMES,
} from "../../shared/enums.ts"

// Codes are stored as text and checked by the database against the lists in src/shared/enums.ts.
// Adding a code means a new migration: drizzle-kit generate picks up the changed check.

const at = (name: string) => timestamp(name, { withTimezone: true })
const createdAt = () => at("created_at").notNull().defaultNow()

/** A check that the column holds one of the codes. NULL passes, so it also suits nullable columns. */
function oneOf(column: string, codes: readonly string[]): SQL {
  return sql.raw(`"${column}" in (${codes.map((c) => `'${c}'`).join(", ")})`)
}

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    t3ProjectId: text("t3_project_id").unique(),
    /** GitHub repository as owner/name. */
    githubRepo: text("github_repo"),
    /** Unset until the owner sets it; agents only propose one. */
    stage: text("stage", { enum: STAGES }),
    whereWeAre: text("where_we_are"),
    openIssuesCount: integer("open_issues_count"),
    openIssuesAsOf: at("open_issues_as_of"),
    createdAt: createdAt(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("projects_stage_check", oneOf("stage", STAGES)),
    check("projects_open_issues_count_check", sql`${t.openIssuesCount} >= 0`),
  ],
)

// The current goal of a project is its one goal that is not closed.
export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    createdAt: createdAt(),
    closedAt: at("closed_at"),
  },
  (t) => [uniqueIndex("goals_one_open_per_project_idx").on(t.projectId).where(sql`${t.closedAt} is null`)],
)

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null while the item is in the inbox. A project with items cannot be deleted until they move. */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    type: text("type", { enum: ITEM_TYPES }).notNull(),
    status: text("status", { enum: ITEM_STATUSES }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    /** Only for items of type security. */
    severity: text("severity", { enum: SEVERITIES }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    /** Optimistic concurrency: every write compares and increments it. */
    version: integer("version").notNull().default(1),
    statusSetBy: text("status_set_by", { enum: ACTOR_KINDS }).notNull(),
    statusSetAt: at("status_set_at").notNull().defaultNow(),
    createdBy: text("created_by", { enum: ACTOR_KINDS }).notNull(),
    /** Created by the first sync run: not "new since your last visit". */
    imported: boolean("imported").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: at("updated_at").notNull().defaultNow(),
    /** Set exactly when the status is a closed one; the archive is a query on it. */
    closedAt: at("closed_at"),
  },
  (t) => [
    check("items_type_check", oneOf("type", ITEM_TYPES)),
    check("items_status_check", oneOf("status", ITEM_STATUSES)),
    check("items_severity_check", oneOf("severity", SEVERITIES)),
    check("items_severity_security_only_check", sql`${t.severity} is null or ${t.type} = 'security'`),
    check("items_status_set_by_check", oneOf("status_set_by", ACTOR_KINDS)),
    check("items_created_by_check", oneOf("created_by", ACTOR_KINDS)),
    check("items_version_check", sql`${t.version} >= 1`),
    check("items_closed_at_check", sql`(${t.closedAt} is not null) = (${oneOf("status", CLOSED_STATUSES)})`),
    index("items_project_idx").on(t.projectId),
    index("items_status_idx").on(t.status),
    index("items_goal_idx").on(t.goalId),
  ],
)

export const itemThreads = pgTable(
  "item_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    /** A T3 thread links to one item at most: a retry or a race finds the existing link. */
    threadId: text("thread_id").notNull().unique(),
    t3ProjectId: text("t3_project_id"),
    title: text("title"),
    /** Last T3 status as T3 reports it (running, waiting, completed, ...). */
    lastStatus: text("last_status"),
    settled: boolean("settled").notNull().default(false),
    lastActivityAt: at("last_activity_at"),
    linkedAt: at("linked_at").notNull().defaultNow(),
  },
  (t) => [index("item_threads_item_idx").on(t.itemId)],
)

// T3 thread and project ids whose item or project the owner deleted; the sync never recreates them.
export const suppressions = pgTable(
  "suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: SUPPRESSION_KINDS }).notNull(),
    externalId: text("external_id").notNull(),
    /** What the owner deleted (its title or name), to recognise it in Settings. */
    label: text("label"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("suppressions_kind_external_id_unique").on(t.kind, t.externalId),
    check("suppressions_kind_check", oneOf("kind", SUPPRESSION_KINDS)),
  ],
)

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    authorKind: text("author_kind", { enum: ACTOR_KINDS }).notNull(),
    authorLabel: text("author_label"),
    text: text("text").notNull(),
    threadId: text("thread_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check("comments_author_kind_check", oneOf("author_kind", ACTOR_KINDS)),
    index("comments_item_idx").on(t.itemId),
  ],
)

export const stageProposals = pgTable(
  "stage_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    proposedStage: text("proposed_stage", { enum: STAGES }).notNull(),
    reason: text("reason").notNull().default(""),
    authorKind: text("author_kind", { enum: ACTOR_KINDS }).notNull(),
    authorLabel: text("author_label"),
    state: text("state", { enum: PROPOSAL_STATES }).notNull().default("open"),
    createdAt: createdAt(),
    decidedAt: at("decided_at"),
  },
  (t) => [
    check("stage_proposals_proposed_stage_check", oneOf("proposed_stage", STAGES)),
    check("stage_proposals_author_kind_check", oneOf("author_kind", ACTOR_KINDS)),
    check("stage_proposals_state_check", oneOf("state", PROPOSAL_STATES)),
    index("stage_proposals_project_idx").on(t.projectId),
  ],
)

export const securitySources = pgTable(
  "security_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    family: text("family", { enum: SECURITY_FAMILIES }).notNull(),
    coverage: text("coverage", { enum: SECURITY_COVERAGES }).notNull().default("unknown"),
    critical: integer("critical").notNull().default(0),
    high: integer("high").notNull().default(0),
    medium: integer("medium").notNull().default(0),
    low: integer("low").notNull().default(0),
    /** The source's last success, not the time of the sync that carried it. */
    asOf: at("as_of"),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("security_sources_project_family_unique").on(t.projectId, t.family),
    check("security_sources_family_check", oneOf("family", SECURITY_FAMILIES)),
    check("security_sources_coverage_check", oneOf("coverage", SECURITY_COVERAGES)),
    check(
      "security_sources_counts_check",
      sql`${t.critical} >= 0 and ${t.high} >= 0 and ${t.medium} >= 0 and ${t.low} >= 0`,
    ),
  ],
)

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    startedAt: at("started_at").notNull().defaultNow(),
    finishedAt: at("finished_at"),
    /** Null while the run is in progress. */
    outcome: text("outcome", { enum: SYNC_OUTCOMES }),
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
    /** Per-record errors; they never stop a run. */
    errors: jsonb("errors").$type<{ record: string; code: string }[]>().notNull().default([]),
  },
  (t) => [
    check("sync_runs_outcome_check", oneOf("outcome", SYNC_OUTCOMES)),
    index("sync_runs_started_idx").on(t.startedAt),
  ],
)

// At most one run per job and local date: the morning message is sent once, never twice.
export const jobRuns = pgTable(
  "job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    job: text("job").notNull(),
    localDate: date("local_date", { mode: "string" }).notNull(),
    state: text("state", { enum: JOB_STATES }).notNull(),
    at: at("at").notNull().defaultNow(),
    detail: text("detail"),
    // A sent morning message: the start of its read minus VISIT_SAFETY_MARGIN_MS, where the next message's
    // "new since" starts (see the invariant in db/client.ts). Null on runs from before it was recorded.
    coversUntil: at("covers_until"),
  },
  (t) => [
    unique("job_runs_job_local_date_unique").on(t.job, t.localDate),
    check("job_runs_state_check", oneOf("state", JOB_STATES)),
  ],
)

// Every Telegram update is recorded in the same transaction as its effect; a repeated update_id does nothing.
export const telegramUpdates = pgTable(
  "telegram_updates",
  {
    updateId: bigint("update_id", { mode: "number" }).primaryKey(),
    outcome: text("outcome", { enum: TELEGRAM_OUTCOMES }).notNull(),
    at: at("at").notNull().defaultNow(),
  },
  () => [check("telegram_updates_outcome_check", oneOf("outcome", TELEGRAM_OUTCOMES))],
)

// Paired browser sessions. Only the hash of the device secret is stored.
export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  secretHash: text("secret_hash").notNull().unique(),
  label: text("label").notNull(),
  createdAt: createdAt(),
  lastSeenAt: at("last_seen_at"),
  revokedAt: at("revoked_at"),
})

// One row per owner visit, per device, for "new since your last visit".
export const visits = pgTable(
  "visits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
    at: at("at").notNull().defaultNow(),
  },
  (t) => [index("visits_device_at_idx").on(t.deviceId, t.at)],
)

// A single row (id 1). The morning time and days are fixed, not settings.
export const settings = pgTable(
  "settings",
  {
    id: integer("id").primaryKey().default(1),
    closedItemDays: integer("closed_item_days").notNull().default(7),
    dateFormat: text("date_format").notNull().default("dd/MM/yyyy"),
    timeFormat: text("time_format").notNull().default("HH:mm"),
    language: text("language", { enum: LANGUAGES }).notNull().default("he"),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("settings_single_row_check", sql`${t.id} = 1`),
    check("settings_closed_item_days_check", sql`${t.closedItemDays} between 1 and 365`),
    check("settings_language_check", oneOf("language", LANGUAGES)),
  ],
)

export const audit = pgTable(
  "audit",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    at: at("at").notNull().defaultNow(),
    actorKind: text("actor_kind", { enum: ACTOR_KINDS }).notNull(),
    actorLabel: text("actor_label"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    source: text("source", { enum: AUDIT_SOURCES }).notNull(),
  },
  (t) => [
    check("audit_actor_kind_check", oneOf("actor_kind", ACTOR_KINDS)),
    check("audit_source_check", oneOf("source", AUDIT_SOURCES)),
    index("audit_at_idx").on(t.at),
    index("audit_entity_idx").on(t.entityType, t.entityId),
  ],
)
