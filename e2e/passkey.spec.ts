// Passkeys as the owner uses them, with Chromium's virtual authenticator (a platform authenticator that keeps passkeys
// and verifies the person): added on the Account page, then a sign-in with the passkey alone (no password, no code),
// then removed. Runs after auth.spec.ts and starts from the browser stored there. Browsers refuse an IP address as a
// passkey's domain, so this file needs a host name in E2E_BASE_URL (scripts/verify.sh uses http://localhost:8090).
import { type Browser, type CDPSession, expect, type Page, test } from "@playwright/test"
import he from "../src/shared/locales/he.json" with { type: "json" }
import { passkeysTestable } from "./address.ts"
import { storageFile } from "./helpers.ts"

test.describe.configure({ mode: "serial" })
test.skip(!passkeysTestable(), "passkeys need a host name in E2E_BASE_URL, not an IP address")

let page: Page
let cdp: CDPSession
let authenticatorId = ""
const NAME = `E2E ${Date.now().toString(36)}`

test.beforeAll(async ({ browser }: { browser: Browser }, testInfo) => {
  page = await (
    await browser.newContext({ ...testInfo.project.use, storageState: storageFile(testInfo.project.name) })
  ).newPage()
  cdp = await page.context().newCDPSession(page)
  await cdp.send("WebAuthn.enable")
  ;({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }))
})

test.afterAll(async () => {
  await page?.context().close()
})

const group = () => page.locator("#account-passkeys")

test("a passkey is added on the Account page", async () => {
  await page.goto("/account")
  await group().getByRole("button", { name: he.account.passkeyAdd, exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel(he.account.passkeyName, { exact: true }).fill(NAME)
  await dialog.getByRole("button", { name: he.account.passkeyAddSubmit, exact: true }).click()
  await expect(page.getByText(he.account.passkeyAddDone)).toBeVisible()
  await expect(group()).toContainText(NAME)
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  expect(credentials).toHaveLength(1)
  expect(credentials[0]?.isResidentCredential).toBe(true)
})

test("the passkey alone signs in, without the password or the code", async () => {
  await page.context().clearCookies()
  await page.goto("/login")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(he.login.title)
  await page.getByRole("button", { name: he.login.passkey, exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(he.login.title)
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(he.login.codeTitle)
})

test("the passkey is removed, and the session it made signs out", async () => {
  await page.goto("/account")
  const row = group().locator(".ui-item").filter({ hasText: NAME })
  await row.getByRole("button", { name: he.account.passkeyRemove, exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: he.account.passkeyRemove, exact: true }).click()
  await expect(group()).not.toContainText(NAME)
  const status = await page.evaluate(async () => (await fetch("/api/auth/sign-out", { method: "POST" })).status)
  expect(status).toBe(200)
})
