// Settings against the real server, in the browser auth.spec.ts stored: an agent key shown once and revoked, the
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

test("an agent key is shown once, works as a bearer key, and is gone after Revoke", async () => {
  const panel = page.locator("#agents")
  const name = `e2e ${test.info().project.name}`
  await panel.getByRole("button", { name: he.agentKeys.create }).click()
  const dialog = page.getByRole("dialog", { name: he.agentKeys.createTitle })
  await dialog.getByLabel(he.agentKeys.name, { exact: true }).fill(name)
  await dialog.getByRole("button", { name: he.agentKeys.createSubmit }).click()
  const shown = page.getByRole("dialog", { name: he.agentKeys.createdTitle })
  const key = ((await shown.getByTestId("agent-key").textContent()) ?? "").trim()
  expect(key).toMatch(/^mkd_[A-Za-z]{64}$/)
  await shown.getByRole("button", { name: he.agentKeys.done }).click()

  const row = panel.locator(".ui-item", { hasText: name })
  await expect(row).toContainText(key.slice(0, 6))
  await expect(row).not.toContainText(key.slice(6))
  const asAgent = (k: string) =>
    page.evaluate(
      async (bearer) => (await fetch("/api/v1/projects", { headers: { authorization: `Bearer ${bearer}` } })).status,
      k,
    )
  expect(await asAgent(key)).toBe(200)

  await row.getByRole("button", { name: he.agentKeys.revoke, exact: true }).click()
  const confirm = page.getByRole("alertdialog")
  await confirm.getByRole("button", { name: he.agentKeys.revoke, exact: true }).click()
  await expect(panel.locator(".ui-item", { hasText: name })).toHaveCount(0)
  expect(await asAgent(key)).toBe(401)
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
