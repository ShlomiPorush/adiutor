// Settings against the real server, in the browser auth.spec.ts stored: the sections and their addresses (a deep
// link, a reload, an unknown section, the browser title), the one draft across sections with Back and Forward and one
// Discard, a refused field in a hidden section, how agents connect (connect.spec.ts runs it), Changed and Reset to
// default, the password changed and changed back in its dialog without leaving the page, the dialog's own checks and
// its question before it drops what was typed, the browsers list, and Telegram off: its fields editable when no
// environment variable sets them, the test and the sign-in codes locked areas. Stores the browser again at the end: a
// password change replaces this browser's session.
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
  await expect(page).toHaveURL(/\/settings\/general$/)
})

test.afterAll(async () => {
  await page.context().storageState({ path: storageFile(test.info().project.name) })
  await page.context().close()
})

const isPhone = () => (page.viewportSize()?.width ?? 1440) <= 760
const sectionTitle = () => page.locator(".ui-set-title")
const browserTitle = (section: keyof typeof he.settings.sections) =>
  `${he.settings.title} · ${he.settings.sections[section].title} · ${he.app.name}`

/** Opens a section as the owner does: the sidebar from 1024px, the picker below (decided by width, not by what drew). */
async function openSection(section: keyof typeof he.settings.sections): Promise<void> {
  const nav = page.getByRole("navigation", { name: he.settings.categories })
  if ((page.viewportSize()?.width ?? 1440) >= 1024)
    await nav.getByRole("link", { name: he.settings.sections[section].title }).click()
  else await page.getByLabel(he.settings.category, { exact: true }).selectOption(section)
  await expect(page).toHaveURL(new RegExp(`/settings/${section}$`))
}

/** The settings area that scrolls: the fields column from 1024px wide and 601px tall, the whole page otherwise. */
async function scrolled(to?: number | "end"): Promise<number> {
  return page.evaluate(async (to) => {
    const content = document.querySelector(".ui-set-content") as HTMLElement
    const area =
      getComputedStyle(content).overflowY !== "visible"
        ? content
        : (document.querySelector(".ui-set-page") as HTMLElement)
    if (to !== undefined) area.scrollTop = to === "end" ? area.scrollHeight : to
    // The page records a position from its scroll event, which comes with the next frame.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return Math.round(area.scrollTop)
  }, to)
}

/** A short desktop screen, 700px tall, where a section scrolls; a phone keeps its own size. */
async function shortScreen(): Promise<void> {
  if (!isPhone()) await page.setViewportSize({ width: 1440, height: 700 })
}
async function fullScreen(): Promise<void> {
  if (!isPhone()) await page.setViewportSize({ width: 1440, height: 900 })
}

/** Goes to a page through the navigation: the sidebar from 761px, the tab bar or More on a phone. */
async function navigateTo(path: "/projects" | "/settings"): Promise<void> {
  if (!isPhone()) await page.locator(`.ui-sidenav a[href="${path}"]`).click()
  else if (path === "/projects") await page.locator(`.ui-tabbar a[href="${path}"]`).click()
  else {
    await page.locator(".ui-tabbar").getByRole("button", { name: he.nav.more }).click()
    await page.locator(`.ui-moresheet-panel a[href="${path}"]`).click()
  }
}

test("each section has its own address: a deep link, a reload and the browser title", async () => {
  await page.goto("/settings/telegram")
  await expect(sectionTitle()).toHaveText(he.settings.sections.telegram.title)
  await expect(page).toHaveTitle(browserTitle("telegram"))
  await page.reload()
  await expect(page).toHaveURL(/\/settings\/telegram$/)
  await expect(sectionTitle()).toHaveText(he.settings.sections.telegram.title)
  await expect(page).toHaveTitle(browserTitle("telegram"))
  if (!isPhone())
    await expect(page.locator(".ui-trail [aria-current=page]")).toHaveText(he.settings.sections.telegram.title)

  // An address that names no section opens the first one in its place: one Back leaves Settings.
  await page.goto("/projects")
  await page.goto("/settings/no-such-section")
  await expect(page).toHaveURL(/\/settings\/general$/)
  await expect(sectionTitle()).toHaveText(he.settings.sections.general.title)
  await expect(page).toHaveTitle(browserTitle("general"))
  await page.goBack()
  await expect(page).toHaveURL(/\/projects$/)
})

