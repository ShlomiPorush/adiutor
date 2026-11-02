CREATE TABLE "auth_api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "auth_rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "settings" DROP CONSTRAINT "settings_session_max_days_check";--> statement-breakpoint
ALTER TABLE "settings" DROP CONSTRAINT "settings_session_idle_minutes_check";--> statement-breakpoint
ALTER TABLE "auth_api_key" ADD CONSTRAINT "auth_api_key_reference_id_auth_user_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_api_key_config_id_idx" ON "auth_api_key" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "auth_api_key_reference_id_idx" ON "auth_api_key" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "auth_api_key_key_idx" ON "auth_api_key" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_user_single_owner" ON "auth_user" USING btree ((true));--> statement-breakpoint
ALTER TABLE "auth_session" DROP COLUMN "authenticated_at";--> statement-breakpoint
ALTER TABLE "auth_session" DROP COLUMN "active_at";--> statement-breakpoint
ALTER TABLE "auth_session" DROP COLUMN "auth_epoch";--> statement-breakpoint
ALTER TABLE "auth_session" DROP COLUMN "two_factor_at";--> statement-breakpoint
ALTER TABLE "auth_session" DROP COLUMN "ended_reason";--> statement-breakpoint
ALTER TABLE "auth_session" DROP COLUMN "ended_at";--> statement-breakpoint
ALTER TABLE "auth_user" DROP COLUMN "auth_epoch";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "session_max_days";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "session_idle";--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "session_idle_minutes";