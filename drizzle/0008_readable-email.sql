-- Custom SQL migration (drizzle-kit generate --custom). The owner's synthetic e-mail becomes the readable one of
-- ownerEmail (src/shared/auth.ts): the lowercased username at mikud.local instead of the username in hex, so the
-- authenticator app shows the username.
-- The username plugin also checks the new rule (USERNAME_PATTERN, 3 to 30 characters) at sign-in, before the
-- password, so an owner whose stored name breaks it could not sign in after the upgrade. The upgrade stops instead,
-- before anything changes; docs/deployment.md (Upgrade) says how to rename the owner first.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT "username" INTO bad FROM "auth_user"
  WHERE "username" !~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$' OR char_length("username") NOT BETWEEN 3 AND 30
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'username "%" no longer meets the sign-in rule; rename it before upgrading (see docs/deployment.md)', bad;
  END IF;
END $$;
--> statement-breakpoint
UPDATE "auth_user"
SET "email" = "username" || '@mikud.local'
WHERE "email" ~ '^u-[0-9a-f]+@mikud\.local$' AND "username" IS NOT NULL;
