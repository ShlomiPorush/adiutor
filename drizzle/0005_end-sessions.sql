-- Custom SQL migration (drizzle-kit generate --custom). Sessions from before Better Auth decides alone (no
-- per-session TOTP proof, no epoch) end once: every browser signs in again after the upgrade.
DELETE FROM "auth_session";
