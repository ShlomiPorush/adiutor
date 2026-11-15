-- Custom SQL migration (drizzle-kit generate --custom). Agents are off for a new installation (the column's default,
-- 0014); the installation that existed before the switch keeps them on, so its agents keep working. Only a settings
-- row that exists now changes: a new database has none yet, and its row is created later with the default.
UPDATE "settings" SET "agents_enabled" = true;