test("changes in two sections stay through Back and Forward, a dot marks each, and one Discard drops both", async () => {
  await page.goto("/settings/general")
  const closedDays = page.getByLabel(he.settings.closedDays, { exact: true })
  const before = await closedDays.inputValue()
  const changed = before === "9" ? "8" : "9"
  await closedDays.fill(changed)
  await openSection("telegram")
  const chatId = page.locator("#telegram").getByLabel(he.telegramSettings.chatId, { exact: true })
  const chatBefore = await chatId.inputValue()
  await chatId.fill("5151")
  const bar = page.getByRole("region", { name: he.savebar.region })
  await expect(bar.locator(".ui-savebar-count")).toContainText("2")
  if (isPhone()) {
    const options = page.getByLabel(he.settings.category, { exact: true }).locator("option")
    await expect(options.filter({ hasText: he.settings.sections.general.title })).toContainText(
      he.settings.unsavedOption.replace("{name}", "").trim(),
    )
  } else {
    await expect(page.locator(".ui-set-nav .ui-set-dot")).toHaveCount(2)
  }

  await page.goBack()
  await expect(page).toHaveURL(/\/settings\/general$/)
  await expect(closedDays).toHaveValue(changed)
  await page.goForward()
  await expect(page).toHaveURL(/\/settings\/telegram$/)
  await expect(chatId).toHaveValue("5151")
  await expect(page.getByRole("alertdialog")).toHaveCount(0)

  await bar.getByRole("button", { name: he.savebar.discard }).click()
  await expect(bar).toHaveCount(0)
  await expect(chatId).toHaveValue(chatBefore)
  await openSection("general")
  await expect(closedDays).toHaveValue(before)
})

test("Settings opened from the account menu: Back between sections keeps a change, Back out of Settings asks", async () => {
  await page.goto("/")
  await page.getByRole("button", { name: new RegExp(`${he.shell.accountMenu}$`) }).click()
  await page.getByRole("menuitem", { name: he.shell.accountSettings }).click()
  await expect(page).toHaveURL(/\/settings\/account$/)
  await openSection("general")
  const closedDays = page.getByLabel(he.settings.closedDays, { exact: true })
  const before = await closedDays.inputValue()
  await closedDays.fill(before === "9" ? "8" : "9")
  const bar = page.getByRole("region", { name: he.savebar.region })
  await expect(bar).toBeVisible()

  const question = page.getByRole("alertdialog")
  await page.goBack()
  await expect(page).toHaveURL(/\/settings\/account$/)
  await expect(question).toHaveCount(0)
  // The entry before is the morning view, where the menu was opened: leaving drops the change, so it asks.
  // The browser's Back from the page itself: page.goBack() waits for a navigation the question holds back.
  await page.evaluate(() => history.back())
  await expect(question).toContainText(he.unsaved.leaveTitle)
  await question.getByRole("button", { name: he.unsaved.stay }).click()
  await expect(question).toHaveCount(0)
  await expect(page).toHaveURL(/\/settings\/account$/)
  await expect(bar).toBeVisible()
  await bar.getByRole("button", { name: he.savebar.discard }).click()
  await expect(bar).toHaveCount(0)
})

test("a refused field in a hidden section opens that section, takes the focus and shows uncovered", async () => {
  await shortScreen()
  await page.goto("/settings/general")
  const idle = page.getByLabel(he.settings.session.idleDays, { exact: true })
  await idle.fill("500")
  await openSection("telegram")
  const bar = page.getByRole("region", { name: he.savebar.region })
  await bar.getByRole("button", { name: he.savebar.save }).click()
  await expect(page).toHaveURL(/\/settings\/general$/)
  await expect(idle).toBeFocused()
  await expect(idle).toHaveAttribute("aria-invalid", "true")
  // In view, inside its scroll area, and nothing on top of it (the picker, the bar, a toast): the field and the note
  // that says what to fix both end above the save bar and above the refusal's toast, which on a phone sits over the
  // bar. Polled: the page may still be settling (a smooth scroll from the section change, the toast arriving).
  await expect(idle).toBeInViewport()
  const place = () =>
    idle.evaluate((field) => {
      const box = field.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      const note = document.getElementById(field.getAttribute("aria-describedby") ?? "")
      const end = Math.max(box.bottom, note?.getBoundingClientRect().bottom ?? 0)
      // Clear of a layer: above it, or beside it (the toast sits in a corner on a wide screen).
      const clearOf = (selector: string) => {
        const layer = document.querySelector(selector)?.getBoundingClientRect()
        if (!layer || layer.height === 0) return true
        const beside = layer.right <= box.left || layer.left >= box.right
        return beside || end <= layer.top
      }
      return {
        onTop: hit === field || field.contains(hit),
        note: Boolean(note),
        aboveBar: clearOf(".ui-savebar"),
        aboveToast: clearOf(".ui-toast"),
      }
    })
  await expect.poll(place, { timeout: 2000 }).toEqual({ onTop: true, note: true, aboveBar: true, aboveToast: true })
  // By keyboard: on a phone the refusal's toast sits over the save bar, and a pointer over it holds it (FB-2).
  await bar.getByRole("button", { name: he.savebar.discard }).press("Enter")
  await expect(bar).toHaveCount(0)
  await fullScreen()
})

