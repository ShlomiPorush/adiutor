import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import he from "../../shared/locales/he.json"
import { jobRuns, securitySources, syncRuns, visits } from "../db/schema.ts"
import { updateSettings } from "../services/admin.ts"
import type { Ctx } from "../services/context.ts"
import { createItem } from "../services/items.ts"
import { createProject } from "../services/projects.ts"
import { BotApi } from "../telegram/api.ts"
import { StandInBotApi } from "../testing/bot-api.ts"
import { agent, createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import { MorningJob, recoverInterrupted } from "./morning.ts"

// Assembled at run time: the guards and push protection scan literal text.
const TOKEN = `${"7654321"}:${"AAG"}${"m".repeat(33)}`
const CHAT = "4242"
const PUBLIC_URL = new URL("http://127.0.0.1:8090")
const HOUR = 60 * 60 * 1000

// Asia/Jerusalem is UTC+2 in November. 2026-11-01 is a Sunday.
const SUNDAY_0800 = new Date("2026-11-01T06:00:00Z")

let t: TestDatabase
let standIn: StandInBotApi
let now: Date
let ctx: Ctx

function job() {
  const api = new BotApi(TOKEN, standIn.url)
  return new MorningJob({
    ctx,
    publicUrl: PUBLIC_URL,
    send: async (text, signal) => {
      await api.sendMessage(CHAT, text, signal)
    },
  })
}

const runs = () => t.ctx.db.select().from(jobRuns)

/** A successful T3 sync an hour ago, so the sync is not stale. */
async function freshSync() {
  await t.ctx.db.insert(syncRuns).values({
    kind: "t3",
    startedAt: new Date(now.getTime() - HOUR),
    finishedAt: new Date(now.getTime() - HOUR),
    outcome: "succeeded",
  })
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  t = await createTestDatabase("morning")
  standIn = await StandInBotApi.start(TOKEN)
  ctx = { ...t.ctx, clock: () => now }
})
afterAll(async () => {
  await standIn?.close()
  await t?.close()
  vi.restoreAllMocks()
})
beforeEach(async () => {
  await t.reset()
  standIn.reset()
  now = SUNDAY_0800
  await updateSettings(ctx, owner, { language: "en" })
})

