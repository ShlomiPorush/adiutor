CREATE TABLE "agent_identity_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_state" ADD COLUMN "signing_key_enc" text;