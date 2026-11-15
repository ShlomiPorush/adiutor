CREATE TABLE "agent_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"connected_via" text NOT NULL,
	"resource" text NOT NULL,
	"areas" text[] NOT NULL,
	"client_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"issuer" text NOT NULL,
	"redirect_host" text,
	"approved_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"ended_by" text,
	CONSTRAINT "agent_connections_grant_id_unique" UNIQUE("grant_id"),
	CONSTRAINT "agent_connections_connected_via_check" CHECK ("connected_via" in ('code', 'browser')),
	CONSTRAINT "agent_connections_resource_check" CHECK ("resource" in ('mcp', 'rest')),
	CONSTRAINT "agent_connections_areas_check" CHECK ("areas" <@ array['read', 'write', 'sync']::text[]),
	CONSTRAINT "agent_connections_sync_rest_only_check" CHECK ("resource" = 'rest' or not ('sync' = any("areas"))),
	CONSTRAINT "agent_connections_end_reason_check" CHECK ("end_reason" in ('disconnected', 'all_disconnected', 'turned_off', 'unused', 'refresh_reused', 'code_reused', 'person_changed', 'issuer_changed')),
	CONSTRAINT "agent_connections_ended_by_check" CHECK ("ended_by" in ('owner', 'agent', 'bot', 'sync', 'system')),
	CONSTRAINT "agent_connections_ended_check" CHECK (("agent_connections"."ended_at" is null) = ("agent_connections"."end_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "agent_consent" (
	"key" text PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"session_id" text,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"issuer_fingerprint" text,
	CONSTRAINT "agent_state_single_row_check" CHECK ("agent_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "oauth_store" (
	"type" text NOT NULL,
	"id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"grant_id" text,
	"user_code" text,
	"uid" text,
	"expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_store_type_id_pk" PRIMARY KEY("type","id")
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "agents_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "agent_idle_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_consent_expires_idx" ON "agent_consent" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_store_grant_idx" ON "oauth_store" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "oauth_store_user_code_idx" ON "oauth_store" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "oauth_store_uid_idx" ON "oauth_store" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "oauth_store_expires_idx" ON "oauth_store" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_agent_idle_days_check" CHECK ("agent_idle_days" between 1 and 365);