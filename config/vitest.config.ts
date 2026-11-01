import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Unit tests. Tests named *.integration.test.ts need a real PostgreSQL and run from scripts/verify.sh.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
})
