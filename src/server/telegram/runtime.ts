import { MorningJob } from "../jobs/morning.ts"
import { errorFacts, log } from "../log.ts"
import { getSettings } from "../services/admin.ts"
import type { Ctx } from "../services/context.ts"
import { BotApi } from "./api.ts"
import { TelegramBot } from "./bot.ts"
import { fill, type TelegramHtml } from "./html.ts"
import type { TelegramRuntime } from "./status.ts"
import { telegramTexts } from "./texts.ts"

export type TelegramPair = { botToken: string; chatId: string }

export type TelegramServiceDeps = {
  ctx: Ctx
  publicUrl: URL
  /** The Bot API base URL (TELEGRAM_API_URL; a stand-in in tests). */
  apiUrl: string
  /** Tests only: shorter polls and retries. */
  bot?: { pollTimeoutSeconds?: number; retryDelayMs?: number }
  /** Tests only: no morning job. */
  withoutMorningJob?: boolean
}

type Running = { pair: TelegramPair; api: BotApi; bot: TelegramBot; job: MorningJob | undefined }

/**
 * Owns the bot and the morning job. `reload` stops both (each waits for a send in flight) and starts them again with
 * the pair in effect, or leaves them off. Calls run one at a time. The morning message's at-most-once rule does not
 * depend on this: its job_runs row decides, and a run left in `sending` becomes `unknown` and is never resent.
 */
export class TelegramService implements TelegramRuntime {
  private running: Running | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: TelegramServiceDeps) {}

  get configured(): boolean {
    return this.running !== undefined
  }

  polling(): boolean {
    return this.running?.bot.polling ?? false
  }

  async send(text: TelegramHtml): Promise<void> {
    const running = this.running
    if (!running) throw new Error("telegram is off")
    await running.api.sendMessage(running.pair.chatId, text)
  }

  /** Better Auth's two-factor OTP: the code goes to the owner's chat and never to the log. */
  async sendSignInCode(code: string): Promise<void> {
    const t = telegramTexts((await getSettings(this.deps.ctx.db)).language)
    await this.send(fill(t.signInCode, { code }))
  }

  /** Applies the pair in effect (null: off). Does nothing when it did not change. */
  reload(pair: TelegramPair | null): Promise<void> {
    const next = this.queue.then(() => this.swap(pair))
    this.queue = next.catch(() => {})
    return next
  }

  stop(): Promise<void> {
    return this.reload(null)
  }

  private async swap(pair: TelegramPair | null): Promise<void> {
    const current = this.running
    if (current && pair && current.pair.botToken === pair.botToken && current.pair.chatId === pair.chatId) return
    if (!current && !pair) return
    if (current) {
      this.running = undefined
      await Promise.all([current.bot.stop(), current.job?.stop()])
      log.info("telegram stopped")
    }
    if (!pair) {
      log.info("telegram is off: the bot and the morning message do not run")
      return
    }
    const { ctx, publicUrl } = this.deps
    const api = new BotApi(pair.botToken, this.deps.apiUrl)
    const bot = new TelegramBot({ ctx, api, chatId: pair.chatId, publicUrl, ...this.deps.bot })
    const job = this.deps.withoutMorningJob
      ? undefined
      : new MorningJob({
          ctx,
          publicUrl,
          send: async (text, signal) => {
            await api.sendMessage(pair.chatId, text, signal)
          },
        })
    bot.start()
    try {
      await job?.start()
    } catch (error) {
      log.error("the morning job could not start", errorFacts(error))
      await bot.stop()
      throw error
    }
    this.running = { pair, api, bot, job }
  }
}
