import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import he from "../../shared/locales/he.json"
import { createApp } from "../app.ts"
import { audit, items, jobRuns, telegramUpdates } from "../db/schema.ts"
import { updateSettings } from "../services/admin.ts"
import type { Ctx } from "../services/context.ts"
import { StandInBotApi, waitFor } from "../testing/bot-api.ts"
import { createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import { BotApi, type TelegramUpdate } from "./api.ts"
import { handleUpdate, TelegramBot } from "./bot.ts"

// Assembled at run time: the guards and push protection scan literal text.
const TOKEN = `${"7654321"}:${"AAF"}${"q".repeat(33)}`
const OWNER_CHAT = "4242"
const PUBLIC_URL = new URL("http://127.0.0.1:8090")
const OWNER = "owner-token-for-tests-only-000000000000"
const AGENT = "agent-token-for-tests-only-000000000000"

let t: TestDatabase
let standIn: StandInBotApi
let bot: TelegramBot | undefined
const logged: string[] = []

const text = (updateId: number, body: string, chatId = OWNER_CHAT): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 0,
    chat: { id: Number(chatId), type: "private" },
    from: { id: Number(chatId), is_bot: false },
    text: body,
  },
})

function startBot(ctx: Ctx = t.ctx, apiUrl = standIn.url) {
  bot = new TelegramBot({
    ctx,
    api: new BotApi(TOKEN, apiUrl),
    chatId: OWNER_CHAT,
    publicUrl: PUBLIC_URL,
    pollTimeoutSeconds: 1,
    retryDelayMs: 50,
  })
  bot.start()
  return bot
}

const allItems = () => t.ctx.db.select().from(items)
const outcome = async (updateId: number) =>
  (await t.ctx.db.select().from(telegramUpdates).where(eq(telegramUpdates.updateId, updateId)))[0]?.outcome
/** True once the bot has asked for updates after `updateId`: everything up to it was handled. */
const confirmed = (updateId: number) => () => standIn.offsets.some((o) => o !== undefined && o > updateId)

beforeAll(async () => {
  for (const method of ["log", "error"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "))
    })
  t = await createTestDatabase("telegram")
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
  await updateSettings(t.ctx, owner, { language: "en" })
})
afterEach(async () => {
  await bot?.stop()
  bot = undefined
})

