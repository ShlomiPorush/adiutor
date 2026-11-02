import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp } from "../app.ts"
import { audit, jobRuns, settings, syncRuns } from "../db/schema.ts"
import { getSettings } from "../services/admin.ts"
import type { Ctx } from "../services/context.ts"
import { createItem } from "../services/items.ts"
import { html } from "../telegram/html.ts"
import { TelegramService } from "../telegram/runtime.ts"
import { createAgentKey, ownerBrowser, type TestCore, type TestCoreOptions, testCore } from "../testing/app.ts"
import { StandInBotApi, waitFor } from "../testing/bot-api.ts"
import type { TestBrowser } from "../testing/browser.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import { BOT_TOKEN_COLUMN } from "./effective.ts"

// The owner's settings in the UI (Part B): stored in the database, the bot token encrypted, each field locked when
// the environment sets it, and a save taking effect without a restart.

// Assembled at run time: the guards and push protection scan literal text.
const TOKEN = `${"7654321"}:${"AAG"}${"s".repeat(33)}`
const OTHER_TOKEN = `${"7654322"}:${"AAG"}${"o".repeat(33)}`
const ORIGIN = "http://127.0.0.1:8090"

let t: TestDatabase
let standIn: StandInBotApi
let core: TestCore
let app: ReturnType<typeof createApp>
let owner: TestBrowser

async function build(options: Partial<TestCoreOptions> = {}) {
  core = testCore(t, { config: { publicUrl: new URL(ORIGIN), version: "test" }, telegramApiUrl: standIn.url, ...options })
  app = createApp({ checkDatabase: async () => true, core })
  owner = await ownerBrowser(t, app)
}

const patch = (body: Record<string, unknown>) => owner.call("PATCH", "/api/v1/settings", { body })
const read = async () => (await owner.call("GET", "/api/v1/settings")).json.data

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  t = await createTestDatabase("settings")
  standIn = await StandInBotApi.start(TOKEN)
})
afterAll(async () => {
  await standIn?.close()
  await t?.close()
  vi.restoreAllMocks()
})
beforeEach(async () => {
  await t.reset()
  standIn.reset()
})
afterEach(async () => {
  await core?.telegramService.stop()
})

describe("Telegram in Settings", () => {
  it("stores the token encrypted, never returns or audits it, and starts the bot without a restart", async () => {
    await build()
    expect((await read()).telegram).toEqual({
      botToken: { set: false, readable: true, locked: false, variable: null },
      chatId: { value: null, locked: false, variable: null },
      state: "off",
      missing: [],
    })
    const half = await patch({ telegramBotToken: TOKEN })
    expect(half.json.data.telegram).toMatchObject({ state: "incomplete", missing: ["chatId"] })
    expect(core.telegramService.configured).toBe(false)

    const saved = await patch({ telegramChatId: "4242" })
    expect(saved.json.data.telegram.state).toBe("on")
    expect(core.telegramService.configured).toBe(true)
    await waitFor(() => core.telegramService.polling())

    const [row] = await t.ctx.db.select().from(settings)
    expect(row?.telegramBotTokenEnc).toMatch(/^v1\./)
    expect(row?.telegramBotTokenEnc).not.toContain(TOKEN.split(":")[1])
    const everything = JSON.stringify([await read(), await t.ctx.db.select().from(audit)])
    expect(everything).not.toContain(TOKEN.split(":")[1])
    expect(everything).not.toContain(row?.telegramBotTokenEnc)
    const changes = (await t.ctx.db.select().from(audit).where(eq(audit.action, "settings.update"))).map(
      (r) => (r.after as { telegramBotTokenChange?: string }).telegramBotTokenChange,
    )
    expect(changes).toEqual(["replaced", undefined])

    // Removing the token stops the bot.
    const removed = await patch({ telegramBotToken: null })
    expect(removed.json.data.telegram).toMatchObject({ state: "incomplete", botToken: { set: false } })
    expect(core.telegramService.configured).toBe(false)
  })

  it("locks only the field the environment sets, merges it with the stored one, and names the variable", async () => {
    await build({ overrides: { telegramBotToken: TOKEN } })
    const locked = await patch({ telegramBotToken: OTHER_TOKEN })
    expect([locked.status, locked.json.error.code, locked.json.error.variable]).toEqual([
      409,
      "setting_locked",
      "MIKUD_TELEGRAM_BOT_TOKEN",
    ])
    expect((await read()).telegram).toMatchObject({
      botToken: { set: true, readable: true, locked: true, variable: "MIKUD_TELEGRAM_BOT_TOKEN" },
      state: "incomplete",
      missing: ["chatId"],
    })
    const saved = await patch({ telegramChatId: "4242" })
    expect(saved.json.data.telegram).toMatchObject({ state: "on", chatId: { value: "4242", locked: false } })
    expect(core.telegramService.configured).toBe(true)
  })

  it("says a stored token can no longer be read (its key was removed) and keeps the bot off", async () => {
    await build()
    await patch({ telegramBotToken: TOKEN, telegramChatId: "4242" })
    await core.telegramService.stop()
    await t.ctx.db.update(settings).set({ telegramBotTokenEnc: "v9.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA" })
    await build()
    await core.runtime.apply()
    expect((await read()).telegram).toMatchObject({ botToken: { set: true, readable: false }, state: "incomplete" })
    expect(core.telegramService.configured).toBe(false)
  })

  it("refuses sign-in codes to Telegram while Telegram is not set up", async () => {
    await build()
    const refused = await patch({ otpViaTelegram: true })
    expect([refused.status, refused.json.error.code]).toEqual([400, "validation_failed"])
    expect((await getSettings(t.ctx.db)).otpViaTelegram).toBe(false)
  })

  it("restarts the bot with a new chat, and lets the agent change nothing", async () => {
    await build()
    await patch({ telegramBotToken: TOKEN, telegramChatId: "4242" })
    await core.telegramService.send(html`first`)
    await patch({ telegramChatId: "4343" })
    await core.telegramService.send(html`second`)
    expect(standIn.sent.map((m) => [m.chatId, m.text])).toEqual([
      ["4242", "first"],
      ["4343", "second"],
    ])
    const key = await createAgentKey(core)
    const agent = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ telegramChatId: "1" }),
    })
    expect(agent.status).toBe(403)
  })
})

