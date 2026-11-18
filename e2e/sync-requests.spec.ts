// Sync now against the real server, with the real sync bundle checking in as the tray would (`checkin --json`, its
// report on stdin): Settings, Sync and the sync card before any computer checked in (Sync now disabled with the reason,
// the line about the tray app), then a check-in, Sync now, Cancel, a claim, its result, a pause, a computer gone silent
// and a claim whose lease passed. Time moves through the database (E2E_DATABASE_URL, which scripts/verify.sh sets), as
// session.spec.ts does. The flow runs on the desktop; the phone checks the same states' layout. Runs after auth.spec.ts
// and reuses the browser stored there. Every folder the sync uses is new per run.
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, expect, type Page, test } from "@playwright/test"
import postgres from "postgres"
import he from "../src/shared/locales/he.json" with { type: "json" }
import { BASE_URL } from "./address.ts"
import { storageFile } from "./helpers.ts"

test.describe.configure({ mode: "serial" })

const BUNDLE = "dist/sync/adiutor-sync.js"
const DATABASE_URL = process.env.E2E_DATABASE_URL
let page: Page
let home = ""
let sql: postgres.Sql | undefined

test.beforeAll(async ({ browser }: { browser: Browser }, testInfo) => {
  home = mkdtempSync(join(tmpdir(), "adiutor-e2e-sync-requests-"))
  if (DATABASE_URL) sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} })
  page = await (
    await browser.newContext({ ...testInfo.project.use, storageState: storageFile(testInfo.project.name) })
  ).newPage()
})

test.afterAll(async () => {
  await page.context().close()
  await sql?.end()
  rmSync(home, { recursive: true, force: true })
})

const env = () => ({ PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config") })

/** Runs the bundle with stdin; its output and exit code. */
function sync(args: string[], stdin = ""): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], { env: env() })
    let output = ""
    child.stdout.on("data", (d) => {
      output += d
    })
    child.stderr.on("data", (d) => {
      output += d
    })
    child.on("close", (code) => resolve({ code, output }))
    child.stdin.end(stdin)
  })
}

const REPORT = {
  version: "0.3.0",
  paused: false,
  pausedUntil: null,
  nextRunAt: null,
  running: null,
  finished: [] as unknown[],
}

/** One check-in as the tray makes it; the claim Adiutor answered. */
async function checkIn(report: Record<string, unknown> = {}): Promise<string | null> {
  const { code, output } = await sync(
    ["checkin", "--url", BASE_URL, "--json"],
    JSON.stringify({ ...REPORT, ...report }),
  )
  expect(code, output).toBe(0)
  const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}")
  return result.claim?.requestId ?? null
}

const group = () => page.locator("#settings-sync-computer")
const syncNow = () => group().getByRole("button", { name: he.syncNow.button, exact: true })
const requestFact = () => group().locator(".ui-set-fact", { hasText: he.syncNow.request })
const card = () => page.locator(".ui-status-card")
const syncCard = () => page.locator(".ui-sync-card")

test("before any computer checked in, Sync now stays in place, disabled, and the tray app's source is named", async () => {
  test.skip(test.info().project.name !== "desktop", "the phone runs after the desktop checked in")
  await page.goto("/settings/status")
  await expect(syncNow()).toBeDisabled()
  await expect(syncNow()).toHaveAttribute("title", he.syncNow.noClient)
  await expect(group()).toContainText(he.syncNow.getTray)
  await expect(group().getByRole("link", { name: he.syncNow.releases })).toHaveAttribute(
    "href",
    "https://github.com/ShlomiPorush/adiutor/releases",
  )
  await page.goto("/")
  await expect(page.locator(".ui-sync-card").getByRole("button", { name: he.syncNow.button })).toBeDisabled()
})

