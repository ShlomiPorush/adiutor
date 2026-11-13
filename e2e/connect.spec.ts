// Agent approval against the real server: `adiutor connect` (the sync bundle, dist/sync/adiutor-sync.js) runs as a child
// process, Playwright approves or denies it on /connect/device, and the key it saved works until Settings, Agent
// access disconnects it. Also the approval page signed out (to sign-in and back) and in English. Runs after
// auth.spec.ts and reuses the browser stored there. The CLI polls every 5 seconds, so these tests take longer.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, expect, type Page, test } from "@playwright/test"
import en from "../src/shared/locales/en.json" with { type: "json" }
import he from "../src/shared/locales/he.json" with { type: "json" }
import { storageFile } from "./helpers.ts"

test.describe.configure({ mode: "serial" })

const BUNDLE = "dist/sync/adiutor-sync.js"
const ORIGIN = "http://127.0.0.1:8090"
let page: Page
let dir = ""

test.beforeAll(async ({ browser }: { browser: Browser }, testInfo) => {
  dir = mkdtempSync(join(tmpdir(), "adiutor-e2e-connect-"))
  page = await (
    await browser.newContext({ ...testInfo.project.use, storageState: storageFile(testInfo.project.name) })
  ).newPage()
})

test.afterAll(async () => {
  await page.context().close()
  rmSync(dir, { recursive: true, force: true })
})

type Cli = { child: ChildProcessWithoutNullStreams; output: () => string; exit: Promise<number | null> }

/** Starts `connect` with its own env file; the output is kept to read the link and the code. */
function startConnect(args: string[]): Cli {
  let text = ""
  const child = spawn(process.execPath, [BUNDLE, "connect", "--url", ORIGIN, "--no-open", ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dir },
  })
  child.stdout.on("data", (chunk) => {
    text += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    text += String(chunk)
  })
  const exit = new Promise<number | null>((resolve) => child.on("close", resolve))
  return { child, output: () => text, exit }
}

/** The approval link the CLI printed. */
async function linkOf(cli: Cli): Promise<string> {
  await expect
    .poll(() => /Approve this agent in Adiutor: (\S+)/.exec(cli.output())?.[1] ?? "", { timeout: 15_000 })
    .not.toBe("")
  return /Approve this agent in Adiutor: (\S+)/.exec(cli.output())?.[1] as string
}

const asAgent = (key: string) =>
  page.evaluate(
    async (bearer) => (await fetch("/api/v1/projects", { headers: { authorization: `Bearer ${bearer}` } })).status,
    key,
  )

test("connect for the sync: approved in the browser, the key saved for the owner only, then disconnected", async () => {
  test.setTimeout(90_000)
  const name = `e2e-sync-${test.info().project.name}`
  const envFile = join(dir, "sync.env")
  const cli = startConnect(["--name", name, "--for", "sync", "--days", "1", "--env", envFile])
  const link = await linkOf(cli)
  const code = new URL(link).searchParams.get("user_code") ?? ""
  expect(cli.output()).toContain(`${code.slice(0, 4)}-${code.slice(4)}`)

  await page.goto(link)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(he.connect.title)
  await expect(page.getByTestId("connect-code")).toHaveText(`${code.slice(0, 4)}-${code.slice(4)}`)
  await expect(page.getByText(he.connect.warnTitle)).toBeVisible()
  // Nothing takes the focus: Enter cannot allow by accident.
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY")
  await page.getByRole("button", { name: he.connect.allow, exact: true }).click()
  await expect(page.getByText(he.connect.allowed)).toBeVisible()

  expect(await cli.exit).toBe(0)
  const saved = readFileSync(envFile, "utf8")
  expect(saved).toContain(`ADIUTOR_URL=${ORIGIN}\n`)
  const key = /^ADIUTOR_AGENT_TOKEN=(adt_\S+)$/m.exec(saved)?.[1] ?? ""
  expect(key).toMatch(/^adt_[A-Za-z]{64}$/)
  expect(statSync(envFile).mode & 0o777).toBe(0o600)
  expect(cli.output()).not.toContain(key)
  expect(await asAgent(key)).toBe(200)

  await page.goto("/settings/agents")
  const panel = page.locator("#agents")
  const row = panel.locator(".ui-item", { hasText: name })
  await expect(row).toContainText(key.slice(0, 6))
  await expect(row).not.toContainText(key.slice(6))
  // The CLI ended its temporary session: no "adiutor connect" session is left in Account.
  await page.goto("/account")
  await expect(page.locator("#account")).toContainText(he.account.thisBrowser)
  await expect(page.locator("#account")).not.toContainText(he.account.connectSession)

  await page.goto("/settings/agents")
  await row.getByRole("button", { name: he.agentKeys.disconnect, exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: he.agentKeys.disconnect, exact: true }).click()
  await expect(panel.locator(".ui-item", { hasText: name })).toHaveCount(0)
  expect(await asAgent(key)).toBe(401)
})

test("connect for Claude Code, denied in the browser: nothing is created", async () => {
  test.setTimeout(60_000)
  const cli = startConnect(["--name", `e2e-denied-${test.info().project.name}`, "--for", "claude"])
  await page.goto(await linkOf(cli))
  await page.getByRole("button", { name: he.connect.deny, exact: true }).click()
  await expect(page.getByText(he.connect.denied)).toBeVisible()
  expect(await cli.exit).toBe(1)
  expect(cli.output()).toContain("denied")
  expect(cli.output()).not.toMatch(/adt_/)
})

test("the approval page in English, and a code typed by hand", async () => {
  await page.goto("/connect/device")
  await page.evaluate(() => localStorage.setItem("adiutor.language", "en"))
  await page.reload()
  try {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(en.connect.title)
    await page.getByLabel(en.connect.code, { exact: true }).fill("abc")
    await page.getByRole("button", { name: en.connect.continue }).click()
    await expect(page.getByText(en.connect.codeInvalid)).toBeVisible()
    // A code nobody asked for: the request is unavailable, and nothing was shared.
    await page.getByLabel(en.connect.code, { exact: true }).fill("ZZZZ-ZZZZ")
    await page.getByRole("button", { name: en.connect.continue }).click()
    await expect(page).toHaveURL(/user_code=ZZZZZZZZ/)
    await expect(page.getByText(en.connect.unavailable)).toBeVisible()
    await expect(page.getByText(en.connect.reason.unknown, { exact: false })).toBeVisible()
  } finally {
    await page.evaluate(() => localStorage.setItem("adiutor.language", "he"))
  }
})

test("signed out, the approval link goes to sign-in and keeps the code to come back to", async ({ browser }) => {
  const context = await browser.newContext({ ...test.info().project.use })
  try {
    const anonymous = await context.newPage()
    await anonymous.goto("/connect/device?user_code=ABCDEFGH")
    await expect(anonymous).toHaveURL(/\/login\?next=%2Fconnect%2Fdevice%3Fuser_code%3DABCDEFGH$/)
    await expect(anonymous.getByRole("heading", { level: 1 })).toHaveText(he.login.title)
  } finally {
    await context.close()
  }
})
