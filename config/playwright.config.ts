import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, devices } from "@playwright/test"

// End-to-end tests of the web UI against a running Adiutor. scripts/verify.sh runs them in the
// Playwright image on the verification stack's network, with E2E_TARGET=adiutor:8080; e2e/global-setup.ts
// then forwards 127.0.0.1:8090 (the stack's ADIUTOR_PUBLIC_URL) to it, so the browser's Origin passes the
// server's CSRF check. Without E2E_TARGET the tests use the development stack (scripts/local.sh).
// Better Auth keys its rate limits on X-Forwarded-For (no proxy trusted in these stacks): each project sends its own
// documentation address, so the two projects never share a sign-in budget. The phone runs after the desktop, which
// creates the owner.
export default defineConfig({
  testDir: fileURLToPath(new URL("../e2e", import.meta.url)),
  globalSetup: fileURLToPath(new URL("../e2e/global-setup.ts", import.meta.url)),
  outputDir: join(tmpdir(), "adiutor-e2e"),
  reporter: "list",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:8090",
    trace: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: { "x-forwarded-for": "198.51.100.11" },
      },
    },
    {
      name: "phone",
      dependencies: ["desktop"],
      use: { ...devices["Pixel 7"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.12" } },
    },
  ],
})
