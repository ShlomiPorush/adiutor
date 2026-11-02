// Better Auth's own client keeps a session alive (deferSessionRefresh on the server): bringing the tab back to the
// front makes it read the session and, when the answer says needsRefresh, send POST /get-session, which extends it.
// That POST has no body; it reaches Better Auth through the transport fix in src/server/app.ts (withoutEmptyBody). A
// tab that stays visible and idle, with only Mikud's own polling, never extends it. Time moves through the
// database: the session is made to look refreshed two hours ago (updateAge is one hour), as the integration tests
// do. Needs E2E_DATABASE_URL (scripts/verify.sh sets it); the client logic is the same on every device, so it runs
// on the desktop project only.
import { type Browser, expect, type Page, type Request, test } from "@playwright/test"
import postgres from "postgres"
import { storageFile } from "./helpers.ts"

test.describe.configure({ mode: "serial" })

const DATABASE_URL = process.env.E2E_DATABASE_URL
const HOUR = 3_600_000

let page: Page
let sql: postgres.Sql
let token = ""

test.beforeAll(async ({ browser }: { browser: Browser }, testInfo) => {
  test.skip(!DATABASE_URL, "E2E_DATABASE_URL is not set (scripts/verify.sh sets it)")
  test.skip(testInfo.project.name !== "desktop", "the client's refresh does not depend on the device")
  sql = postgres(DATABASE_URL ?? "", { max: 1, onnotice: () => {} })
  const context = await browser.newContext({
    ...testInfo.project.use,
    storageState: storageFile(testInfo.project.name),
  })
  page = await context.newPage()
  await page.goto("/")
  await expect(page).toHaveURL(/\/$/)
  const cookie = (await context.cookies()).find((c) => c.name.endsWith("better-auth.session_token"))
  token = decodeURIComponent(cookie?.value ?? "").split(".")[0] ?? ""
  expect(token).not.toBe("")
})

test.afterAll(async () => {
  await page?.context().close()
  await sql?.end()
})

/** This browser's session expiry, as Better Auth stores it. */
async function expiry(): Promise<number> {
  const [row] = await sql<{ expires_at: Date }[]>`select expires_at from auth_session where token = ${token}`
  if (!row) throw new Error("the session is gone")
  return row.expires_at.getTime()
}

/** The session looks as if it was last refreshed two hours ago: a read now answers needsRefresh. */
async function refreshedTwoHoursAgo(): Promise<number> {
  await sql`update auth_session set expires_at = expires_at - interval '2 hours', updated_at = updated_at - interval '2 hours'
    where token = ${token}`
  return expiry()
}

const isRefresh = (request: Request) =>
  request.method() === "POST" && new URL(request.url()).pathname === "/api/auth/get-session"

test("bringing the tab back to the front extends the session (the client's POST /get-session)", async () => {
  // Better Auth's client refetches on focus at most every 5 seconds.
  await page.waitForTimeout(6_000)
  const before = await refreshedTwoHoursAgo()
  const refresh = page.waitForRequest(isRefresh)
  await page.evaluate(() => {
    const show = (state: "hidden" | "visible") => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state })
      document.dispatchEvent(new Event("visibilitychange"))
    }
    show("hidden")
    show("visible")
  })
  const answer = await (await refresh).response()
  expect(answer?.status()).toBe(200)
  await expect.poll(expiry, { timeout: 10_000 }).toBeGreaterThan(before + HOUR)
})

test("a tab that stays visible and idle, with only Mikud's polling, does not extend it", async () => {
  test.setTimeout(90_000)
  const before = await refreshedTwoHoursAgo()
  const refreshes: string[] = []
  const polls: string[] = []
  page.on("request", (request) => {
    if (isRefresh(request)) refreshes.push(request.url())
    else if (request.method() === "GET" && new URL(request.url()).pathname.startsWith("/api/v1/"))
      polls.push(request.url())
  })
  // The morning view polls every 30 seconds.
  await page.waitForTimeout(35_000)
  expect(polls.length).toBeGreaterThan(0)
  expect(refreshes).toEqual([])
  expect(await expiry()).toBe(before)
})
