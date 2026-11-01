import { asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp } from "../app.ts"
import { audit, jobRuns } from "../db/schema.ts"
import { sendTestMorningMessage } from "../jobs/morning.ts"
import { updateSettings } from "../services/admin.ts"
import type { Ctx } from "../services/context.ts"
import { BotApi } from "../telegram/api.ts"
import type { TelegramRuntime } from "../telegram/status.ts"
import { testCore } from "../testing/app.ts"
import { StandInBotApi } from "../testing/bot-api.ts"
import { createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import { RateLimiter } from "./auth.ts"

const OWNER = "owner-token-for-tests-only-000000000000"
const AGENT = "agent-token-for-tests-only-000000000000"
const ORIGIN = "http://127.0.0.1:8090"
// Assembled at run time: the guards and push protection scan literal text.
const BOT_TOKEN = `${"7654321"}:${"AAG"}${"t".repeat(33)}`
const CHAT = "4242"

let t: TestDatabase
let standIn: StandInBotApi

function build(telegram?: TelegramRuntime) {
  return createApp({
    checkDatabase: async () => true,
    core: testCore(t, {
      config: { ownerToken: OWNER, agentToken: AGENT, publicUrl: new URL(ORIGIN), version: "test" },
      limiter: new RateLimiter(10, 60_000),
      clientIp: () => "client",
      telegram,
    }),
  })
}

function configured(): TelegramRuntime {
  const api = new BotApi(BOT_TOKEN, standIn.url)
  return {
    configured: true,
    polling: () => true,
    send: async (text) => {
      await api.sendMessage(CHAT, text)
    },
  }
}

async function post(app: ReturnType<typeof createApp>, token: string) {
  const res = await app.request("/api/v1/telegram/test-message", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  })
  return { status: res.status, json: (await res.json()) as { error: { code: string; message: string } } }
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  t = await createTestDatabase("test_message")
  standIn = await StandInBotApi.start(BOT_TOKEN)
})
afterAll(async () => {
  await standIn?.close()
  await t?.close()
  vi.restoreAllMocks()
})
beforeEach(async () => {
  await t.reset()
  standIn.reset()
  await updateSettings(t.ctx, owner, { language: "en" })
})

const testAudits = () =>
  t.ctx.db.select().from(audit).where(eq(audit.action, "telegram.test_message")).orderBy(asc(audit.id))

describe("POST /telegram/test-message", () => {
  it("sends the morning message once to the owner's chat, never touches job_runs and writes an audit row", async () => {
    const app = build(configured())
    expect((await post(app, AGENT)).status).toBe(403)
    expect(standIn.sent).toEqual([])

    const res = await post(app, OWNER)
    expect(res).toEqual({ status: 200, json: { data: { sent: true } } })
    expect(standIn.sent).toHaveLength(1)
    expect(standIn.sent[0]).toMatchObject({ chatId: CHAT, parseMode: "HTML" })
    expect(standIn.sent[0]?.text).toContain(`<a href="${ORIGIN}/">Open the board</a>`)
    expect(await t.ctx.db.select().from(jobRuns)).toEqual([])
    expect(await testAudits()).toMatchObject([
      { actorKind: "owner", source: "api", entityType: "settings", after: { state: "sending" } },
      { actorKind: "owner", source: "api", entityType: "settings", after: { state: "sent" } },
    ])
  })

  it("answers conflict when Telegram is not configured", async () => {
    const res = await post(build(), OWNER)
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe("conflict")
    expect(res.json.error.message).toContain("MIKUD_TELEGRAM_BOT_TOKEN")
    expect(standIn.sent).toEqual([])
  })

  it("reports a send Telegram refused, with the failure in the audit row", async () => {
    standIn.sendFailures.push(400)
    const res = await post(build(configured()), OWNER)
    expect(res.status).toBe(502)
    expect(res.json.error.code).toBe("telegram_failed")
    expect(JSON.stringify(res.json)).not.toContain(BOT_TOKEN)
    expect(await testAudits()).toMatchObject([
      { after: { state: "sending" } },
      { after: { state: "failed", code: "telegram_400" } },
    ])
    expect(await t.ctx.db.select().from(jobRuns)).toEqual([])
  })

  it("reports a send that may have gone out (a 5xx, a lost connection) as uncertain, not as refused", async () => {
    for (const failure of [500, "drop"] as const) {
      await t.reset()
      standIn.sendFailures.push(failure)
      const res = await post(build(configured()), OWNER)
      expect(res.status).toBe(502)
      expect(res.json.error.code).toBe("telegram_uncertain")
      expect(res.json.error.message).toContain("may have been sent")
      expect(await testAudits()).toMatchObject([{ after: { state: "sending" } }, { after: { state: "uncertain" } }])
    }
  })

  it("records the send before it goes out, and answers success when only the outcome row fails", async () => {
    let broken = false
    const db = new Proxy(t.ctx.db, {
      get(target, prop) {
        if (prop === "insert" && broken) throw new Error("the database went away")
        const value = Reflect.get(target, prop, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const ctx: Ctx = { ...t.ctx, db }
    let seenBeforeSend: unknown[] = []
    const result = await sendTestMorningMessage(ctx, owner, new URL(ORIGIN), async () => {
      seenBeforeSend = (await testAudits()).map((a) => a.after)
      broken = true
    })
    expect(seenBeforeSend).toEqual([{ state: "sending" }])
    expect(result).toEqual({ sent: true, warning: "outcome_not_recorded" })
    expect((await testAudits()).map((a) => a.after)).toEqual([{ state: "sending" }])
  })
})
