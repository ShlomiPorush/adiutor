// The shell against the real server (R10): the folded sidebar survives a reload, the width boundaries 1100,
// 1024 and 760, the theme with System, the account menu and the More sheet closing on Escape and Back (R4), and
// one h1 per page. It reuses the browser auth.spec.ts stored; nothing here signs out. Texts come from the Hebrew
// locale file (the default language).
import { type Browser, expect, type Page, test } from "@playwright/test"
import he from "../src/shared/locales/he.json" with { type: "json" }
import { storageFile } from "./helpers.ts"

test.describe.configure({ mode: "serial" })

let page: Page

test.beforeAll(async ({ browser }: { browser: Browser }, testInfo) => {
  page = await (
    await browser.newContext({ ...testInfo.project.use, storageState: storageFile(testInfo.project.name) })
  ).newPage()
})

test.afterAll(async () => {
  await page.context().close()
})

const isPhone = () => (page.viewportSize()?.width ?? 1440) <= 760
const accountButton = () => page.getByRole("button", { name: new RegExp(`${he.shell.accountMenu}$`) })
const sideWidth = async () => Math.round((await page.locator(".ui-sidenav").boundingBox())?.width ?? 0)

test("every page has one h1: the top bar's on wide screens, the page's own on a phone", async () => {
  for (const [path, title] of [
    ["/", he.morning.title],
    ["/projects", he.projects.title],
    ["/settings", he.settings.title],
  ] as const) {
    await page.goto(path)
    const heading = page.getByRole("heading", { level: 1 })
    await expect(heading).toHaveCount(1)
    await expect(heading).toHaveText(title)
    if (isPhone()) await expect(page.locator(".ui-content h1")).toHaveText(title)
    else await expect(page.locator(".ui-topbar h1")).toHaveText(title)
  }
})

test("the folded sidebar stays folded after a reload, and unfolds again", async () => {
  test.skip(isPhone(), "the sidebar exists from 761px")
  await page.goto("/")
  expect(await sideWidth()).toBe(240)
  await page.getByRole("button", { name: he.shell.collapseMenu }).click()
  await expect(page.locator("html")).toHaveAttribute("data-nav", "rail")
  await expect.poll(sideWidth).toBe(72)
  await expect(page.locator(".ui-sidenav .ui-nav-label").first()).toBeHidden()

  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-nav", "rail")
  expect(await sideWidth()).toBe(72)
  const expand = page.getByRole("button", { name: he.shell.expandMenu })
  await expect(expand).toHaveAttribute("aria-expanded", "false")

  await expand.click()
  await expect(page.locator("html")).not.toHaveAttribute("data-nav", "rail")
  await expect.poll(sideWidth).toBe(240)
  await page.reload()
  expect(await sideWidth()).toBe(240)
})

test("the width boundaries: sidebar above 1100px, rail down to 761px, phone shell at 760px", async () => {
  test.skip(isPhone(), "the desktop project resizes its own window")
  await page.goto("/")
  const visible = (selector: string) => page.locator(selector).first().isVisible()
  const at = async (width: number) => {
    await page.setViewportSize({ width, height: 900 })
    // The fold animates the column for 0.18s.
    await page.waitForTimeout(300)
  }

  await at(1101)
  expect(await sideWidth()).toBe(240)
  expect(await visible(".ui-sidenav .ui-nav-label")).toBe(true)
  expect(await visible(".ui-topbar-fold")).toBe(true)
  expect(await visible(".ui-status-card")).toBe(true)

  for (const width of [1100, 1024, 761]) {
    await at(width)
    expect(await sideWidth(), `${width}px`).toBe(72)
    expect(await visible(".ui-sidenav .ui-nav-label"), `${width}px`).toBe(false)
    expect(await visible(".ui-topbar-fold"), `${width}px`).toBe(false)
    expect(await visible(".ui-topbar"), `${width}px`).toBe(true)
    expect(await visible(".ui-tabbar"), `${width}px`).toBe(false)
  }

  await at(760)
  expect(await visible(".ui-sidenav")).toBe(false)
  expect(await visible(".ui-topbar")).toBe(false)
  expect(await visible(".ui-mtop")).toBe(true)
  expect(await visible(".ui-tabbar")).toBe(true)
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)

  await at(1440)
  expect(await sideWidth()).toBe(240)
})

test("the theme: Dark, Light and System, which follows the operating system", async () => {
  await page.goto("/")
  const html = page.locator("html")
  const pick = async (name: string) => {
    await accountButton().click()
    await page.getByRole("menuitemradio", { name, exact: true }).click()
    await expect(page.getByRole("menu")).toHaveCount(0)
  }
  await pick(he.theme.dark)
  await expect(html).toHaveClass(/\bdark\b/)
  await pick(he.theme.light)
  await expect(html).not.toHaveClass(/\bdark\b/)

  await page.emulateMedia({ colorScheme: "dark" })
  await pick(he.theme.system)
  await expect(html).toHaveClass(/\bdark\b/)
  await page.emulateMedia({ colorScheme: "light" })
  await expect(html).not.toHaveClass(/\bdark\b/)
  // The choice is this browser's: it holds after a reload.
  await page.reload()
  expect(await page.evaluate(() => localStorage.getItem("mikud.theme"))).toBe("system")

  // The theme button walks System, Light, Dark.
  const button = page.locator("[data-theme-button]:visible").first()
  if (isPhone()) await page.locator(".ui-tabbar button").last().click()
  await button.click()
  await expect(html).not.toHaveClass(/\bdark\b/)
  expect(await page.evaluate(() => localStorage.getItem("mikud.theme"))).toBe("light")
  await button.click()
  await expect(html).toHaveClass(/\bdark\b/)
  await button.click()
  expect(await page.evaluate(() => localStorage.getItem("mikud.theme"))).toBe("system")
  if (isPhone()) await page.keyboard.press("Escape")
})

