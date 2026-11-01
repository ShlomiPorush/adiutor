import { defineConfig } from "drizzle-kit"

// Paths resolve from the repository root: run drizzle-kit from there with --config config/drizzle.config.ts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
})
