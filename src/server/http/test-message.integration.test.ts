import { asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp } from "../app.ts"
import { audit, jobRuns } from "../db/schema.ts"
import { sendTestMorningMessage } from "../jobs/morning.ts"
import { updateSettings } from "../services/admin.ts"
import type { Ctx } from "../services/context.ts"
import { BotApi } from "../telegram/api.ts"
import type { TelegramRuntime } from "../telegram/status.ts"
import { createAgentKey, ownerBrowser, type TestCore, testCore } from "../testing/app.ts"
import { StandInBotApi } from "../testing/bot-api.ts"
import { createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import { testBotToken } from "../testing/secrets.ts"
import { RateLimiter } from "./auth.ts"

const ORIGIN = "http://127.0.0.1:8090"
// New on every run (src/server/testing/secrets.ts).
const BOT_TOKEN = testBotToken()
const CHAT = "4242"

let t: TestDatabase
let standIn: StandInBotApi

let core: TestCore

function build(telegram?: TelegramRuntime) {
  core = testCore(t, {
    config: { publicUrl: new URL(ORIGIN), version: "test" },
    limiter: new RateLimiter(10, 60_000),
    clientIp: () => "client",
    telegram,
  })
  return createApp({ checkDatabase: async () => true, core })
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

/** As the owner's signed-in browser, or as an agent with a key. */
async function post(app: ReturnType<typeof createApp>, as: "owner" | "agent") {
  if (as === "owner") {
    const b = await ownerBrowser(t, app)
    const res = await b.call("POST", "/api/v1/telegram/test-message")
    return { status: res.status, json: res.json as { error: { code: string; message: string } } }
  }
  await ownerBrowser(t, app)
  const key = await createAgentKey(core)
  const res = await app.request("/api/v1/telegram/test-message", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
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
    expect((await post(app, "agent")).status).toBe(403)
    expect(standIn.sent).toEqual([])

    const res = await post(app, "owner")
    expect(res).toEqual({ status: 200, json: { data: { sent: true } } })
    expect(standIn.sent).toHaveLength(1)
    expect(standIn.sent[0]).toMatchObject({ chatId: CHAT, parseMode: "HTML" })
    expect(standIn.sent[0]?.text).toContain(`<a href="${ORIGIN}/">Open the board</a>`)
    expect(await t.ctx.db.select().from(jobRuns)).toEqual([])
    expect(await testAudits()).toMatchObject([
      { actorKind: "owner", source: "ui", entityType: "settings", after: { state: "sending" } },
      { actorKind: "owner", source: "ui", entityType: "settings", after: { state: "sent" } },
    ])
  })

  it("answers conflict when Telegram is not configured", async () => {
    const res = await post(build(), "owner")
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe("conflict")
    expect(res.json.error.message).toContain("MIKUD_TELEGRAM_BOT_TOKEN")
    expect(standIn.sent).toEqual([])
  })

  it("reports a send Telegram refused, with the failure in the audit row", async () => {
    standIn.sendFailures.push(400)
    const res = await post(build(configured()), "owner")
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
      const res = await post(build(configured()), "owner")
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
