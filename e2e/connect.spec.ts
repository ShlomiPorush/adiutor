// Agent access by approval against the real server (the image mounts it): the owner turns agents on in Settings,
// Agent access (a new installation starts with them off); the agent skill, installed from /agents/skill/ as its
// install note says, connects with a code the owner approves on the code and approval pages, reads, writes as its
// agent and ends when the owner disconnects it there; the sync bundle connects for the sync area alone, and the sync
// card says the sync is disconnected until it does and again once the owner disconnects it. Runs after auth.spec.ts
// and reuses the browser stored there. Every folder the clients use is new per run.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, expect, type Page, test } from "@playwright/test"
import he from "../src/shared/locales/he.json" with { type: "json" }
import { BASE_URL } from "./address.ts"
import { storageFile } from "./helpers.ts"

test.describe.configure({ mode: "serial" })

const BUNDLE = "dist/sync/adiutor-sync.js"
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

const isPhone = () => (page.viewportSize()?.width ?? 1440) <= 760

/** The owner types the code the agent showed, checks it, and approves the areas offered, all ticked. */
async function approve(code: string): Promise<void> {
  await page.goto("/connect/code")
  await page.locator('input[name="user_code"]').fill(code)
  await page.locator("button.primary").click()
  await page.locator("button.primary").click()
  await expect(page.locator(".ui-consent-name")).toBeVisible()
  await page.locator(".ui-consent-actions").getByRole("button", { name: he.consent.approve, exact: true }).click()
  await page.waitForURL(/\/connect\/code\//)
}

/** The row of one connection on Settings, Agent access. */
const connectionRow = (name: string | RegExp) =>
  page.locator("#settings-agent-connections [data-testid=agent-connection]", { hasText: name })

/** Disconnects one connection on Settings, Agent access, after its question. */
async function disconnect(name: string | RegExp): Promise<void> {
  await page.goto("/settings/agents")
  const row = connectionRow(name)
  await expect(row).toHaveCount(1)
  await row.getByRole("button", { name: he.agentAccess.disconnect, exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: he.agentAccess.disconnect, exact: true }).click()
  await expect(connectionRow(name)).toHaveCount(0)
}

test("the owner turns agents on in Settings, Agent access", async () => {
  await page.goto("/settings/agents")
  const toggle = page.locator('#settings-agents input[role="switch"]')
  await expect(toggle).toBeAttached()
  if (!(await toggle.isChecked())) {
    await page.locator("#settings-agents label.ui-set-bool-main").click()
    await page.getByRole("button", { name: he.savebar.save, exact: true }).click()
    await expect(page.getByRole("region", { name: he.savebar.region })).toHaveCount(0)
  }
  await expect(toggle).toBeChecked()
  await expect(page.locator("#settings-connect")).toContainText(`${BASE_URL}/mcp`)
})

type Answer = { code: number; json: Record<string, unknown> & { data?: Record<string, unknown> }; text: string }

test("the skill from /agents/skill/ connects with the owner's approval, reads, writes as its agent, and ends", async () => {
  test.setTimeout(120_000)
  const home = join(dir, `skill-${test.info().project.name}`)
  const scripts = join(home, "skills", "adiutor", "scripts")
  mkdirSync(scripts, { recursive: true })
  // As the install note says: each file from Adiutor, with this Adiutor's address filled in.
  const note = await fetch(`${BASE_URL}/agents/skill/`)
  expect(note.status).toBe(200)
  expect(await note.text()).toContain(`${BASE_URL}/agents/skill/scripts/adiutor.mjs -> adiutor/scripts/adiutor.mjs`)
  const script = await fetch(`${BASE_URL}/agents/skill/scripts/adiutor.mjs`)
  expect(script.status).toBe(200)
  writeFileSync(join(scripts, "adiutor.mjs"), await script.text())

  const adiutor = (args: string[]) =>
    new Promise<Answer>((resolve) => {
      execFile(
        process.execPath,
        [join(scripts, "adiutor.mjs"), ...args],
        {
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            ADIUTOR_CREDENTIALS: join(home, "credentials"),
            ADIUTOR_TEST_POLL_SECONDS: "1",
          },
          timeout: 90_000,
        },
        (error, stdout, stderr) => {
          let json: Answer["json"] = {}
          try {
            json = JSON.parse(stdout.trim().split("\n").at(-1) ?? "")
          } catch {}
          resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, json, text: stdout + stderr })
        },
      )
    })

  // A served copy knows its address: no --url.
  const asked = await adiutor(["connect"])
  expect(asked.json.status, asked.text).toBe("pending")
  expect(String(asked.json.link)).toBe(`${BASE_URL}/connect/code?user_code=${asked.json.code}`)
  await approve(String(asked.json.code))
  const connected = await adiutor(["connect", "--wait"])
  expect(connected.json.status, connected.text).toBe("connected")
  expect(connected.json.scope).toBe("read write")

  const access = await adiutor(["access"])
  expect(access.json.status, access.text).toBe(200)
  expect(((access.json.data?.areas ?? []) as { area: string }[]).map((a) => a.area)).toEqual(["read", "write"])
  expect((await adiutor(["get", "/api/v1/items?limit=1"])).json.status).toBe(200)
  const title = `An idea from the skill ${randomUUID().slice(0, 8)}`
  const agent = `e2e-skill-${test.info().project.name}`
  const captured = await adiutor(["post", "/api/v1/capture", "--json", JSON.stringify({ text: title }), "--as", agent])
  expect(captured.json.status, captured.text).toBe(201)
  // An agent never reads the activity log.
  expect((await adiutor(["get", "/api/v1/audit"])).json.error).toBe("bad_path")

  await page.goto(`/activity?actorKind=agent`)
  await expect(page.getByText(`agent:${agent}`).first()).toBeVisible()

  // The owner disconnects it on Settings, Agent access: its next call is refused, and nothing was resent.
  await disconnect(/^Agents on /)
  const after = await adiutor(["get", "/api/v1/items?limit=1"])
  expect(after.json.error, after.text).toBe("connection_ended")
})

