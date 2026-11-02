// What the spec files share: the owner's invented credentials, the TOTP secret made by the setup test, and each
// project's signed-in browser state. Sign-in is rate limited (5 per 5 minutes per address; each project sends one
// X-Forwarded-For address), so specs reuse the stored session instead of signing in again.
// Against a stack whose owner exists already, set E2E_USERNAME, E2E_PASSWORD and E2E_TOTP_SECRET.
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page } from "@playwright/test"
import he from "../src/shared/locales/he.json" with { type: "json" }
import { freshTotp } from "./totp.ts"

export const USERNAME = process.env.E2E_USERNAME ?? "Owner.Name"
export const PASSWORD = process.env.E2E_PASSWORD ?? "correct horse battery staple"

const STATE_FILE = join(tmpdir(), "mikud-e2e-auth.json")

type State = { secret?: string; lastStep?: number; backupCodes?: string[]; usedCodes?: number }

export function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State
  } catch {
    return {}
  }
}

export function saveState(patch: State): void {
  writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...patch }), { mode: 0o600 })
}

/** Forgets the state of an earlier run (global setup). */
export function resetState(): void {
  rmSync(STATE_FILE, { force: true })
  for (const project of ["desktop", "phone"]) rmSync(storageFile(project), { force: true })
}

export const totpSecret = () => process.env.E2E_TOTP_SECRET || loadState().secret || ""

/** The next backup code saved at setup that no test used yet. */
export function nextBackupCode(): string | undefined {
  const { backupCodes = [], usedCodes = 0 } = loadState()
  const code = backupCodes[usedCodes]
  if (code) saveState({ usedCodes: usedCodes + 1 })
  return code
}

/** Where a project keeps its signed-in browser (cookies) for the next spec file. */
export const storageFile = (project: string) => join(tmpdir(), `mikud-e2e-${project}.json`)

/** Like the UI: every filled value is wrapped in a first-strong isolate (U+2068 ... U+2069). */
export const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, name: string) => `⁨${vars[name] ?? ""}⁩`)

/** On the sign-in page: the password, then a fresh code. Ends wherever the page sends it. */
export async function signIn(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(he.login.title)
  await page.getByLabel(he.auth.username, { exact: true }).fill(USERNAME)
  await page.getByLabel(he.auth.password, { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: he.login.submit }).click()
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(he.login.codeTitle)
  await page.getByLabel(he.auth.code, { exact: true }).fill(await freshTotp(totpSecret()))
}
