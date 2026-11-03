// The web UI against the real server: the morning view, an item status change with Undo, quick add, and
// signing out from the shell's account menu (Stay, a failed sign-out that keeps the draft, then a sign-out). It runs after auth.spec.ts and reuses the browser that signed in there (sign-in is rate
// limited). Texts come from the Hebrew locale file (the default language), and the data is invented and
// created here through the API, so the tests run on an empty database.
import { type Browser, expect, type Page, test } from "@playwright/test"
import he from "../src/shared/locales/he.json" with { type: "json" }
import { fill, storageFile } from "./helpers.ts"

test.describe.configure({ mode: "serial" })

let page: Page
let run = ""
let itemTitle = ""
let captureText = ""

/** A request from the page itself: the browser sends the session cookie and the Origin. */
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
  page = await (
    await browser.newContext({ ...testInfo.project.use, storageState: storageFile(testInfo.project.name) })
  ).newPage()
})

test("the stored session opens the board without signing in again", async () => {
  await page.goto("/account")
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.locator("#account")).toContainText(he.account.thisBrowser)
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

const MORNING_ORDER = ["waiting", "security", "new", "updates", "projects"]

test("the morning view reads in one order: two columns on a wide screen, one on a phone, and Tab follows it", async () => {
  // Something new since the visit the test before recorded, so the second column has a row to reach.
  await api("POST", "/items", { type: "task", title: `Prune the hedge ${run}` })
  await page.goto("/")
  await expect(page.locator("#new")).toContainText(`Prune the hedge ${run}`)
  await expect(page.locator("#waiting")).toContainText(itemTitle)

  const boxes = await page.evaluate((ids) => {
    const rtl = document.documentElement.dir === "rtl"
    return {
      rtl,
      parts: ids.map((id) => {
        const r = document.getElementById(id)?.getBoundingClientRect()
        if (!r) throw new Error(`no #${id}`)
        // The start edge: the right edge in Hebrew, the left one in English.
        return { id, start: rtl ? r.right : r.left, top: r.top, bottom: r.bottom, width: r.width }
      }),
    }
  }, MORNING_ORDER)
  const [waiting, security, fresh, updates, projects] = boxes.parts as [
    (typeof boxes.parts)[0],
    (typeof boxes.parts)[0],
    (typeof boxes.parts)[0],
    (typeof boxes.parts)[0],
    (typeof boxes.parts)[0],
  ]
  expect(boxes.rtl).toBe(true)
  if (isPhone()) {
    // One column, top to bottom in the page's order, waiting on you first.
    for (const part of boxes.parts) {
      expect(Math.abs(part.start - waiting.start)).toBeLessThanOrEqual(1)
      expect(Math.abs(part.width - waiting.width)).toBeLessThanOrEqual(1)
    }
    const tops = boxes.parts.map((part) => part.top)
    expect([...tops].sort((a, b) => a - b)).toEqual(tops)
  } else {
    // First column at the start side: waiting, then security; the second beside it: new, then agent updates.
    expect(Math.abs(security.start - waiting.start)).toBeLessThanOrEqual(1)
    expect(Math.abs(updates.start - fresh.start)).toBeLessThanOrEqual(1)
    expect(Math.abs(fresh.top - waiting.top)).toBeLessThanOrEqual(1)
    expect(security.top).toBeGreaterThan(waiting.bottom)
    expect(updates.top).toBeGreaterThan(fresh.bottom)
    expect(fresh.start).toBeLessThan(waiting.start - waiting.width / 2) // the second column is toward the end (left)
    expect(Math.abs(fresh.width - waiting.width)).toBeLessThanOrEqual(1)
    // Projects span both columns below them.
    expect(projects.top).toBeGreaterThan(Math.max(security.bottom, updates.bottom))
    expect(Math.abs(projects.start - waiting.start)).toBeLessThanOrEqual(1)
    expect(projects.width).toBeGreaterThan(waiting.width + fresh.width)
  }

  // Tab from the last figure before the columns walks the parts in the page's order.
  await page.locator(".ui-kpis a.ui-kpi").focus()
  const reached: string[] = []
  for (let step = 0; step < 80 && reached.at(-1) !== "projects"; step += 1) {
    await page.keyboard.press("Tab")
    const id = await page.evaluate(() => document.activeElement?.closest(".ui-morning section")?.id ?? null)
    if (id && reached.at(-1) !== id) reached.push(id)
  }
  expect(reached).toEqual(MORNING_ORDER.filter((id) => reached.includes(id)))
  expect(reached[0]).toBe("waiting")
  expect(reached).toContain("new")
  expect(reached.at(-1)).toBe("projects")
})

/**
 * Another tab of the paired browser with a clock the test moves: pages refresh every 30 seconds, so moving
 * the clock 31 seconds brings the background refresh at once. The caller closes its context.
 */
async function tabWithClock(browser: Browser, use: object): Promise<Page> {
  const context = await browser.newContext({ ...use, storageState: await page.context().storageState() })
  await context.clock.install()
  return context.newPage()
}

const REFRESH = 31_000

test("new since the last visit stays on the page when it refreshes", async ({ browser }, testInfo) => {
  const newTitle = `Fresh note ${run}`
  await api("POST", "/items", { type: "task", title: newTitle })
  const tab = await tabWithClock(browser, testInfo.project.use)
  try {
    const visited = tab.waitForResponse((r) => r.url().endsWith("/api/v1/visits") && r.status() === 201)
    await tab.goto("/")
    await expect(tab.locator("#new")).toContainText(newTitle)
    // The visit is recorded after the first read; a refresh after it must still show what was new then.
    await visited
    const refreshed = tab.waitForResponse((r) => r.url().includes("/api/v1/morning?since=") && r.ok())
    await tab.clock.fastForward(REFRESH)
    await refreshed
    await expect(tab.locator("#new")).toContainText(newTitle)
  } finally {
    await tab.context().close()
  }
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

test("saving over a change made meanwhile keeps the draft and offers Reload", async ({ browser }, testInfo) => {
  const created = await api<{ id: string; version: number }>("POST", "/items", {
    type: "task",
    title: `Draft target ${run}`,
  })
  const tab = await tabWithClock(browser, testInfo.project.use)
  try {
    await tab.goto(`/?item=${created.id}`)
    const dialog = tab.getByRole("dialog")
    const bodyField = dialog.getByLabel(he.item.body, { exact: true })
    await bodyField.fill("The owner's text")
    // Someone else changes the same field; the dialog's background refresh then shows the new version.
    await api("PATCH", `/items/${created.id}`, { version: created.version, body: "Changed meanwhile" })
    const refreshed = tab.waitForResponse((r) => r.url().endsWith(`/api/v1/items/${created.id}`) && r.ok())
    await tab.clock.fastForward(REFRESH)
    await refreshed

    await dialog.getByRole("button", { name: he.item.saveChanges }).click()
    await expect(dialog.getByRole("status").filter({ hasText: he.item.conflictTitle })).toBeVisible()
    await expect(bodyField).toHaveValue("The owner's text")
    const stored = await api<{ item: { body: string } }>("GET", `/items/${created.id}`)
    expect(stored.item.body).toBe("Changed meanwhile")

    await dialog.getByRole("button", { name: he.item.conflictReload }).click()
    await expect(bodyField).toHaveValue("Changed meanwhile")
  } finally {
    await tab.context().close()
  }
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

const accountMenu = () => page.getByRole("button", { name: new RegExp(`${he.shell.accountMenu}$`) })

test("signing out asks about unsaved changes, and a failed sign-out keeps them (R3)", async () => {
  await page.goto("/settings/telegram")
  const chatId = page.locator("#telegram").getByLabel(he.telegramSettings.chatId, { exact: true })
  await chatId.fill("4242")
  await expect(page.locator(".ui-savebar")).toBeVisible()
  const signOut = async () => {
    await accountMenu().click()
    await page.getByRole("menuitem", { name: he.account.signOut }).click()
  }
  const question = page.getByRole("alertdialog")

  // Stay: nothing is sent, the page and the draft stay.
  await signOut()
  await expect(question).toContainText(he.unsaved.leaveTitle)
  await question.getByRole("button", { name: he.unsaved.stay }).click()
  await expect(question).toHaveCount(0)
  await expect(page).toHaveURL(/\/settings\/telegram$/)
  await expect(chatId).toHaveValue("4242")

  // Leave, but the sign-out fails: it says so, and the draft and its guard stay.
  await page.route("**/api/auth/sign-out", (route) => route.abort("connectionrefused"))
  await signOut()
  await question.getByRole("button", { name: he.unsaved.leave }).click()
  await expect(page.locator(".ui-toast")).toContainText(he.account.signOutFailed.split(":")[0] ?? "")
  await expect(page).toHaveURL(/\/settings\/telegram$/)
  await expect(chatId).toHaveValue("4242")
  await expect(page.locator(".ui-savebar")).toBeVisible()
  expect(await page.evaluate(async () => (await fetch("/api/v1/session")).status)).toBe(200)
  await page.unroute("**/api/auth/sign-out")
})

test("signing out ends this browser's session; a copy of its cookies is refused", async ({ browser }, testInfo) => {
  const other = await browser.newContext({ ...testInfo.project.use, storageState: await page.context().storageState() })
  try {
    // Still on Settings with the draft of the test before: Leave, and this time the sign-out works.
    await expect(page).toHaveURL(/\/settings\/telegram$/)
    // Only this browser: the other project keeps its stored session.
    await accountMenu().click()
    await page.getByRole("menuitem", { name: he.account.signOut }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: he.unsaved.leave }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    // A copy of the old cookies is refused as well, and the board sends it to sign-in.
    const tab = await other.newPage()
    await tab.goto("/inbox")
    await expect(tab).toHaveURL(/\/login\?next=%2Finbox$/)
  } finally {
    await other.close()
  }
})
