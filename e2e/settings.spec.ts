// Settings against the real server, in the browser auth.spec.ts stored: how agents connect (connect.spec.ts runs it), the
// password changed and changed back without leaving the page, the browsers list, and the Telegram fields editable
// when no environment variable sets them. Stores the browser again at the end: a password change replaces this
// browser's session.
import { type Browser, expect, type Page, test } from "@playwright/test"
import he from "../src/shared/locales/he.json" with { type: "json" }
import { PASSWORD, storageFile } from "./helpers.ts"

test.describe.configure({ mode: "serial" })

let page: Page

test.beforeAll(async ({ browser }: { browser: Browser }, testInfo) => {
  page = await (
    await browser.newContext({ ...testInfo.project.use, storageState: storageFile(testInfo.project.name) })
  ).newPage()
  await page.goto("/settings")
  await expect(page).toHaveURL(/\/settings$/)
})

test.afterAll(async () => {
  await page.context().storageState({ path: storageFile(test.info().project.name) })
  await page.context().close()
})

test("Agent access has no manual key: it shows how to connect, with this address", async () => {
  const panel = page.locator("#agents")
  await expect(panel.getByRole("heading", { name: he.agentKeys.howTitle })).toBeVisible()
  await expect(panel).toContainText(
    "node dist/sync/mikud-sync.js connect --url http://127.0.0.1:8090 --name sync --for sync",
  )
  await expect(panel).toContainText("--name claude --for claude")
  await expect(panel).toContainText("--name codex --for codex")
})

test("the password changes and changes back without leaving the page", async () => {
  const panel = page.locator("#account")
  const change = async (from: string, to: string) => {
    await panel.getByLabel(he.account.currentPassword, { exact: true }).fill(from)
    await panel.getByLabel(he.account.newPassword, { exact: true }).fill(to)
    await panel.getByLabel(he.account.repeatNewPassword, { exact: true }).fill(to)
    await panel.getByRole("button", { name: he.account.change }).click()
    // The form empties only when Better Auth answered: then this browser holds its new session cookie.
    await expect(panel.getByLabel(he.account.currentPassword, { exact: true })).toHaveValue("")
    await expect(page.getByText(he.account.changed).first()).toBeVisible()
  }
  await change(PASSWORD, `${PASSWORD} again`)
  await change(`${PASSWORD} again`, PASSWORD)
  await expect(page).toHaveURL(/\/settings$/)
  expect(await page.evaluate(async () => (await fetch("/api/v1/session")).status)).toBe(200)
  // Better Auth signed out the other browsers; this one is the only one listed.
  await expect(panel.locator(".ui-item")).toHaveCount(1)
  await expect(panel.locator(".ui-item")).toContainText(he.account.thisBrowser)
})

test("the Telegram fields are editable when no environment variable sets them", async () => {
  const panel = page.locator("#telegram")
  await expect(panel.getByLabel(he.telegramSettings.chatId, { exact: true })).toBeEditable()
  await expect(panel.getByLabel(he.telegramSettings.botToken, { exact: true })).toBeEditable()
  await expect(panel).not.toContainText(he.settings.env.pill)
  // A switch that needs Telegram says so while Telegram is off.
  await expect(panel.getByRole("switch")).toBeDisabled()
  await expect(panel).toContainText(he.telegramSettings.otpNeedsTelegram)
})
