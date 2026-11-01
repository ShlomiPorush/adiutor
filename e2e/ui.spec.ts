// The web UI against the real server: pairing, the morning view, an item status change with Undo,
// and quick add. Texts come from the Hebrew locale file (the default language), and the data is
// invented and created here through the API, so the tests run on an empty database.
import { type Browser, expect, type Page, test } from "@playwright/test"
import he from "../src/shared/locales/he.json" with { type: "json" }

const OWNER_TOKEN = "dev-only-owner-token-not-a-secret-000000"
// Like the UI: every filled value is wrapped in a first-strong isolate (U+2068 ... U+2069).
const fill = (text: string, vars: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, name: string) => `⁨${vars[name] ?? ""}⁩`)

test.describe.configure({ mode: "serial" })

let page: Page
let run = ""
let itemTitle = ""
let captureText = ""

/** A request from the page itself: the browser sends the device cookie and the Origin. */
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(`/api/v1${path}`, {
        method,
        headers: { "Content-Type": "application/json", "X-Mikud-Request": "1" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
      return (await response.json()).data
    },
    { method, path, body },
  )
}

const isPhone = () => (page.viewportSize()?.width ?? 1440) <= 760

test.beforeAll(async ({ browser }: { browser: Browser }, testInfo) => {
  // Each project (desktop, phone) works on its own invented records.
  run = `${testInfo.project.name}-${Date.now().toString(36)}`
  itemTitle = `Approve the release notes ${run}`
  captureText = `Check the phone layout of quick add ${run}`
  page = await (await browser.newContext({ ...testInfo.project.use })).newPage()
})

test("a new browser is sent to pairing, refuses a wrong token and comes back paired", async () => {
  await page.goto("/settings")
  await expect(page).toHaveURL(/\/pair\?next=%2Fsettings$/)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(he.pair.title)
  // The token field is a secret field: never in the address, shown only on request.
  const token = page.getByLabel(he.pair.token, { exact: true })
  await expect(token).toHaveAttribute("type", "password")

  await token.fill("wrong-token-wrong-token-wrong-token-0000")
  await page.getByRole("button", { name: he.pair.submit }).click()
  await expect(page.getByRole("alert")).toHaveText(he.pair.rejected)

  await token.fill(OWNER_TOKEN)
  await page.getByRole("button", { name: he.pair.submit }).click()
  await expect(page).toHaveURL(/\/settings$/)
  // The texts in these tests are the Hebrew ones: the board is in Hebrew whatever ran before.
  await api("PATCH", "/settings", { language: "he" })
  await page.reload()
  await expect(page.locator("#devices")).toContainText(he.devices.thisDevice)
  expect(page.url()).not.toContain(OWNER_TOKEN)
})

test("the morning view shows what waits on the owner, and the bell counts it", async () => {
  const project = await api<{ id: string }>("POST", "/projects", { name: `Lantern ${run}`, stage: "production" })
  await api("POST", "/items", { type: "decision", status: "waiting_on_you", title: itemTitle, projectId: project.id })

  await page.goto("/")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(he.morning.title)
  await expect(page.locator("#waiting")).toContainText(itemTitle)
  const bell = page.locator(isPhone() ? ".ui-mtop .ui-bell" : ".ui-topbar .ui-bell")
  // The badge shows the count; the name says it in words ("1 item" is written as a word in Hebrew).
  await expect(bell.locator(".ui-bell-n")).toBeVisible()
  await expect(bell).not.toHaveAttribute("aria-label", he.bell.none)
  await expect(bell).toHaveAttribute("aria-label", new RegExp(`^${he.bell.title}`))
})

test("new since the last visit stays on the page when it refreshes", async () => {
  const newTitle = `Fresh note ${run}`
  await api("POST", "/items", { type: "task", title: newTitle })
  const visited = page.waitForResponse((r) => r.url().endsWith("/api/v1/visits") && r.status() === 201)
  await page.goto("/")
  await expect(page.locator("#new")).toContainText(newTitle)
  // The visit is recorded after the first read; a refresh after it must still show what was new then.
  await visited
  const refreshed = page.waitForResponse((r) => r.url().includes("/api/v1/morning?since=") && r.ok())
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")))
  await refreshed
  await expect(page.locator("#new")).toContainText(newTitle)
})

test("an item opens over the page, changes status at once, and Undo puts it back", async () => {
  await page.locator("#waiting .ui-item", { hasText: itemTitle }).click()
  await expect(page).toHaveURL(/[?&]item=/)
  const status = page.locator("[data-item-status]")
  await expect(status).toHaveValue("waiting_on_you")

  await status.selectOption("done")
  const toast = page.locator(".ui-toast")
  await expect(toast).toContainText(fill(he.toast.statusSet, { title: itemTitle, status: he.itemStatus.done }))
  await expect(status).toHaveValue("done")

  await toast.getByRole("button", { name: fill(he.toast.undoStatus, { title: itemTitle }) }).click()
  await expect(status).toHaveValue("waiting_on_you")

  await page.keyboard.press("Escape")
  await expect(page).not.toHaveURL(/[?&]item=/)
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test("quick add files a note in the inbox", async () => {
  await page.goto("/")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(he.morning.title)
  if (isPhone()) await page.locator(".ui-mtop").getByRole("button", { name: he.quickAdd.button }).click()
  else await page.keyboard.press("n")
  const dialog = page.getByRole("dialog", { name: he.quickAdd.title })
  await dialog.getByLabel(he.quickAdd.text).fill(captureText)
  await page.getByRole("button", { name: he.quickAdd.add, exact: true }).click()
  await expect(page.locator(".ui-toast")).toContainText(he.quickAdd.addedToInbox)

  await page.goto("/inbox")
  await expect(page.locator("#inbox")).toContainText(captureText)
})
