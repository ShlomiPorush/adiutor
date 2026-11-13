import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Integration tests against a disposable PostgreSQL. scripts/verify.sh starts it and passes
// ADIUTOR_TEST_DATABASE_URL, a role that may create databases.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