test("Settings reopens on the section last open during the visit; a direct link and an unknown section do not (NL-4)", async () => {
  await page.goto("/settings/telegram")
  await expect(sectionTitle()).toHaveText(he.settings.sections.telegram.title)
  await navigateTo("/projects")
  await expect(page).toHaveURL(/\/projects$/)
  await navigateTo("/settings")
  await expect(page).toHaveURL(/\/settings\/telegram$/)
  await expect(sectionTitle()).toHaveText(he.settings.sections.telegram.title)
  // One Back from there leaves Settings: the address was corrected, not stacked.
  await page.goBack()
  await expect(page).toHaveURL(/\/projects$/)
  await page.goForward()
  await expect(page).toHaveURL(/\/settings\/telegram$/)
  // An address that names no section still opens the first one.
  await page.goto("/settings/no-such-section")
  await expect(page).toHaveURL(/\/settings\/general$/)
})

test("Back and Forward bring each section back to where it was scrolled; a new section opens at its top (NL-3)", async () => {
  await shortScreen()
  await page.goto("/settings/account")
  await expect(page.locator("#account .ui-item").first()).toBeVisible()
  const account = await scrolled("end")
  expect(account).toBeGreaterThan(0)
  // Agent access, not Telegram: with Telegram off here, its section is too short to scroll on every screen.
  await openSection("agents")
  await expect(page.getByRole("heading", { name: he.agentKeys.howTitle })).toBeVisible()
  if (!isPhone()) expect(await scrolled()).toBe(0)
  const agents = await scrolled(120)
  expect(agents).toBeGreaterThan(0)

  await page.goBack()
  await expect(page).toHaveURL(/\/settings\/account$/)
  await expect.poll(() => scrolled()).toBe(account)
  await page.goForward()
  await expect(page).toHaveURL(/\/settings\/agents$/)
  await expect.poll(() => scrolled()).toBe(agents)
  await fullScreen()
})

test("Agent access has no manual key: it shows how to connect, with this address", async () => {
  await page.goto("/settings/agents")
  const panel = page.locator("#agents")
  await expect(panel.getByRole("heading", { name: he.agentKeys.howTitle })).toBeVisible()
  await expect(panel).toContainText(
    "node dist/sync/mikud-sync.js connect --url http://127.0.0.1:8090 --name sync --for sync",
  )
  await expect(panel).toContainText("--name claude --for claude")
  await expect(panel).toContainText("--name codex --for codex")
})

test("Changed marks a value that differs from its default, and Reset puts the default back in the draft", async () => {
  await page.goto("/settings/general")
  const row = page.locator(".ui-set-row", { has: page.getByLabel(he.settings.closedDays, { exact: true }) })
  const closedDays = row.getByLabel(he.settings.closedDays, { exact: true })
  const before = await closedDays.inputValue()
  // Its name holds the default inside direction isolates, so it is found by its place and checked by its text.
  const reset = row.locator(".ui-set-clear.is-reset")
  const changedTag = row.locator(".ui-set-pill.is-changed")
  await closedDays.fill(before === "9" ? "8" : "9")
  await expect(changedTag).toHaveText(he.settings.changed)
  await expect(reset).toBeVisible()
  await expect(reset).toContainText(he.settings.resetTo.split("(")[0]?.trim() ?? "")
  await expect(reset).toContainText("7")
  const bar = page.getByRole("region", { name: he.savebar.region })
  await expect(bar).toBeVisible()

  await reset.click()
  await expect(closedDays).toHaveValue("7")
  await expect(changedTag).toHaveCount(0)
  // Reset changed only the draft: back at the loaded value there is nothing left to save.
  if (before === "7") await expect(bar).toHaveCount(0)
  else {
    await bar.getByRole("button", { name: he.savebar.discard }).click()
    await expect(bar).toHaveCount(0)
  }
})

