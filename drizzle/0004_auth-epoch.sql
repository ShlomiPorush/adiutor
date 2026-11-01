ALTER TABLE "auth_session" ADD COLUMN "auth_epoch" integer;--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "auth_epoch" integer DEFAULT 0 NOT NULL;