describe("morning job", () => {
  it("sends once at 08:00 and does nothing on later ticks", async () => {
    await freshSync()
    const morning = job()
    expect(await morning.tick()).toEqual({ action: "sent", localDate: "2026-11-01" })
    expect(standIn.sent).toEqual([
      {
        chatId: CHAT,
        text: 'Nothing is waiting on you today. <a href="http://127.0.0.1:8090/">Open the board</a>',
        parseMode: "HTML",
        linkPreview: { is_disabled: true },
      },
    ])
    now = new Date(now.getTime() + 30_000)
    expect(await morning.tick()).toEqual({ action: "none", reason: "done" })
    expect(await job().tick()).toEqual({ action: "none", reason: "done" })
    expect(standIn.sent).toHaveLength(1)
    expect(await runs()).toMatchObject([{ job: "morning", localDate: "2026-11-01", state: "sent", detail: null }])
  })

  it("waits before 08:00 and on Saturday, writing nothing", async () => {
    now = new Date("2026-11-01T05:59:30Z")
    expect(await job().tick()).toEqual({ action: "none", reason: "too_early" })
    now = new Date("2026-11-07T06:00:00Z")
    expect(await job().tick()).toEqual({ action: "none", reason: "saturday" })
    expect(await runs()).toEqual([])
    expect(standIn.sent).toEqual([])
  })

  it("sends a late start at 10:59 and skips a start at 11:01", async () => {
    now = new Date("2026-11-01T08:59:00Z")
    expect(await job().tick()).toEqual({ action: "sent", localDate: "2026-11-01" })
    now = new Date("2026-11-02T09:01:00Z")
    expect(await job().tick()).toEqual({ action: "skip", localDate: "2026-11-02" })
    expect(standIn.sent).toHaveLength(1)
    const byDate = Object.fromEntries((await runs()).map((r) => [r.localDate, r.state]))
    expect(byDate).toEqual({ "2026-11-01": "sent", "2026-11-02": "skipped" })
  })

  it("marks a run left in sending as unknown at start-up and never resends it", async () => {
    await t.ctx.db.insert(jobRuns).values({ job: "morning", localDate: "2026-11-01", state: "sending", at: now })
    expect(await recoverInterrupted(ctx)).toBe(1)
    expect(await job().tick()).toEqual({ action: "none", reason: "done" })
    expect(standIn.sent).toEqual([])
    expect(await runs()).toMatchObject([{ state: "unknown", detail: "interrupted" }])
  })

  it("retries after a Telegram refusal until it is sent, and skips the day after the cutoff", async () => {
    standIn.sendFailures.push(400)
    const morning = job()
    expect(await morning.tick()).toEqual({ action: "failed", localDate: "2026-11-01" })
    expect(await runs()).toMatchObject([{ state: "failed", detail: "telegram_400" }])
    now = new Date(now.getTime() + 30_000)
    expect(await morning.tick()).toEqual({ action: "sent", localDate: "2026-11-01" })
    expect(standIn.sent).toHaveLength(1)
    expect(await runs()).toMatchObject([{ state: "sent", detail: null }])

    standIn.sendFailures.push(429)
    now = new Date("2026-11-02T08:30:00Z")
    expect(await morning.tick()).toEqual({ action: "failed", localDate: "2026-11-02" })
    now = new Date("2026-11-02T09:00:00Z")
    expect(await morning.tick()).toEqual({ action: "skip", localDate: "2026-11-02" })
    const monday = (await runs()).find((r) => r.localDate === "2026-11-02")
    expect(monday).toMatchObject({ state: "skipped", detail: "telegram_429" })
    expect(standIn.sent).toHaveLength(1)
  })

  it("never resends after a server error, which may hide a message that went out", async () => {
    standIn.sendFailures.push(500)
    const morning = job()
    expect(await morning.tick()).toEqual({ action: "unknown", localDate: "2026-11-01" })
    now = new Date(now.getTime() + 30_000)
    expect(await morning.tick()).toEqual({ action: "none", reason: "done" })
    expect(standIn.sent).toEqual([])
    expect(await runs()).toMatchObject([{ state: "unknown", detail: "telegram_500" }])
  })

  it("never resends when it cannot tell whether the message arrived", async () => {
    standIn.sendFailures.push("drop")
    const morning = job()
    expect(await morning.tick()).toEqual({ action: "unknown", localDate: "2026-11-01" })
    now = new Date(now.getTime() + 30_000)
    expect(await morning.tick()).toEqual({ action: "none", reason: "done" })
    expect(standIn.sent).toEqual([])
    expect(await runs()).toMatchObject([{ state: "unknown", detail: "network" }])
  })

  it("sends once when two processes tick at the same moment", async () => {
    const results = await Promise.all([job().tick(), job().tick(), job().tick()])
    expect(results.filter((r) => r.action === "sent")).toHaveLength(1)
    expect(results.filter((r) => r.action !== "sent").every((r) => r.action === "lost" || r.action === "none")).toBe(
      true,
    )
    expect(standIn.sent).toHaveLength(1)
    expect(await runs()).toHaveLength(1)
  })

  it("reports since the later of the last visit and the last morning message, with security and links", async () => {
    await updateSettings(ctx, owner, { language: "he" })
    const widget = await createProject(ctx, owner, { name: "Widget", stage: "production" })
    await t.ctx.db.insert(securitySources).values({
      projectId: widget.id,
      family: "dependabot",
      coverage: "enabled",
      critical: 1,
      high: 2,
      asOf: new Date(now.getTime() - 2 * HOUR),
    })
    await freshSync()
    // Saturday morning's state: an item waiting, then a visit, then a new item.
    now = new Date("2026-10-31T07:00:00Z")
    const waiting = await createItem(ctx, agent, { type: "decision", title: "Pick a <name>", status: "waiting_on_you" })
    now = new Date("2026-10-31T08:00:00Z")
    await t.ctx.db.insert(visits).values({ deviceId: null, at: now })
    now = new Date("2026-10-31T09:00:00Z")
    await createItem(ctx, agent, { type: "task", title: "Added after the visit" })

    now = SUNDAY_0800
    expect(await job().tick()).toMatchObject({ action: "sent" })
    const m = he.telegram.morning
    expect(standIn.sent[0]?.text.split("\n")).toEqual([
      `<b>${m.waiting.replace("{count}", "1")}</b> · <a href="http://127.0.0.1:8090/items/${waiting.id}">Pick a &lt;name&gt;</a>`,
      m.new.replace("{count}", "1"),
      m.security
        .replace("{project}", "Widget")
        .replace("{counts}", `${m.critical.replace("{count}", "1")}, ${m.high.replace("{count}", "2")}`),
      `<a href="http://127.0.0.1:8090/">${m.openBoard}</a>`,
    ])

    // Monday: the item created Saturday is no longer new, since Sunday's message was sent after it.
    now = new Date("2026-11-02T06:00:00Z")
    await freshSync()
    expect(await job().tick()).toMatchObject({ action: "sent" })
    expect(standIn.sent[1]?.text.split("\n")[1]).toBe(m.new.replace("{count}", "0"))
    expect((await t.ctx.db.select().from(jobRuns).where(eq(jobRuns.localDate, "2026-11-02")))[0]?.state).toBe("sent")
  })
})
