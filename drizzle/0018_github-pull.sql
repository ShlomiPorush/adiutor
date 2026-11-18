ALTER TABLE "audit" DROP CONSTRAINT "audit_source_check";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "github_repo_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "github_repo_id" bigint;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "open_issues_origin" text DEFAULT 'push' NOT NULL;--> statement-breakpoint
ALTER TABLE "security_sources" ADD COLUMN "origin" text DEFAULT 'push' NOT NULL;--> statement-breakpoint
ALTER TABLE "security_sources" ADD COLUMN "attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "security_sources" ADD COLUMN "attempt" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "github_app_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "github_private_key_enc" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "github_key_fingerprint" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "github_key_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "github_installations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "github_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit" ADD CONSTRAINT "audit_source_check" CHECK ("source" in ('ui', 'api', 'mcp', 'telegram', 'sync', 'cli', 'github'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_open_issues_origin_check" CHECK ("open_issues_origin" in ('push', 'github'));--> statement-breakpoint
ALTER TABLE "security_sources" ADD CONSTRAINT "security_sources_origin_check" CHECK ("origin" in ('push', 'github'));--> statement-breakpoint
ALTER TABLE "security_sources" ADD CONSTRAINT "security_sources_attempt_check" CHECK ("attempt" in ('ok', 'error'));--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_github_app_id_check" CHECK ("github_app_id" ~ '^[0-9]{1,20}$');