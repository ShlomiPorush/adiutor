ALTER TABLE "settings" ADD COLUMN "session_idle_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "otp_via_telegram" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "telegram_bot_token_enc" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "telegram_chat_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "private_domains" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_session_idle_days_check" CHECK ("session_idle_days" between 1 and 90);--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_telegram_chat_id_check" CHECK ("telegram_chat_id" ~ '^-?[0-9]{1,20}$');