describe("the morning message across a reload", () => {
  it("is sent at most once a day when the bot restarts with a new chat", async () => {
    // Asia/Jerusalem is UTC+2 in November. 2026-11-01 is a Sunday.
    const now = new Date("2026-11-01T06:00:00Z")
    const ctx: Ctx = { ...t.ctx, clock: () => now }
    await t.ctx.db.insert(syncRuns).values({ kind: "t3", startedAt: now, finishedAt: now, outcome: "succeeded" })
    const service = new TelegramService({ ctx, publicUrl: new URL(ORIGIN), apiUrl: standIn.url })
    try {
      await service.reload({ botToken: TOKEN, chatId: "4242" })
      await waitFor(async () => (await t.ctx.db.select().from(jobRuns))[0]?.state === "sent")
      await service.reload({ botToken: TOKEN, chatId: "4343" })
      // The new job ticks at start: the day's run is already sent.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(standIn.sent.map((m) => m.chatId)).toEqual(["4242"])
      // A send that may have gone out (the connection dropped) is never resent after a reload either.
      await t.ctx.db.delete(jobRuns)
      standIn.sent.length = 0
      standIn.sendFailures.push("drop")
      await service.reload(null)
      await service.reload({ botToken: TOKEN, chatId: "4242" })
      await waitFor(async () => (await t.ctx.db.select().from(jobRuns))[0]?.state === "unknown")
      await service.reload({ botToken: TOKEN, chatId: "4545" })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(standIn.sent).toHaveLength(0)
      expect((await t.ctx.db.select().from(jobRuns))[0]?.state).toBe("unknown")
    } finally {
      await service.stop()
    }
  })
})

describe("the secret check's private domains", () => {
  it("apply after a save, without a restart; the environment's list is locked", async () => {
    await build()
    const key = await createAgentKey(core)
    const write = (title: string) =>
      app.request("/api/v1/items", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ type: "task", title }),
      })
    expect((await write("Check build.corp.example")).status).toBe(201)
    const saved = await patch({ privateDomains: [" Corp.Example. "] })
    expect(saved.json.data.privateDomains).toEqual({ value: ["corp.example"], locked: false, variable: null })
    const refused = await write("Check build.corp.example again")
    expect(refused.status).toBe(422)

    await build({ overrides: { privateDomains: ["lab.test"] } })
    await core.runtime.apply()
    expect((await read()).privateDomains).toEqual({ value: ["lab.test"], locked: true, variable: "MIKUD_PRIVATE_DOMAINS" })
    const locked = await patch({ privateDomains: [] })
    expect([locked.status, locked.json.error.variable]).toEqual([409, "MIKUD_PRIVATE_DOMAINS"])
    await expect(createItem(t.ctx, { actor: { kind: "agent", label: "agent" }, source: "api" }, {
      type: "task",
      title: "At ci.lab.test",
    })).rejects.toMatchObject({ code: "secret_suspected" })
  })
})

describe("the idle length in Settings", () => {
  it("rebuilds Better Auth with the new length after a save", async () => {
    await build()
    const before = core.auth.current
    const saved = await patch({ sessionIdleDays: 7 })
    expect(saved.json.data.sessionIdleDays).toBe(7)
    expect(core.auth.current).not.toBe(before)
    expect(core.auth.settings).toEqual({ sessionIdleDays: 7, otpViaTelegram: false })
    expect((await patch({ sessionIdleDays: 91 })).status).toBe(400)
    expect(BOT_TOKEN_COLUMN).toBe("telegram_bot_token_enc")
  })
})
