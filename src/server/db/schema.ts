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
  SESSION_IDLE_MINUTES_DEFAULT,
  SESSION_IDLE_MINUTES_MAX,
  SESSION_IDLE_MINUTES_MIN,
  SESSION_MAX_DAYS_DEFAULT,
  SESSION_MAX_DAYS_MAX,
  SESSION_MAX_DAYS_MIN,
} from "../../shared/auth.ts"
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

// A browser's identity for "new since your last visit", named by the mikud_browser cookie. Never a credential:
// signing in is Better Auth's (auth_session). Rows from before sign-in existed were paired browsers; their
// visits stay with them, and revoked_at is set only on those that were ended then.
export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
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
    /** A browser session ends this many days after sign-in. */
    sessionMaxDays: integer("session_max_days").notNull().default(SESSION_MAX_DAYS_DEFAULT),
    /** When on, a session also ends after sessionIdleMinutes without real input. */
    sessionIdle: boolean("session_idle").notNull().default(false),
    sessionIdleMinutes: integer("session_idle_minutes").notNull().default(SESSION_IDLE_MINUTES_DEFAULT),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("settings_single_row_check", sql`${t.id} = 1`),
    check("settings_closed_item_days_check", sql`${t.closedItemDays} between 1 and 365`),
    check("settings_language_check", oneOf("language", LANGUAGES)),
    check(
      "settings_session_max_days_check",
      sql.raw(`"session_max_days" between ${SESSION_MAX_DAYS_MIN} and ${SESSION_MAX_DAYS_MAX}`),
    ),
    check(
      "settings_session_idle_minutes_check",
      sql.raw(`"session_idle_minutes" between ${SESSION_IDLE_MINUTES_MIN} and ${SESSION_IDLE_MINUTES_MAX}`),
    ),
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

// --- Better Auth (property names are Better Auth's field names) ---
// One user, the owner. Better Auth writes these tables itself on sign-in, enrolment and sign-out; Mikud's
// services write them for setup, the password change, ending sessions and the recovery CLI.

export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  username: text("username").unique(),
  displayUsername: text("display_username"),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  /**
   * Incremented by every credentials reset (the recovery CLI). A session is valid only while its auth_epoch equals
   * this, so a session issued by a request that started before a reset is dead whatever the timing.
   */
  authEpoch: integer("auth_epoch").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: at("updated_at").notNull().defaultNow(),
})

export const authSession = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: at("expires_at").notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: at("updated_at").notNull().defaultNow(),
    // The session clocks (services/session-policy.ts). Better Auth neither knows nor returns these columns.
    /** When the owner signed in: the maximum length counts from here. A replacement session keeps it. */
    authenticatedAt: at("authenticated_at").notNull().defaultNow(),
    /** The last real input the page reported: the idle limit counts from here. Polling never moves it. */
    activeAt: at("active_at").notNull().defaultNow(),
    /** The owner's auth_epoch when Mikud recorded this session. Null until then: such a session is not valid. */
    authEpoch: integer("auth_epoch"),
    /** When this session proved the TOTP code. Null until then: the API refuses it with totp_required. */
    twoFactorAt: at("two_factor_at"),
    /** Why the clocks ended it (max, idle); every request after that is answered session_ended. */
    endedReason: text("ended_reason"),
    endedAt: at("ended_at"),
  },
  (t) => [index("auth_session_user_idx").on(t.userId)],
)

export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: at("access_token_expires_at"),
    refreshTokenExpiresAt: at("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [index("auth_account_user_idx").on(t.userId)],
)

export const authVerification = pgTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: at("expires_at").notNull(),
  createdAt: createdAt(),
  updatedAt: at("updated_at").notNull().defaultNow(),
})

export const authTwoFactor = pgTable(
  "auth_two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: at("locked_until"),
  },
  (t) => [index("auth_two_factor_secret_idx").on(t.secret), index("auth_two_factor_user_idx").on(t.userId)],
)
