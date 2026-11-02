import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Unit tests. Tests named *.integration.test.ts need a real PostgreSQL and run from scripts/verify.sh.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  // The web client reads this flag; the mock API is never part of a unit test.
  define: { __MIKUD_MOCK__: "false" },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
})
