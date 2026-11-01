// User-visible text comes only from src/shared/locales/{he,en}.json. Hebrew (right to left) is the
// default; English (left to right) works the same way. The language is a server setting, cached in
// this browser so the first paint (public/boot.js) is already in the right direction.

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react"
import en from "../../shared/locales/en.json"
import he from "../../shared/locales/he.json"
import { setFormatPrefs } from "../format/datetime.ts"
import { formatNumber, setNumberLocale } from "../format/number.ts"

export type Language = "he" | "en"
export type Vars = Record<string, string | number>

const LOCALES: Record<Language, unknown> = { he, en }
const STORAGE_KEY = "mikud.language"

function lookup(tree: unknown, key: string): string | undefined {
  let node: unknown = tree
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === "string" ? node : undefined
}

function fill(text: string, vars?: Vars): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
}

/** A string by key; a missing key falls back to English, then to the key itself. */
export function translate(language: Language, key: string, vars?: Vars): string {
  const text = lookup(LOCALES[language], key) ?? lookup(LOCALES.en, key) ?? key
  return fill(text, vars)
}

/** A count with its word in the right plural form: "{count}" is written with thousands separators. */
export function translateCount(language: Language, key: string, count: number, vars?: Vars): string {
  const category = new Intl.PluralRules(language).select(count)
  const form = lookup(LOCALES[language], `${key}.${category}`) !== undefined ? category : "other"
  return translate(language, `${key}.${form}`, { ...vars, count: formatNumber(count) })
}

export function hasKey(language: Language, key: string): boolean {
  return lookup(LOCALES[language], key) !== undefined
}

function readStored(): Language {
  try {
    return localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "he"
  } catch {
    return "he"
  }
}

/** Applies a language to the document, the number and date helpers, and this browser's cache. */
export function applyLanguage(language: Language): void {
  document.documentElement.lang = language
  document.documentElement.dir = language === "he" ? "rtl" : "ltr"
  setNumberLocale(language)
  setFormatPrefs({ uiLocale: language === "he" ? "he-IL" : "en-US" })
  try {
    localStorage.setItem(STORAGE_KEY, language)
  } catch {
    // Storage blocked: the language still applies to this page.
  }
}

type I18n = {
  language: Language
  dir: "rtl" | "ltr"
  setLanguage(language: Language): void
  t(key: string, vars?: Vars): string
  tc(key: string, count: number, vars?: Vars): string
}

const I18nContext = createContext<I18n | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => {
    const stored = readStored()
    applyLanguage(stored)
    return stored
  })
  const setLanguage = useCallback((next: Language) => {
    applyLanguage(next)
    setLanguageState(next)
  }, [])
  const value = useMemo<I18n>(
    () => ({
      language,
      dir: language === "he" ? "rtl" : "ltr",
      setLanguage,
      t: (key, vars) => translate(language, key, vars),
      tc: (key, count, vars) => translateCount(language, key, count, vars),
    }),
    [language, setLanguage],
  )
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  const value = useContext(I18nContext)
  if (!value) throw new Error("useI18n outside I18nProvider")
  return value
}