type Cli = { child: ChildProcessWithoutNullStreams; output: () => string; exit: Promise<number | null> }

test("the sync connects for the sync area alone, and the sync card says when it is disconnected", async () => {
  test.setTimeout(120_000)
  const name = `e2e-sync-${test.info().project.name}`
  const home = join(dir, `sync-${test.info().project.name}`)
  mkdirSync(home, { recursive: true })
  const card = page.locator(".ui-status-card")
  if (!isPhone()) {
    await page.goto("/")
    await expect(card).toContainText(he.shell.syncDisconnected)
    await expect(card).toHaveAttribute("href", "/settings/agents")
  }

  let text = ""
  const child = spawn(
    process.execPath,
    [BUNDLE, "connect", "--name", name, "--url", BASE_URL, "--env", join(home, "sync.env"), "--no-open"],
    { env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config") } },
  )
  const cli: Cli = {
    child,
    output: () => text,
    exit: new Promise((resolve) => child.on("close", (code) => resolve(code))),
  }
  child.stdout.on("data", (d) => {
    text += d
  })
  child.stderr.on("data", (d) => {
    text += d
  })
  await expect.poll(() => /shows the code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(cli.output())?.[1] ?? "").not.toBe("")
  const code = /shows the code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(cli.output())?.[1] ?? ""
  await approve(code)
  expect(await cli.exit, cli.output()).toBe(0)
  expect(cli.output()).not.toMatch(/adt_|access_token|refresh_token/)

  await page.goto("/settings/agents")
  const row = connectionRow(name)
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(he.consent.areas.sync.name)
  await expect(row).not.toContainText(he.consent.areas.write.name)
  if (!isPhone()) {
    await page.goto("/")
    await expect(card).not.toContainText(he.shell.syncDisconnected)
  }

  await disconnect(name)
  if (!isPhone()) {
    await page.goto("/")
    await expect(card).toContainText(he.shell.syncDisconnected)
  }
})
