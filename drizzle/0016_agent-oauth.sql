CREATE TABLE "agent_identity_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"host" text NOT NULL,
	"pid" integer NOT NULL,
	"process_started_at" text
);
--> statement-breakpoint
ALTER TABLE "agent_state" ADD COLUMN "signing_key_enc" text;