CREATE TABLE "sync_client" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"last_checkin_at" timestamp with time zone NOT NULL,
	"version" text NOT NULL,
	"paused" boolean NOT NULL,
	"paused_until" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"running" jsonb
);
--> statement-breakpoint
CREATE TABLE "sync_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"requested_by" text NOT NULL,
	"state" text NOT NULL,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	CONSTRAINT "sync_requests_state_check" CHECK ("state" in ('waiting', 'claimed', 'done', 'partial', 'failed', 'unknown', 'cancelled')),
	CONSTRAINT "sync_requests_requested_by_check" CHECK ("requested_by" in ('owner', 'agent', 'bot', 'sync', 'system')),
	CONSTRAINT "sync_requests_claimed_check" CHECK ("sync_requests"."state" in ('waiting', 'cancelled') or ("sync_requests"."claimed_by" is not null and "sync_requests"."claimed_at" is not null and "sync_requests"."lease_until" is not null))
);
--> statement-breakpoint
ALTER TABLE "item_threads" ADD COLUMN "snoozed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "item_threads" ADD COLUMN "snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "item_threads" ADD COLUMN "snooze_as_of" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_requests_one_open_idx" ON "sync_requests" USING btree ((true)) WHERE "sync_requests"."state" in ('waiting', 'claimed');--> statement-breakpoint
CREATE INDEX "sync_requests_requested_idx" ON "sync_requests" USING btree ("requested_at");