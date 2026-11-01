// Sign-in against the real server: the first-run setup with mandatory TOTP, a wrong password, and sign-in with
// a self-computed RFC 6238 code that returns to the page asked for. Each project stores its signed-in browser
// for ui.spec.ts. The first project to run creates the owner; the other finds it and signs in.
import { type Browser, expect, type Page, test } from "@playwright/test"
import he from "../src/shared/locales/he.json" with { type: "json" }
import { PASSWORD, saveState, signIn, storageFile, totpSecret, USERNAME } from "./helpers.ts"
import { freshTotp } from "./totp.ts"

test.describe.configure({ mode: "serial" })
// A code may wait for the next 30-second step.
test.setTimeout(90_000)

let page: Page

test.beforeAll(async ({ browser }: { browser: Browser }, testInfo) => {
  // A real browser with the page's own Origin: nothing is injected.
  page = await (await browser.newContext({ ...testInfo.project.use })).newPage()
})

test("the first run creates the owner, requires TOTP, and returns to the page asked for", async () => {
  await page.goto("/settings")
  const status = await page.evaluate(async () => (await (await fetch("/api/setup/status")).json()).data)
  test.skip(status.hasUser, "the owner exists already (created by the other project)")

  await expect(page).toHaveURL(/\/setup\?next=%2Fsettings$/)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(he.setup.title)
  await page.getByLabel(he.auth.username, { exact: true }).fill(USERNAME)
  await page.getByLabel(he.auth.password, { exact: true }).fill(PASSWORD)
  await page.getByLabel(he.auth.repeatPassword, { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: he.setup.create }).click()

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(he.setup.totpTitle)
  await expect(page.getByRole("img", { name: he.setup.qrAlt })).toBeVisible()
  const secret = (await page.getByTestId("totp-secret").innerText()).trim()
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/)
  saveState({ secret })
  // Until the code is entered, the app refuses this browser.
  const refused = await page.evaluate(async () => (await fetch("/api/v1/session")).status)
  expect(refused).toBe(403)

  await page.getByLabel(he.auth.code, { exact: true }).fill(await freshTotp(secret))
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.locator("#account")).toContainText(USERNAME.toLowerCase())

  // Sign out from Settings: the browser goes to sign-in and the app refuses it.
  await page.locator("#account").getByRole("button", { name: he.account.signOut }).click()
  await expect(page).toHaveURL(/\/login$/)
  expect(await page.evaluate(async () => (await fetch("/api/v1/session")).status)).toBe(401)
})

test("a wrong password stays on the form and says so", async () => {
  await page.goto("/login")
  await page.getByLabel(he.auth.username, { exact: true }).fill(USERNAME)
  await page.getByLabel(he.auth.password, { exact: true }).fill("not the password at all")
  await page.getByRole("button", { name: he.login.submit }).click()
  await expect(page.getByRole("alert")).toHaveText(he.auth.error.wrongPassword)
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByLabel(he.auth.username, { exact: true })).toHaveValue(USERNAME)
  await expect(page.getByLabel(he.auth.password, { exact: true })).toHaveValue("")
})

test("signing in with the password and the code returns to the page asked for", async () => {
  expect(totpSecret()).not.toBe("")
  await page.goto("/settings")
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/)
  await signIn(page)
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.locator("#account")).toContainText(he.account.thisBrowser)
  // The texts of the tests are the Hebrew ones, whatever ran before.
  await page.evaluate(async () => {
    await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Mikud-Request": "1" },
      body: JSON.stringify({ language: "he" }),
    })
  })
  await page.context().storageState({ path: storageFile(test.info().project.name) })
})