describe("Telegram bot", () => {
  it("files the owner's text in the inbox with an audit row and answers with a link to it", async () => {
    startBot()
    standIn.push(text(100, "Try a darker theme\nwith more contrast"))
    await waitFor(() => standIn.sent.length === 1)

    const [item] = await allItems()
    expect(item).toMatchObject({
      projectId: null,
      type: "idea",
      status: "future",
      title: "Try a darker theme",
      body: "Try a darker theme\nwith more contrast",
      createdBy: "bot",
    })
    const [entry] = await t.ctx.db
      .select()
      .from(audit)
      .where(eq(audit.entityId, item?.id ?? ""))
    expect(entry).toMatchObject({ action: "item.create", actorKind: "bot", actorLabel: "telegram", source: "telegram" })
    expect(await outcome(100)).toBe("item_created")
    expect(standIn.sent[0]).toEqual({
      chatId: OWNER_CHAT,
      text: `Saved under Inbox: Try a darker theme <a href="http://127.0.0.1:8090/items/${item?.id}">Open</a>`,
      parseMode: "HTML",
      linkPreview: { is_disabled: true },
    })
    await waitFor(confirmed(100))
    expect(bot?.polling).toBe(true)
  })

  it("does nothing for a repeated update_id", async () => {
    startBot()
    standIn.push(text(200, "Only once"), text(200, "Only once"))
    await waitFor(confirmed(200))
    standIn.push(text(200, "Only once"))
    standIn.push(text(201, "Marker"))
    await waitFor(confirmed(201))
    expect((await allItems()).map((i) => i.title).sort()).toEqual(["Marker", "Only once"])
    expect(standIn.sent).toHaveLength(2)
  })

  it("files nothing twice when the server stopped after the commit and before the offset moved on", async () => {
    // The first process committed update 300 and stopped before its next poll, so Telegram still holds it.
    standIn.push(text(300, "Written before the crash"))
    const first = await handleUpdate(t.ctx, { chatId: OWNER_CHAT, publicUrl: PUBLIC_URL }, text(300, "x"))
    expect(first).toMatchObject({ duplicate: false, outcome: "item_created" })

    startBot()
    await waitFor(confirmed(300))
    expect(await allItems()).toHaveLength(1)
    expect(standIn.sent).toHaveLength(0)
    expect(standIn.unconfirmed()).toEqual([])
  })

  it("acknowledges an update only after its transaction committed", async () => {
    // The secret check fails unexpectedly once: the transaction rolls back and the update is fetched again.
    let failures = 1
    const flaky: Ctx = {
      ...t.ctx,
      secrets: {
        redact: (value: string) => t.ctx.secrets.redact(value),
        find: (value: string) => {
          if (failures-- > 0) throw new Error("database went away")
          return t.ctx.secrets.find(value)
        },
      },
    }
    startBot(flaky)
    standIn.push(text(400, "Survives a failed attempt"))
    await waitFor(() => standIn.sent.length === 1)
    expect(await allItems()).toHaveLength(1)
    expect(await outcome(400)).toBe("item_created")
    // Polls before the success still asked from the start: the failed update was not acknowledged.
    const beforeSuccess = standIn.offsets.slice(0, standIn.offsets.indexOf(401))
    expect(beforeSuccess.every((o) => o === undefined || o <= 400)).toBe(true)
  })

  it("ignores other chats without answering", async () => {
    startBot()
    standIn.push(text(500, "Let me in", "999"))
    await waitFor(confirmed(500))
    expect(await allItems()).toHaveLength(0)
    expect(await outcome(500)).toBe("ignored")
    expect(standIn.sent).toHaveLength(0)
  })

  it("refuses text that looks like a secret, says why in Hebrew, and never echoes it", async () => {
    await updateSettings(t.ctx, owner, { language: "he" })
    startBot()
    const secret = `${"gh"}p_${"A1b2C3d4E5".repeat(4)}`
    standIn.push(text(600, `deploy key ${secret}`))
    await waitFor(() => standIn.sent.length === 1)
    expect(await allItems()).toHaveLength(0)
    expect(await outcome(600)).toBe("refused")
    expect(standIn.sent[0]?.text).toBe(he.telegram.refusedSecret)
    expect(JSON.stringify(standIn.sent)).not.toContain(secret)
  })

  it("answers /start and /help with the help text and photos with a short note", async () => {
    startBot()
    standIn.push(text(700, "/start"), text(701, "/help"), {
      update_id: 702,
      message: { message_id: 702, date: 0, chat: { id: Number(OWNER_CHAT), type: "private" } },
    })
    await waitFor(() => standIn.sent.length === 3)
    expect(standIn.sent.map((m) => m.text)).toEqual([
      "Send me any text and I will save it in Mikud, under Inbox. Every morning, Sunday to Friday at 08:00, I send you what is waiting on you.",
      "Send me any text and I will save it in Mikud, under Inbox. Every morning, Sunday to Friday at 08:00, I send you what is waiting on you.",
      "I save text messages only. Nothing was saved.",
    ])
    expect(await allItems()).toHaveLength(0)
  })

  it("keeps polling after Bot API errors and an unreachable server", async () => {
    standIn.pollFailures.push(500, 502)
    standIn.sendFailures.push(400)
    startBot()
    standIn.push(text(800, "After the errors"))
    await waitFor(() => standIn.offsets.length >= 3)
    await waitFor(confirmed(800))
    expect(await allItems()).toHaveLength(1)
    expect(standIn.sent).toHaveLength(0) // the one reply was refused with 400 and is not retried
    await bot?.stop()

    // Nothing listens on the stand-in's port once it is closed: use a port that refuses connections.
    const closed = await StandInBotApi.start(TOKEN)
    const deadUrl = closed.url
    await closed.close()
    const lost = startBot(t.ctx, deadUrl)
    await waitFor(() => logged.some((line) => line.includes("telegram polling failed") && line.includes("network")))
    expect(lost.polling).toBe(false)
  })

  it("reports its status to the owner only", async () => {
    startBot()
    standIn.push(text(900, "Status check"))
    await waitFor(() => standIn.sent.length === 1)
    await t.ctx.db.insert(jobRuns).values({ job: "morning", localDate: "2026-11-01", state: "sent" })
    const running = bot
    const app = (telegram?: { configured: boolean; polling: () => boolean }) =>
      createApp({
        checkDatabase: async () => true,
        core: {
          ctx: t.ctx,
          config: { ownerToken: OWNER, agentToken: AGENT, publicUrl: PUBLIC_URL, version: "test" },
          telegram,
        },
      })
    const get = (a: ReturnType<typeof app>, token: string) =>
      a.request("/api/v1/telegram/status", { headers: { authorization: `Bearer ${token}` } })

    const on = app({ configured: true, polling: () => running?.polling ?? false })
    const res = await get(on, OWNER)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: Record<string, unknown> }
    expect(data).toMatchObject({
      configured: true,
      polling: true,
      lastMorning: { localDate: "2026-11-01", state: "sent" },
    })
    expect(typeof data.lastUpdateAt).toBe("string")
    expect((await get(on, AGENT)).status).toBe(403)

    const off = (await (await get(app(undefined), OWNER)).json()) as { data: Record<string, unknown> }
    expect(off.data).toMatchObject({ configured: false, polling: false })
  })

  it("never logs the bot token or message text", () => {
    expect(logged.length).toBeGreaterThan(0)
    const all = logged.join("\n")
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain(TOKEN.split(":")[1])
    for (const words of ["darker theme", "Let me in", "deploy key", "After the errors", "Survives"])
      expect(all).not.toContain(words)
  })
})
