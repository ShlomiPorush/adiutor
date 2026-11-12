// The agent skill's command against the real server: `skill/mikud/scripts/mikud.mjs connect` asks for a code,
// Playwright approves it on /connect/device, `connect --wait` turns the approval into one agent key and ends its
// session, and the command then starts a thread's item, comments on it and writes a note, which the activity log
// shows under the agent's label. Runs after auth.spec.ts and reuses the browser stored there. The command polls every
// 5 seconds, so this test takes longer.
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, expect, type Page, test } from "@playwright/test"
import he from "../src/shared/locales/he.json" with { type: "json" }
import { storageFile } from "./helpers.ts"

test.describe.configure({ mode: "serial" })

const COMMAND = "skill/mikud/scripts/mikud.mjs"
const ORIGIN = "http://127.0.0.1:8090"
let page: Page
let dir = ""

test.beforeAll(async ({ browser }: { browser: Browser }, testInfo) => {
  dir = mkdtempSync(join(tmpdir(), "mikud-e2e-skill-"))
  page = await (
    await browser.newContext({ ...testInfo.project.use, storageState: storageFile(testInfo.project.name) })
  ).newPage()
})

test.afterAll(async () => {
  await page.context().close()
  rmSync(dir, { recursive: true, force: true })
})

type Answer = { code: number; json: Record<string, unknown>; text: string }

/** Runs the command with its own folder; resolves with its exit code and its one line of JSON. */
function mikud(args: string[]): Promise<Answer> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [COMMAND, ...args],
      { env: { PATH: process.env.PATH ?? "", HOME: dir, MIKUD_SKILL_HOME: join(dir, "home") }, timeout: 120_000 },
      (error, stdout, stderr) => {
        const text = `${stdout}${stderr}`
        let json: Record<string, unknown> = {}
        try {
          json = JSON.parse(stdout.trim().split("\n").at(-1) ?? "")
        } catch {}
        resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, json, text })
      },
    )
  })
}

const data = (answer: Answer) => answer.json.data as Record<string, unknown>

test("the skill's command connects through the approval page, then writes as its agent", async () => {
  test.setTimeout(120_000)
  const label = `e2e-skill-${test.info().project.name}`
  const asked = await mikud(["connect", "--url", ORIGIN, "--days", "1"])
  expect(asked.json.status, asked.text).toBe("pending")
  expect(asked.json.next).toBe(`mikud connect --wait --url ${ORIGIN}`)
  const link = String(asked.json.link)
  const code = new URL(link).searchParams.get("user_code") ?? ""
  expect(asked.json.code).toBe(`${code.slice(0, 4)}-${code.slice(4)}`)

  await page.goto(link)
  await expect(page.getByTestId("connect-code")).toHaveText(`${code.slice(0, 4)}-${code.slice(4)}`)
  await page.getByRole("button", { name: he.connect.allow, exact: true }).click()
  await expect(page.getByText(he.connect.allowed)).toBeVisible()

  const waited = await mikud(["connect", "--wait", "--url", ORIGIN])
  expect(waited.json.status, waited.text).toBe("connected")
  expect(waited.json.keyName).toMatch(/^skill:[A-Za-z0-9._-]{1,15}:[0-9a-f]{8}$/)
  expect(waited.json.left).toEqual([])
  expect(waited.json.warning).toBeUndefined()
  expect(waited.text).not.toMatch(/mkd_/)
  // The command ended its temporary session: no "mikud connect" session is left in Account.
  await page.goto("/account")
  await expect(page.locator("#account")).toContainText(he.account.thisBrowser)
  await expect(page.locator("#account")).not.toContainText(he.account.connectSession)

  const threadId = `e2e-${randomUUID()}`
  const started = await mikud([
    "post",
    "threads/start",
    "--as",
    label,
    "--json",
    JSON.stringify({ threadId, parentThreadId: null, title: `Skill check ${test.info().project.name}` }),
  ])
  expect(started.json.status, started.text).toBe(201)
  const item = data(started).item as { id: string; status: string }
  expect(item.status).toBe("in_progress")
  const comment = await mikud([
    "post",
    `items/${item.id}/comments`,
    "--as",
    label,
    "--json",
    JSON.stringify({ text: "Checked by the end-to-end test.", threadId }),
  ])
  expect(comment.json.status, comment.text).toBe(201)
  const note = await mikud([
    "post",
    "notes",
    "--as",
    label,
    "--json",
    JSON.stringify({ title: `Skill note ${test.info().project.name}`, body: "Written through the skill." }),
  ])
  expect(note.json.status, note.text).toBe(201)
  const read = await mikud(["get", `items/${item.id}`])
  expect(read.json.status, read.text).toBe(200)
  expect((data(read).comments as { authorLabel: string }[]).map((c) => c.authorLabel)).toEqual([`agent:${label}`])

  // The activity log names the agent on all three writes.
  const actions = await page.evaluate(async (agent) => {
    const r = await fetch(`/api/v1/audit?agent=${encodeURIComponent(agent)}`)
    const body = (await r.json()) as { data: { action: string; actorLabel: string }[] }
    return body.data.map((e) => `${e.actorLabel} ${e.action}`).sort()
  }, `agent:${label}`)
  expect(actions).toEqual(
    expect.arrayContaining([`agent:${label} comment.create`, `agent:${label} note.create`]),
  )
  expect(actions.some((a) => a.startsWith(`agent:${label} item.`))).toBe(true)

  // Forget the connection here, then disconnect its key in Settings, Agent access.
  const forgot = await mikud(["disconnect"])
  expect(forgot.json.status, forgot.text).toBe("disconnected")
  await page.goto("/settings/agents")
  const row = page.locator("#agents .ui-item", { hasText: String(waited.json.keyName) })
  await row.getByRole("button", { name: he.agentKeys.disconnect, exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: he.agentKeys.disconnect, exact: true }).click()
  await expect(row).toHaveCount(0)
})