test("the password changes and changes back in its dialog without leaving the page", async () => {
  await page.goto("/settings/account")
  const panel = page.locator("#account")
  const browsers = panel.locator(".ui-item")
  // Sign out everywhere sits at the end of the browsers' head (S-12).
  await expect(panel.locator("#settings-browsers .ui-set-group-acts")).toContainText(he.account.endAll)
  const dialog = page.getByRole("dialog", { name: he.account.passwordTitle })
  const change = async (from: string, to: string) => {
    // The browsers list above loads after the page, and on a phone it is long. A click made before it drew may land
    // where the button was rather than where it is; that is the likely cause of an earlier failure here, not a
    // confirmed one, so the test waits for the list first.
    await expect(browsers.filter({ hasText: he.account.thisBrowser })).toBeVisible()
    await panel.locator("#settings-password").getByRole("button", { name: he.account.change }).click()
    await expect(dialog).toBeVisible()
    await dialog.getByLabel(he.account.currentPassword, { exact: true }).fill(from)
    await dialog.getByLabel(he.account.newPassword, { exact: true }).fill(to)
    await dialog.getByLabel(he.account.repeatNewPassword, { exact: true }).fill(to)
    const answer = page.waitForResponse(
      (response) => response.url().endsWith("/api/auth/change-password") && response.request().method() === "POST",
    )
    await dialog.getByRole("button", { name: he.account.change }).click()
    // Better Auth's own answer, not the toast that leaves after 4 seconds: then this browser holds its new session.
    expect((await answer).ok()).toBe(true)
    // A change closes the dialog without asking.
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    // Better Auth signed out the other browsers: the list, read again, holds this one only.
    await expect(browsers).toHaveCount(1)
  }
  await change(PASSWORD, `${PASSWORD} again`)
  await change(`${PASSWORD} again`, PASSWORD)
  await expect(page).toHaveURL(/\/settings\/account$/)
  expect(await page.evaluate(async () => (await fetch("/api/v1/session")).status)).toBe(200)
  await expect(browsers).toHaveCount(1)
  await expect(browsers).toContainText(he.account.thisBrowser)
})

test("the password dialog checks its fields first, and asks before it drops what was typed", async () => {
  await page.goto("/settings/account")
  const panel = page.locator("#account")
  await expect(panel.locator(".ui-item").filter({ hasText: he.account.thisBrowser })).toBeVisible()
  await panel.locator("#settings-password").getByRole("button", { name: he.account.change }).click()
  const dialog = page.getByRole("dialog", { name: he.account.passwordTitle })
  await dialog.getByLabel(he.account.currentPassword, { exact: true }).fill("Invented old password")
  await dialog.getByLabel(he.account.newPassword, { exact: true }).fill("Invented new password")
  const repeat = dialog.getByLabel(he.account.repeatNewPassword, { exact: true })
  await repeat.fill("Invented other password")
  const sent: string[] = []
  page.on("request", (request) => {
    if (request.url().endsWith("/api/auth/change-password")) sent.push(request.url())
  })
  await dialog.getByRole("button", { name: he.account.change }).click()
  await expect(dialog.getByRole("alert")).toHaveText(he.auth.error.mismatch)
  await expect(repeat).toBeFocused()
  await expect(repeat).toHaveAttribute("aria-invalid", "true")
  expect(sent).toEqual([])

  // Escape asks first; Keep editing keeps what was typed, Discard closes.
  await page.keyboard.press("Escape")
  const question = page.getByRole("alertdialog")
  await expect(question).toContainText(he.unsaved.discardTitle)
  await question.getByRole("button", { name: he.unsaved.keepEditing }).click()
  await expect(repeat).toHaveValue("Invented other password")
  await page.keyboard.press("Escape")
  await question.getByRole("button", { name: he.unsaved.discard }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/settings\/account$/)
})

test("with Telegram off its fields are editable, and the test and the sign-in codes are locked areas", async () => {
  await page.goto("/settings/telegram")
  const panel = page.locator("#telegram")
  await expect(panel.getByLabel(he.telegramSettings.chatId, { exact: true })).toBeEditable()
  await expect(panel.getByLabel(he.telegramSettings.botToken, { exact: true })).toBeEditable()
  await expect(panel).not.toContainText(he.settings.env.pill)
  // What needs a working bot says what is missing and where it is set, instead of disappearing (FB-1).
  const locked = panel.locator(".ui-locked")
  await expect(locked).toHaveCount(2)
  await expect(locked.nth(0)).toContainText(he.telegramSettings.testLocked)
  await expect(locked.nth(1)).toContainText(he.telegramSettings.otpLocked)
  await expect(locked.nth(1)).toContainText(he.telegramSettings.needsTelegram)
  await expect(panel.getByRole("switch")).toHaveCount(0)
  await locked.nth(1).getByRole("button", { name: he.telegramSettings.setUp }).click()
  await expect(panel.getByLabel(he.telegramSettings.botToken, { exact: true })).toBeFocused()
})
