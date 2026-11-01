import { eq, sql } from "drizzle-orm"
import type { TelegramOutcome } from "../../shared/enums.ts"
import { UI_ROUTES, uiUrl } from "../../shared/routes.ts"
import { telegramUpdates } from "../db/schema.ts"
import { AppError } from "../errors.ts"
import { log } from "../log.ts"
import { getSettings } from "../services/admin.ts"
import { type By, type Ctx, inTx } from "../services/context.ts"
import { captureItemTx } from "../services/items.ts"
import { type BotApi, TelegramError, type TelegramUpdate } from "./api.ts"
import { fill, html, link, oneLine, type TelegramHtml } from "./html.ts"
import { telegramTexts } from "./texts.ts"

/** The bot's actor: it may capture into the inbox and nothing else. */
export const BOT: By = { actor: { kind: "bot", label: "telegram" }, source: "telegram" }

/** What an update asks for. Pure: decided from the update and the owner's chat id only. */
export type UpdateKind =
  | { kind: "stranger" }
  | { kind: "not_text" }
  | { kind: "command" }
  | { kind: "capture"; text: string }

const COMMAND = /^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)?(\s|$)/

export function classifyUpdate(update: TelegramUpdate, ownerChatId: string): UpdateKind {
  const message = update.message
  // Other chats get no answer at all: the bot does not reveal that it serves anyone.
  if (!message || String(message.chat.id) !== ownerChatId || message.from?.is_bot) return { kind: "stranger" }
  if (typeof message.text !== "string" || !message.text.trim()) return { kind: "not_text" }
  // /start, /help and any other command answer with the help text; a command is never filed.
  if (COMMAND.test(message.text)) return { kind: "command" }
  return { kind: "capture", text: message.text }
}

export type UpdateResult =
  | { duplicate: true }
  | { duplicate: false; outcome: TelegramOutcome; itemId: string | null; reply: TelegramHtml | null }

/**
 * Records one update in one transaction: its `update_id` row and, for the owner's text, the inbox item with
 * its audit row. A repeated `update_id` does nothing. The reply is returned to be sent after the commit.
 */
export async function handleUpdate(
  ctx: Ctx,
  options: { chatId: string; publicUrl: URL },
  update: TelegramUpdate,
): Promise<UpdateResult> {
  const kind = classifyUpdate(update, options.chatId)
  return inTx(ctx, async (tx): Promise<UpdateResult> => {
    const [claimed] = await tx
      .insert(telegramUpdates)
      .values({ updateId: update.update_id, outcome: "ignored", at: ctx.clock() })
      .onConflictDoNothing()
      .returning()
    if (!claimed) return { duplicate: true }
    if (kind.kind === "stranger") return { duplicate: false, outcome: "ignored", itemId: null, reply: null }

    const t = telegramTexts((await getSettings(tx)).language)
    if (kind.kind === "not_text") return { duplicate: false, outcome: "ignored", itemId: null, reply: fill(t.onlyText) }
    if (kind.kind === "command")
      return { duplicate: false, outcome: "ignored", itemId: null, reply: fill(t.help, { inbox: t.inbox }) }

    let outcome: TelegramOutcome
    let reply: TelegramHtml
    let itemId: string | null = null
    try {
      // A savepoint: a refusal leaves the update row in place.
      const item = await tx.transaction((sp) => captureItemTx(ctx, sp, BOT, { text: kind.text }))
      outcome = "item_created"
      itemId = item.id
      const href = uiUrl(options.publicUrl, UI_ROUTES.item(item.id))
      reply = html`${fill(t.saved, { inbox: t.inbox, title: oneLine(item.title, 80) })} ${link(href, t.open)}`
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "secret_suspected") throw error
      // Never echo the text: it may hold the secret.
      outcome = "refused"
      reply = fill(t.refusedSecret)
    }
    await tx.update(telegramUpdates).set({ outcome }).where(eq(telegramUpdates.updateId, update.update_id))
    return { duplicate: false, outcome, itemId, reply }
  })
}

/** When the bot last recorded an update, for the status route. */
export async function lastUpdateAt(ctx: Ctx): Promise<Date | null> {
  const [row] = await ctx.db.select({ at: sql<string | null>`max(${telegramUpdates.at})` }).from(telegramUpdates)
  const at = row?.at
  return at ? new Date(at) : null
}

export type BotOptions = {
  ctx: Ctx
  api: BotApi
  chatId: string
  publicUrl: URL
  /** Seconds a getUpdates call waits for an update (Telegram's long polling). */
  pollTimeoutSeconds?: number
  /** Pause after a failed poll or a failed update, before trying again. */
  retryDelayMs?: number
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

const errorCode = (error: unknown) =>
  error instanceof TelegramError ? error.code : error instanceof Error ? error.name : "unknown"

/**
 * Long polling. The next `offset` is the highest committed `update_id` + 1, so Telegram forgets an update
 * only after its transaction committed. A failed update stops its batch; the next poll fetches it again.
 */
export class TelegramBot {
  private offset: number | undefined
  private loop: Promise<void> | undefined
  private readonly stopping = new AbortController()
  /** True while the latest getUpdates call succeeded. */
  polling = false

  constructor(private readonly options: BotOptions) {}

  start(): void {
    log.info("telegram bot polling")
    this.loop = this.run()
  }

  async stop(): Promise<void> {
    this.stopping.abort()
    await this.loop
    this.polling = false
  }

  private async run(): Promise<void> {
    const { api, ctx, chatId, publicUrl } = this.options
    const signal = this.stopping.signal
    const retryDelay = this.options.retryDelayMs ?? 5_000
    while (!signal.aborted) {
      let updates: TelegramUpdate[]
      try {
        updates = await api.getUpdates(this.offset, this.options.pollTimeoutSeconds ?? 50, signal)
        this.polling = true
      } catch (error) {
        if (signal.aborted) break
        this.polling = false
        log.warn("telegram polling failed", { code: errorCode(error) })
        const wait = error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : retryDelay
        await pause(wait, signal)
        continue
      }

      for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
        if (signal.aborted) break
        let result: UpdateResult
        try {
          result = await handleUpdate(ctx, { chatId, publicUrl }, update)
        } catch (error) {
          log.error("telegram update not recorded; it is fetched again", {
            updateId: update.update_id,
            error: errorCode(error),
          })
          await pause(retryDelay, signal)
          break
        }
        this.offset = Math.max(this.offset ?? 0, update.update_id + 1)
        if (result.duplicate) continue
        if (result.outcome !== "ignored" || result.reply)
          log.info("telegram update", { updateId: update.update_id, outcome: result.outcome })
        if (result.reply) {
          try {
            await api.sendMessage(chatId, result.reply, signal)
          } catch (error) {
            log.warn("telegram reply failed", { updateId: update.update_id, code: errorCode(error) })
          }
        }
      }
    }
  }
}
