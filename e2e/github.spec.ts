// The server's GitHub reading end to end, against the stand-in GitHub API that scripts/verify.sh runs on the stack's
// network (e2e/github-stand-in.mjs, its end-to-end scenario): the App id and its private key pasted in Settings,
// GitHub and checked with GitHub, an installation added by its id, Read now, and the project's critical Dependabot
// alert on the board. The key pair is new on every run: verify.sh hands the private key to this container only, as a
// read-only file (E2E_GITHUB_KEY_FILE). Without it (the development stack) the spec is skipped.
import { readFileSync } from "node:fs"
import { type Browser, expect, type Page, test } from "@playwright/test"
import he from "../src/shared/locales/he.json" with { type: "json" }
import { storageFile } from "./helpers.ts"

test.describe.configure({ mode: "serial" })

const KEY_FILE = process.env.E2E_GITHUB_KEY_FILE
const APP_ID = process.env.E2E_GITHUB_APP_ID
/** The stand-in's installation and repository (e2eScenario in e2e/github-stand-in.mjs). */
const INSTALLATION = "4242"
const REPO = "example-org/widget"
const PROJECT = "Widget GitHub e2e"

let page: Page
let projectId: string | null = null

test.beforeAll(async ({ browser }: { browser: Browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the flow runs once")
  test.skip(!KEY_FILE || !APP_ID, "E2E_GITHUB_KEY_FILE is not set (scripts/verify.sh sets it)")
  page = await (
    await browser.newContext({ ...testInfo.project.use, storageState: storageFile(testInfo.project.name) })
  ).newPage()
})

test.afterAll(async () => {
  if (!page) return
  if (projectId) await api("DELETE", `/projects/${projectId}`).catch(() => {})
  await page.context().close()
})

/** A request from the page itself: the browser sends the session cookie and the Origin. */
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(`/api/v1${path}`, {
        method,
        headers: { "Content-Type": "application/json", "X-Adiutor-Request": "1" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
      return response.status === 204 ? (undefined as T) : (await response.json()).data
    },
    { method, path, body },
  )
}

test("the App and its key are saved in Settings, an installation is added, and Read now fills the board", async () => {
  await page.goto("/")
  const project = await api<{ id: string }>("POST", "/projects", { name: PROJECT, githubRepo: REPO })
  projectId = project.id

  await page.goto("/settings/github")
  await page.getByLabel(he.githubSettings.appId, { exact: true }).fill(APP_ID as string)
  await page.getByLabel(he.githubSettings.key, { exact: true }).fill(readFileSync(KEY_FILE as string, "utf8"))
  const bar = page.getByRole("region", { name: he.savebar.region })
  await bar.getByRole("button", { name: he.savebar.save }).click()
  // GitHub (the stand-in) accepted the key: its fingerprint shows, and the pasted text is gone from the page.
  await expect(page.getByText(he.githubSettings.keyAccepted)).toBeVisible()
  await expect(page.getByText(/^SHA256:/)).toBeVisible()
  expect(await page.content()).not.toContain("PRIVATE KEY")

  await page.getByLabel(he.githubSettings.addLabel, { exact: true }).fill(INSTALLATION)
  await page.getByRole("button", { name: he.githubSettings.add, exact: true }).click()
  await expect(page.locator("#settings-github-installations")).toContainText("example-org")

  await page.getByRole("button", { name: he.githubSettings.readNow, exact: true }).click()
  // The pull runs in the background; the section reads again by itself.
  await expect(page.locator("#settings-github-pull")).toContainText(he.githubSettings.accountsRead, { timeout: 30_000 })

  await page.goto("/")
  await expect(page.locator("#security")).toContainText(PROJECT, { timeout: 30_000 })
})
