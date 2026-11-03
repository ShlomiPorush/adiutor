// The Activity filters against the real server, on the desktop and on a phone (v3 MP-6, TB-17, TB-18, NL-3, R5,
// R6): Who narrows the list with the server's counts and the address keeps it through a reload, Back and
// Forward; a project and a search in Hebrew words narrow it to one change; Clear filters empties the address; the
// Filters button opens by keyboard with the focus on its first field, and Escape closes only a picker; on a phone
// the search shares its line with the Filters button and the revealed pickers go two to a line; the item dialog's
// "All activity" opens the item's activity and asks first about an unsaved comment. It reuses the browser that
// signed in in auth.spec.ts. The data is invented and created here through the API.
import { type Browser, expect, type Page, test } from "@playwright/test"
import he from "../src/shared/locales/he.json" with { type: "json" }
import { fill, storageFile } from "./helpers.ts"

test.describe.configure({ mode: "serial" })

let page: Page
let run = ""
let project = { id: "", name: "" }
let trellis = { id: "", title: "" }

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
const pill = (name: string) => page.locator(".ui-fbar .ui-picker-pill", { hasText: `${name}:` })
const countLine = () => page.locator(".ui-fbar .ui-list-summary b")

/**
 * Opens a page and waits until it settled: the shell draws the page again once the owner's settings arrive (its
 * date, time and language), which would drop what a test opened before that.
 */
async function open(path: string): Promise<void> {
  await page.goto(path)
  await page.waitForLoadState("networkidle")
  await expect(countLine()).toBeVisible()
}

async function pick(name: string, option: string): Promise<void> {
  await pill(name).click()
  const search = page.locator(".ui-picker-panel input[type=search]")
  if (await search.isVisible()) await search.fill(option)
  await page
    .getByRole("listbox")
    .getByRole("option", { name: new RegExp(`^${option}`) })
    .click()
  await expect(page.getByRole("listbox")).toHaveCount(0)
}

test.beforeAll(async ({ browser }: { browser: Browser }, testInfo) => {
  run = `${testInfo.project.name}-${Date.now().toString(36)}`
  page = await (
    await browser.newContext({ ...testInfo.project.use, storageState: storageFile(testInfo.project.name) })
  ).newPage()
  await open("/activity")
  project = await api("POST", "/projects", { name: `Trellis walk ${run}` })
  const item = await api<{ id: string; title: string; version: number }>("POST", "/items", {
    type: "task",
    title: `Raise the trellis ${run}`,
    projectId: project.id,
  })
  await api("POST", "/items", { type: "task", title: `Paint the gate ${run}`, projectId: project.id })
  await api("PATCH", `/items/${item.id}`, { version: item.version, status: "in_progress" })
  trellis = item
})

test("Who narrows the list with the server's counts, and the address keeps it", async () => {
  await open("/activity")
  await expect(page.locator(".ui-clear-filters")).toHaveCount(0)
  await pill(he.activity.who).click()
  const owner = page.getByRole("option", { name: new RegExp(`^${he.activity.actorKind.owner}`) })
  const shown = (await owner.locator("small").textContent())?.trim() ?? ""
  await owner.click()
  await expect(page).toHaveURL(/\/activity\?actorKind=owner$/)
  // The count line says what the option said (TB-18).
  await expect(countLine()).toContainText(shown)
  await expect(page.locator(".ui-clear-filters")).toBeVisible()

  await page.reload()
  await page.waitForLoadState("networkidle")
  await expect(pill(he.activity.who)).toContainText(he.activity.actorKind.owner)
  await page.goBack()
  await expect(page).toHaveURL(/\/activity$/)
  await expect(pill(he.activity.who)).toContainText(he.activity.everyone)
  await page.goForward()
  await expect(page).toHaveURL(/\/activity\?actorKind=owner$/)
  await expect(pill(he.activity.who)).toContainText(he.activity.actorKind.owner)
})