test("a check-in, Sync now, Cancel, the claim and its result", async () => {
  test.skip(test.info().project.name !== "desktop", "the flow runs once; the phone checks its layout")
  test.setTimeout(120_000)
  // The sync connects for the sync area, approved by the owner on the code page.
  const connect = spawn(
    process.execPath,
    [BUNDLE, "connect", "--name", "e2e-sync-now", "--url", BASE_URL, "--env", join(home, "sync.env"), "--no-open"],
    { env: env() },
  )
  let text = ""
  connect.stdout.on("data", (d) => {
    text += d
  })
  const exit = new Promise((resolve) => connect.on("close", resolve))
  await expect.poll(() => /shows the code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text)?.[1] ?? "").not.toBe("")
  await page.goto("/connect/code")
  await page.locator('input[name="user_code"]').fill(/shows the code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text)?.[1] ?? "")
  await page.locator("button.primary").click()
  await page.locator("button.primary").click()
  await page.locator(".ui-consent-actions").getByRole("button", { name: he.consent.approve, exact: true }).click()
  await page.waitForURL(/\/connect\/code\//)
  expect(await exit, text).toBe(0)

  expect(await checkIn()).toBeNull()
  await page.goto("/settings/status")
  await expect(group()).toContainText("0.3.0")
  await expect(group()).toContainText(he.syncNow.notPaused)
  await expect(requestFact()).toContainText(he.syncNow.noRequest)

  // Sync now, then Cancel while it waits; Sync now again.
  await syncNow().click()
  await expect(page.locator(".ui-toast")).toContainText(he.syncNow.asked)
  await expect(requestFact()).toContainText(he.syncNow.state.waiting)
  await requestFact().getByRole("button", { name: he.syncNow.cancel, exact: true }).click()
  await expect(requestFact()).toContainText(he.syncNow.state.cancelled)
  await syncNow().click()
  await expect(requestFact()).toContainText(he.syncNow.state.waiting)
  await page.goto("/")
  await expect(card()).toContainText(he.syncNow.state.waiting)
  // Cancel is on the card too, while the request waits; Sync now asks again from there.
  await syncCard().getByRole("button", { name: he.syncNow.cancel, exact: true }).click()
  await expect(card()).toContainText(he.syncNow.state.cancelled)
  await expect(syncCard().getByRole("button", { name: he.syncNow.cancel })).toHaveCount(0)
  await syncCard().getByRole("button", { name: he.syncNow.button, exact: true }).click()
  await expect(card()).toContainText(he.syncNow.state.waiting)

  // The computer takes it at its check-in, runs it and reports its result.
  const claim = await checkIn()
  expect(claim).not.toBeNull()
  await page.goto("/settings/status")
  await expect(requestFact()).toContainText(he.syncNow.state.claimed)
  await expect(requestFact().getByRole("button", { name: he.syncNow.cancel })).toHaveCount(0)
  expect(await checkIn({ running: { kind: "request", requestId: claim } })).toBe(claim)
  await checkIn({ finished: [{ requestId: claim, result: { t3: "accepted", security: "not_run" } }] })
  // The page reads again every 30 seconds by itself; a reload shows the result now.
  // Security is the server's own read now: a sync that reports it not_run is done when T3 was accepted, and only
  // T3's part shows.
  await page.reload()
  await expect(requestFact()).toContainText(he.syncNow.state.done)
  await expect(requestFact()).not.toContainText(he.syncNow.part.not_run)
  // The card keeps the finished request with its result.
  await page.goto("/")
  await expect(card()).toContainText(he.syncNow.state.done)
  await expect(card()).not.toContainText(he.syncNow.part.not_run)

  // Paused until a time: Sync now says the request waits for the pause, and promises no time.
  await checkIn({ paused: true, pausedUntil: new Date(Date.now() + 3_600_000).toISOString() })
  await page.goto("/settings/status")
  await expect(group()).toContainText(he.syncNow.pausedUntil)
  await syncNow().click()
  await expect(page.locator(".ui-toast")).toContainText(he.syncNow.askedPaused)
})

test("a computer gone silent, and a claim whose lease passed", async () => {
  test.skip(test.info().project.name !== "desktop", "the flow runs once; the phone checks its layout")
  test.skip(!sql, "E2E_DATABASE_URL is not set (scripts/verify.sh sets it)")
  const claimSql = sql as postgres.Sql
  await checkIn()
  await page.goto("/settings/status")
  await syncNow().click()
  const claim = await checkIn()
  expect(claim).not.toBeNull()
  // Five minutes without a check-in, and a lease that passed.
  await claimSql`update sync_client set last_checkin_at = last_checkin_at - interval '5 minutes'`
  await claimSql`update sync_requests set lease_until = now() - interval '1 minute' where id = ${claim ?? ""}`
  await page.reload()
  await expect(group()).toContainText(he.syncNow.silentSince)
  await expect(requestFact()).toContainText(he.syncNow.state.unknown)
  await page.goto("/")
  await expect(card()).toContainText(he.syncNow.silentSince)
  await expect(card()).toHaveAttribute("data-sync-tone", "warn")
  // Its late result still lands.
  await checkIn({ finished: [{ requestId: claim, result: { t3: "accepted", security: "accepted" } }] })
  await page.goto("/settings/status")
  await expect(requestFact()).toContainText(he.syncNow.state.done)
})

test("the owner disconnects the sync on Settings, Agent access", async () => {
  test.skip(test.info().project.name !== "desktop", "the desktop connected it")
  await page.goto("/settings/agents")
  const row = page.locator("#settings-agent-connections [data-testid=agent-connection]", { hasText: "e2e-sync-now" })
  await expect(row).toHaveCount(1)
  await row.getByRole("button", { name: he.agentAccess.disconnect, exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: he.agentAccess.disconnect, exact: true }).click()
  await expect(row).toHaveCount(0)
})

test("the phone shows the computer's state and Sync now in Settings, Sync", async () => {
  test.skip(test.info().project.name !== "phone", "the desktop runs the flow")
  await page.goto("/settings/status")
  await expect(group()).toBeVisible()
  await expect(syncNow()).toBeVisible()
  await expect(requestFact()).toBeVisible()
})
