import { lastRun } from "../jobs/morning.ts"
import type { Ctx } from "../services/context.ts"
import { lastUpdateAt } from "./bot.ts"

/** What the running server knows about its bot; the rest comes from the database. */
export type TelegramRuntime = {
  /** The bot token and the owner's chat id are set. */
  configured: boolean
  /** The latest getUpdates call succeeded. */
  polling(): boolean
}

export const TELEGRAM_OFF: TelegramRuntime = { configured: false, polling: () => false }

export async function telegramStatus(ctx: Ctx, runtime: TelegramRuntime) {
  const run = await lastRun(ctx)
  return {
    configured: runtime.configured,
    polling: runtime.configured && runtime.polling(),
    lastUpdateAt: await lastUpdateAt(ctx),
    lastMorning: run ? { localDate: run.localDate, state: run.state, at: run.at } : null,
  }
}