test("a project and a search in Hebrew words narrow the list to one change; Clear filters empties the address", async () => {
  await open("/activity")
  await page.locator(".ui-filters-toggle").click()
  await pick(he.activity.project, project.name)
  await expect(page).toHaveURL(new RegExp(`projectId=${project.id}`))
  await expect(page.locator(".ui-filters-toggle")).toHaveAttribute("aria-label", he.filters.inUse.one)
  await expect(page.locator(".ui-filters-n")).toHaveText("1")
  await page.getByRole("searchbox", { name: he.activity.search }).fill(he.audit.action.item_update)
  await expect(page).toHaveURL(/[?&]q=/)
  await expect(countLine()).toHaveText(he.activity.count.one)
  await expect(page.locator("#activity .ui-item")).toHaveCount(1)
  await expect(page.locator("#activity .ui-item")).toContainText(trellis.title)

  await page.locator(".ui-clear-filters").click()
  await expect(page).toHaveURL(/\/activity$/)
  await expect(page.getByRole("searchbox", { name: he.activity.search })).toHaveValue("")
})

test("the Filters button opens by keyboard on its first field; Escape closes only a picker (MP-6, R5)", async () => {
  await open("/activity")
  const toggle = page.locator(".ui-filters-toggle")
  await toggle.focus()
  await page.keyboard.press("Enter")
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  const first = page.locator(".ui-fbar-more .ui-picker-pill").first()
  await expect(first).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(page.getByRole("listbox")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("listbox")).toHaveCount(0)
  await expect(page.locator(".ui-fbar-more")).toBeVisible()
  await expect(first).toBeFocused()

  if (!isPhone()) return
  // A phone: the search shares its line with the Filters button, and the revealed pickers go two to a line.
  const search = await page.locator(".ui-fbar-search").boundingBox()
  const button = await toggle.boundingBox()
  expect(Math.abs((search?.y ?? 0) - (button?.y ?? 100))).toBeLessThan(6)
  const cells = page.locator(".ui-fbar-more > *")
  expect(await cells.count()).toBe(3)
  const [a, b, c] = await Promise.all([0, 1, 2].map((index) => cells.nth(index).boundingBox()))
  expect(Math.abs((a?.y ?? 0) - (b?.y ?? 100))).toBeLessThan(2)
  expect(Math.abs((a?.width ?? 0) - (b?.width ?? 0))).toBeLessThan(2)
  // An odd last one takes the whole line (MO-8).
  expect(c?.y ?? 0).toBeGreaterThan(a?.y ?? 0)
  expect(c?.width ?? 0).toBeGreaterThan((a?.width ?? 0) * 1.8)
  const viewport = page.viewportSize()?.width ?? 0
  const bar = await page.locator(".ui-fbar").boundingBox()
  expect((bar?.x ?? 0) + (bar?.width ?? 0)).toBeLessThanOrEqual(viewport)
})

test("the item dialog's All activity opens the item's activity, and asks first about an unsaved comment (R6)", async () => {
  await open(`/activity?item=${trellis.id}`)
  const dialog = page.getByRole("dialog")
  await expect(dialog.locator("#item-title")).toHaveValue(trellis.title)
  await dialog.getByLabel(he.item.newComment).fill("Half a thought")
  await dialog.getByRole("link", { name: he.item.allActivity }).click()
  const question = page.getByRole("alertdialog")
  await expect(question).toContainText(he.unsaved.discardTitle)
  await question.getByRole("button", { name: he.unsaved.keepEditing }).click()
  await expect(dialog.getByLabel(he.item.newComment)).toHaveValue("Half a thought")
  await expect(page).toHaveURL(new RegExp(`[?&]item=${trellis.id}`))

  await dialog.getByRole("link", { name: he.item.allActivity }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: he.unsaved.discard }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/activity\\?itemId=${trellis.id}$`))
  await expect(page.locator(".ui-fbar-tag")).toContainText(trellis.title)
  // A long title is cut inside its tag; the page never scrolls sideways.
  expect(
    await page.locator(".ui-page").evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(0)
  // The item's creation and its status change.
  await expect(countLine()).toHaveText(fill(he.activity.count.other, { count: 2 }))
})
