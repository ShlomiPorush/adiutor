CREATE TABLE "audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_label" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"source" text NOT NULL,
	CONSTRAINT "audit_actor_kind_check" CHECK ("actor_kind" in ('owner', 'agent', 'bot', 'sync', 'system')),
	CONSTRAINT "audit_source_check" CHECK ("source" in ('ui', 'api', 'mcp', 'telegram', 'sync'))
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"author_kind" text NOT NULL,
	"author_label" text,
	"text" text NOT NULL,
	"thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_author_kind_check" CHECK ("author_kind" in ('owner', 'agent', 'bot', 'sync', 'system'))
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_hash" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "item_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"thread_id" text NOT NULL,
	"t3_project_id" text,
	"title" text,
	"last_status" text,
	"settled" boolean DEFAULT false NOT NULL,
	"last_activity_at" timestamp with time zone,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_threads_thread_id_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"severity" text,
	"goal_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"status_set_by" text NOT NULL,
	"status_set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"imported" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "items_type_check" CHECK ("type" in ('bug', 'decision', 'security', 'task', 'idea')),
	CONSTRAINT "items_status_check" CHECK ("status" in ('future', 'todo', 'in_progress', 'waiting_on_you', 'done', 'not_relevant')),
	CONSTRAINT "items_severity_check" CHECK ("severity" in ('critical', 'high', 'medium', 'low')),
	CONSTRAINT "items_severity_security_only_check" CHECK ("items"."severity" is null or "items"."type" = 'security'),
	CONSTRAINT "items_status_set_by_check" CHECK ("status_set_by" in ('owner', 'agent', 'bot', 'sync', 'system')),
	CONSTRAINT "items_created_by_check" CHECK ("created_by" in ('owner', 'agent', 'bot', 'sync', 'system')),
	CONSTRAINT "items_version_check" CHECK ("items"."version" >= 1),
	CONSTRAINT "items_closed_at_check" CHECK (("items"."closed_at" is not null) = ("status" in ('done', 'not_relevant')))
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"local_date" date NOT NULL,
	"state" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" text,
	CONSTRAINT "job_runs_job_local_date_unique" UNIQUE("job","local_date"),
	CONSTRAINT "job_runs_state_check" CHECK ("state" in ('sending', 'sent', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"t3_project_id" text,
	"github_repo" text,
	"stage" text,
	"where_we_are" text,
	"open_issues_count" integer,
	"open_issues_as_of" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "projects_t3_project_id_unique" UNIQUE("t3_project_id"),
	CONSTRAINT "projects_stage_check" CHECK ("stage" in ('idea', 'poc', 'development', 'production', 'redesign', 'frozen')),
	CONSTRAINT "projects_open_issues_count_check" CHECK ("projects"."open_issues_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "security_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"family" text NOT NULL,
	"coverage" text DEFAULT 'unknown' NOT NULL,
	"critical" integer DEFAULT 0 NOT NULL,
	"high" integer DEFAULT 0 NOT NULL,
	"medium" integer DEFAULT 0 NOT NULL,
	"low" integer DEFAULT 0 NOT NULL,
	"as_of" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_sources_project_family_unique" UNIQUE("project_id","family"),
	CONSTRAINT "security_sources_family_check" CHECK ("family" in ('dependabot', 'code_scanning', 'secret_scanning', 'overview')),
	CONSTRAINT "security_sources_coverage_check" CHECK ("coverage" in ('enabled', 'not_enabled', 'no_access', 'error', 'unknown')),
	CONSTRAINT "security_sources_counts_check" CHECK ("security_sources"."critical" >= 0 and "security_sources"."high" >= 0 and "security_sources"."medium" >= 0 and "security_sources"."low" >= 0)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"closed_item_days" integer DEFAULT 7 NOT NULL,
	"date_format" text DEFAULT 'dd/MM/yyyy' NOT NULL,
	"time_format" text DEFAULT 'HH:mm' NOT NULL,
	"language" text DEFAULT 'he' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_single_row_check" CHECK ("settings"."id" = 1),
	CONSTRAINT "settings_closed_item_days_check" CHECK ("settings"."closed_item_days" between 1 and 365),
	CONSTRAINT "settings_language_check" CHECK ("language" in ('he', 'en'))
);
--> statement-breakpoint
CREATE TABLE "stage_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"proposed_stage" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"author_kind" text NOT NULL,
	"author_label" text,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "stage_proposals_proposed_stage_check" CHECK ("proposed_stage" in ('idea', 'poc', 'development', 'production', 'redesign', 'frozen')),
	CONSTRAINT "stage_proposals_author_kind_check" CHECK ("author_kind" in ('owner', 'agent', 'bot', 'sync', 'system')),
	CONSTRAINT "stage_proposals_state_check" CHECK ("state" in ('open', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppressions_kind_external_id_unique" UNIQUE("kind","external_id"),
	CONSTRAINT "suppressions_kind_check" CHECK ("kind" in ('thread', 'project'))
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "sync_runs_outcome_check" CHECK ("outcome" in ('succeeded', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"outcome" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_updates_outcome_check" CHECK ("outcome" in ('item_created', 'ignored', 'refused'))
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_threads" ADD CONSTRAINT "item_threads_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_sources" ADD CONSTRAINT "security_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_proposals" ADD CONSTRAINT "stage_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "comments_item_idx" ON "comments" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goals_one_open_per_project_idx" ON "goals" USING btree ("project_id") WHERE "goals"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "item_threads_item_idx" ON "item_threads" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "items_project_idx" ON "items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "items_status_idx" ON "items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "items_goal_idx" ON "items" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "stage_proposals_project_idx" ON "stage_proposals" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "sync_runs_started_idx" ON "sync_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "visits_device_at_idx" ON "visits" USING btree ("device_id","at");