test("the account menu closes on Escape and on Back, and stays on the page", async () => {
  await page.goto("/projects")
  const trigger = accountButton()
  await trigger.click()
  const menu = page.getByRole("menu", { name: he.shell.accountMenu })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole("menuitem", { name: he.account.signOut })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await trigger.click()
  await expect(menu).toBeVisible()
  await page.goBack()
  await expect(menu).toHaveCount(0)
  await expect(page).toHaveURL(/\/projects$/)
  // The menu gave its history entry back: the next Back leaves the page.
  await page.goBack()
  await expect(page).not.toHaveURL(/\/projects$/)
})

test("Account settings from the menu takes the menu's Back step: one Back returns, the next one leaves", async () => {
  await page.goto("/")
  await page.goto("/projects")
  await accountButton().click()
  await page.getByRole("menuitem", { name: he.shell.accountSettings }).click()
  await expect(page).toHaveURL(/\/settings\/account$/)
  await expect(page.getByRole("menu")).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(/\/projects$/)
  await page.goBack()
  await expect(page).toHaveURL(/127\.0\.0\.1:8090\/$/)
})

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

test("a critical security row in the bell opens its project in place of the bell's Back step", async () => {
  // Invented data: a project with one open critical security item, which the bell lists as a critical line.
  const name = `Beacon ${test.info().project.name}-${Date.now().toString(36)}`
  await page.goto("/")
  const project = await api<{ id: string }>("POST", "/projects", { name, stage: "production" })
  await api("POST", "/items", {
    type: "security",
    severity: "critical",
    title: `Rotate the key of ${name}`,
    projectId: project.id,
  })
  await page.goto("/projects")
  await page.locator(isPhone() ? ".ui-mtop .ui-bell" : ".ui-topbar .ui-bell").click()
  await page.locator(".ui-alert[data-tone=fail]", { hasText: name }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`))
  await expect(page.locator("[data-layer]")).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(/\/projects$/)
  await page.goBack()
  await expect(page).toHaveURL(/127\.0\.0\.1:8090\/$/)
})

test("More closes when the window grows past 760px: no layer, nothing inert, its Back step given back", async () => {
  test.skip(isPhone(), "the desktop project resizes its own window")
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    await page.goto("/")
    await page.goto("/projects")
    const sheet = page.getByRole("dialog", { name: he.nav.allPages })
    await page.locator(".ui-tabbar button").last().click()
    await expect(sheet).toBeVisible()
    await expect(page.locator(".ui-content")).toHaveJSProperty("inert", true)

    await page.setViewportSize({ width: 1000, height: 844 })
    await expect(sheet).toHaveCount(0)
    await expect(page.locator("[data-layer]")).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0)
    await expect
      .poll(() => page.evaluate(() => Boolean((history.state as { mikudLayer?: boolean } | null)?.mikudLayer)))
      .toBe(false)
    await expect(page).toHaveURL(/\/projects$/)
    // The sheet's entry is gone: one Back leaves Projects.
    await page.goBack()
    await expect(page).toHaveURL(/127\.0\.0\.1:8090\/$/)
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 })
  }
})

test("More on a phone: Escape and Back close it, a page chosen in it takes its Back step", async () => {
  test.skip(!isPhone(), "the More sheet is the phone's")
  await page.goto("/")
  await page.goto("/projects")
  const more = page.locator(".ui-tabbar button").last()
  const sheet = page.getByRole("dialog", { name: he.nav.allPages })
  await more.click()
  await expect(sheet).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(sheet).toHaveCount(0)
  await expect(more).toBeFocused()

  await more.click()
  await expect(sheet).toBeVisible()
  await page.goBack()
  await expect(sheet).toHaveCount(0)
  await expect(page).toHaveURL(/\/projects$/)

  await more.click()
  await sheet.getByRole("link", { name: he.nav.archive }).click()
  await expect(page).toHaveURL(/\/archive$/)
  await expect(sheet).toHaveCount(0)
  // Archive took the sheet's entry: one Back returns to Projects.
  await page.goBack()
  await expect(page).toHaveURL(/\/projects$/)
})

test("the sync card opens Settings, Status", async () => {
  test.skip(isPhone(), "the card is in the sidebar")
  await page.goto("/")
  const card = page.locator(".ui-status-card")
  await expect(card).toContainText(he.shell.syncCard)
  await card.click()
  await expect(page).toHaveURL(/\/settings\/status$/)
})
