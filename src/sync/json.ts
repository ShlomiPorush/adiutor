// Small readers for JSON from outside the process (the T3 CLI, the overview snapshot, files written by
// an agent). Everything read is untrusted data: it is checked field by field and only ever passed on
// as JSON, never into a command line.

export type JsonObject = Record<string, unknown>

export function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** A finite, non-negative integer, or undefined. */
export function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** An ISO-like timestamp string that Date can read, or null. */
export function asTime(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null
}

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ""))
  } catch {
    throw new Error(`${what} is not valid JSON`)
  }
}
