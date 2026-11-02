-- Custom SQL migration (drizzle-kit generate --custom). The owner's synthetic e-mail becomes the readable one of
-- ownerEmail (src/shared/auth.ts): the lowercased username at mikud.local instead of the username in hex, so the
-- authenticator app shows the username. Only rows with the hex e-mail and a username that follows the username rule
-- (USERNAME_PATTERN, 3 to 30 characters) change; every other row stays as it is.
UPDATE "auth_user"
SET "email" = lower("username") || '@mikud.local'
WHERE "email" ~ '^u-[0-9a-f]+@mikud\.local$'
  AND "username" ~ '^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$'
  AND char_length("username") BETWEEN 3 AND 30;
