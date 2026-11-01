import type { Language } from "../../shared/enums.ts"
import en from "../../shared/locales/en.json"
import he from "../../shared/locales/he.json"

const LOCALES = { en, he } as const

/** The texts of the bot and the morning message in the owner's language (settings), Hebrew by default. */
export function telegramTexts(language: Language) {
  const locale = LOCALES[language] ?? LOCALES.he
  return { ...locale.telegram, inbox: locale.inbox }
}
