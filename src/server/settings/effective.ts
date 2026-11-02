import { type EnvOverrides, OVERRIDE_VARIABLES } from "../config.ts"
import type { SettingsRow } from "../services/admin.ts"
import type { SettingsCipher } from "./crypto.ts"

// What a setting the owner manages is in effect: the environment first, per field, then the database, then the
// default. A field the environment sets is locked: the API refuses to change it and the UI says which variable
// sets it.

/** The column the bot token is stored in; also the additional authenticated data of its encryption. */
export const BOT_TOKEN_COLUMN = "telegram_bot_token_enc"

export type TelegramState = "off" | "incomplete" | "on"

export type EffectiveTelegram = {
  /** The token in effect, or null when it is not set or cannot be read. */
  botToken: string | null
  chatId: string | null
  state: TelegramState
  /** The fields an incomplete pair lacks. */
  missing: ("botToken" | "chatId")[]
  view: TelegramView
}

/** The Telegram fields as the API shows them: the token is never returned. */
export type TelegramView = {
  botToken: { set: boolean; readable: boolean; locked: boolean; variable: string | null }
  chatId: { value: string | null; locked: boolean; variable: string | null }
  state: TelegramState
  missing: ("botToken" | "chatId")[]
}

export type PrivateDomainsView = { value: string[]; locked: boolean; variable: string | null }

export function effectiveTelegram(
  row: SettingsRow,
  overrides: EnvOverrides,
  cipher: SettingsCipher,
): EffectiveTelegram {
  const tokenLocked = overrides.telegramBotToken !== undefined
  const stored = row.telegramBotTokenEnc
  const decrypted = !tokenLocked && stored ? cipher.decrypt(BOT_TOKEN_COLUMN, stored) : null
  const botToken = tokenLocked ? (overrides.telegramBotToken ?? null) : decrypted
  const tokenSet = tokenLocked || stored !== null
  const chatLocked = overrides.telegramChatId !== undefined
  const chatId = chatLocked ? (overrides.telegramChatId ?? null) : row.telegramChatId
  const missing: ("botToken" | "chatId")[] = []
  if (!botToken) missing.push("botToken")
  if (!chatId) missing.push("chatId")
  // An unreadable stored token counts as set: the pair is incomplete until it is entered again.
  const state: TelegramState = missing.length === 0 ? "on" : !tokenSet && !chatId ? "off" : "incomplete"
  return {
    botToken,
    chatId,
    state,
    missing: state === "off" ? [] : missing,
    view: {
      botToken: {
        set: tokenSet,
        readable: !tokenSet || botToken !== null,
        locked: tokenLocked,
        variable: tokenLocked ? OVERRIDE_VARIABLES.telegramBotToken : null,
      },
      chatId: {
        value: chatId,
        locked: chatLocked,
        variable: chatLocked ? OVERRIDE_VARIABLES.telegramChatId : null,
      },
      state,
      missing: state === "off" ? [] : missing,
    },
  }
}

export function effectivePrivateDomains(row: SettingsRow, overrides: EnvOverrides): PrivateDomainsView {
  const locked = overrides.privateDomains !== undefined
  return {
    value: locked ? (overrides.privateDomains ?? []) : row.privateDomains,
    locked,
    variable: locked ? OVERRIDE_VARIABLES.privateDomains : null,
  }
}
