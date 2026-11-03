// The shared picker and the Sort button against the real server, on the desktop and on a phone (MP-1, MP-3,
// MP-4, TB-28, R4): the Projects list sorts from its Sort button in step with its headers; the stage filter is
// one picker named by its value on a phone; an inbox item moves to a project from its row's picker, and Undo
// puts it back; the item dialog picks its project from a picker, and Escape or Back closes the picker before
// the dialog. It reuses the browser that signed in in auth.spec.ts. The data is invented and created here
// through the API.
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test"
import he from "../src/shared/locales/he.json" with { type: "json" }
import { fill, storageFile } from "./helpers.ts"

test.describe.configure({ mode: "serial" })

let page: Page
let run = ""
let aster = ""
let birch = ""

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

/** Picks an option in the open picker, through its search when the list has one (more than ten choices). */
async function pick(name: string): Promise<void> {
  const search = page.locator(".ui-picker-panel input[type=search]")
  if (await search.isVisible()) await search.fill(name)
  await page.getByRole("listbox").getByRole("option", { name, exact: true }).click()
  await expect(page.getByRole("listbox")).toHaveCount(0)
}

/** The project names in the order the list shows them, only those of this run. */
async function shownOrder(): Promise<string[]> {
  const names = await page.locator(".ui-tr[data-row-open] .ui-td-first b").allTextContents()
  return names.filter((name) => name.endsWith(run))
}

test.beforeAll(async ({ browser }: { browser: Browser }, testInfo) => {
  run = `${testInfo.project.name}-${Date.now().toString(36)}`
  aster = `Aster bed ${run}`
  birch = `Birch walk ${run}`
  page = await (
    await browser.newContext({ ...testInfo.project.use, storageState: storageFile(testInfo.project.name) })
  ).newPage()
  await page.goto("/projects")
  for (const name of [aster, birch]) await api("POST", "/projects", { name, stage: "poc" })
})

test("the Projects list sorts from its Sort button, in step with its headers (TB-28)", async () => {
  await page.goto("/projects")
  await expect(page.locator(".ui-tr", { hasText: birch })).toBeVisible()
  const sortButton = page.locator(".ui-list-summary .ui-sort-btn-icon")
  await expect(sortButton).toBeVisible()
  // The default order (most open items first) shows no dot.
  await expect(sortButton).not.toHaveAttribute("data-set", "")

  await sortButton.click()
  const menu = page.getByRole("dialog", { name: fill(he.sort.panel, { name: he.projects.sortName }) })
  await expect(menu).toBeVisible()
  await menu.getByRole("radio", { name: he.projects.colName, exact: true }).check()
  // A choice applies at once and the menu stays open.
  await expect(menu).toBeVisible()
  expect(await shownOrder()).toEqual([aster, birch])
  await menu.getByRole("radio", { name: he.sort.words.text.desc, exact: true }).check()
  expect(await shownOrder()).toEqual([birch, aster])
  // The headers show the same order, also where a phone hides them.
  await expect(page.locator('.ui-tr-head [data-sort-state="descending"]')).toContainText(he.projects.colName)
  await expect(sortButton).toHaveAttribute("data-set", "")

  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  await expect(sortButton).toBeFocused()

  if (!isPhone()) {
    // A header click turns the order around, and the Sort button names it.
    await page.locator(".ui-tr-head .ui-sort", { hasText: he.projects.colName }).click()
    expect(await shownOrder()).toEqual([aster, birch])
    await expect(sortButton).toHaveAttribute(
      "aria-label",
      fill(he.sort.button, { column: he.projects.colName, order: he.sort.words.text.asc }),
    )
  }
})

test("the stage filter is one picker named by its value on a phone, chips on a wide screen (MP-3)", async () => {
  await page.goto("/projects")
  const picker = page.locator(".ui-stage-picker button")
  const chips = page.locator(".ui-stage-chips")
  if (!isPhone()) {
    await expect(chips).toBeVisible()
    await expect(picker).toBeHidden()
    await chips.getByRole("button", { name: new RegExp(`^${he.stage.poc}`) }).click()
    await expect(page).toHaveURL(/\/projects\?stage=poc$/)
    return
  }
  await expect(chips).toBeHidden()
  await expect(picker).toContainText(`${he.projects.filterLegend}:`)
  await expect(picker).toContainText(he.projects.allStages)
  await picker.click()
  const list = page.getByRole("listbox", { name: he.projects.filterLegend })
  await expect(list).toBeVisible()
  await list.getByRole("option", { name: new RegExp(`^${he.stage.poc}`) }).click()
  await expect(page).toHaveURL(/\/projects\?stage=poc$/)
  await expect(picker).toContainText(he.stage.poc)
  await expect(page.locator(".ui-tr", { hasText: aster })).toBeVisible()

  await picker.click()
  await page.getByRole("option", { name: new RegExp(`^${he.projects.allStages}`) }).click()
  await expect(page).toHaveURL(/\/projects$/)
})

test("an inbox item moves to a project from its row's picker, and Undo puts it back (N-1)", async () => {
  const title = `Sort the seed packets ${run}`
  await api("POST", "/items", { type: "task", title })
  await page.goto("/inbox")
  const row = page.locator(".ui-inbox-row", { hasText: title })
  await expect(row).toBeVisible()

  await row.getByRole("button", { name: fill(he.inboxPage.projectFor, { title }) }).click()
  await expect(page.getByRole("listbox")).toBeVisible()
  await pick(birch)
  const toast = page.locator(".ui-toast")
  await expect(toast).toContainText(fill(he.toast.moved, { title, project: birch }))
  await expect(row).toHaveCount(0)

  await toast.getByRole("button", { name: fill(he.toast.undoMove, { title }) }).click()
  await expect(page.locator(".ui-inbox-row", { hasText: title })).toBeVisible()
})

test("the item dialog picks its project from a picker; Escape and Back close the picker first (I-1, R4)", async () => {
  const title = `Label the tool shelf ${run}`
  const created = await api<{ id: string }>("POST", "/items", { type: "task", title })
  await page.goto(`/inbox?item=${created.id}`)
  const dialog = page.getByRole("dialog")
  await expect(dialog.locator("#item-title")).toHaveValue(title)
  const field: Locator = dialog.locator("button.ui-select-btn")
  await expect(field).toContainText(he.inbox)

  // Escape closes the picker only; the dialog stays, and the focus is back on the field.
  await field.click()
  await expect(page.getByRole("listbox")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("listbox")).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(field).toBeFocused()

  // Back does the same, and the page keeps the item's address.
  await field.click()
  await expect(page.getByRole("listbox")).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("listbox")).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`[?&]item=${created.id}`))

  await field.click()
  await pick(aster)
  await expect(page.locator(".ui-toast")).toContainText(fill(he.toast.moved, { title, project: aster }))
  await expect(field).toContainText(aster)

  // The next Escape closes the dialog.
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page).not.toHaveURL(/[?&]item=/)
})
