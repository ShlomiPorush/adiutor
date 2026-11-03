// What the spec files share: the owner's credentials, the TOTP secret made by the setup test, and each project's
// signed-in browser state (state.ts). Sign-in is rate limited (5 per 5 minutes per address; each project sends one
// X-Forwarded-For address), so specs reuse the stored session instead of signing in again.
// scripts/verify.sh's stack is thrown away after the run: global setup makes a new owner password for it. Against a
// stack that keeps its owner (the development stack), set E2E_USERNAME and E2E_PASSWORD, and E2E_TOTP_SECRET when
// the owner exists already.
import { expect, type Page } from "@playwright/test"
import he from "../src/shared/locales/he.json" with { type: "json" }
import { loadState } from "./state.ts"
import { freshTotp } from "./totp.ts"

export { loadState, nextBackupCode, resetState, saveState, storageFile } from "./state.ts"

export const USERNAME = process.env.E2E_USERNAME ?? "Owner.Name"

/** The owner's password: E2E_PASSWORD, or the one global setup made for this run. */
export function password(): string {
  const value = process.env.E2E_PASSWORD || loadState().password
  if (!value) throw new Error("No owner password: set E2E_PASSWORD, or run through scripts/verify.sh")
  return value
}

export const totpSecret = () => process.env.E2E_TOTP_SECRET || loadState().secret || ""

/** Like the UI: every filled value is wrapped in a first-strong isolate (U+2068 ... U+2069). */
export const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, name: string) => `⁨${vars[name] ?? ""}⁩`)

/** On the sign-in page: the password, then a fresh code. Ends wherever the page sends it. */
export async function signIn(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(he.login.title)
  await page.getByLabel(he.auth.username, { exact: true }).fill(USERNAME)
  await page.getByLabel(he.auth.password, { exact: true }).fill(password())
  await page.getByRole("button", { name: he.login.submit }).click()
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(he.login.codeTitle)
  await page.getByLabel(he.auth.code, { exact: true }).fill(await freshTotp(totpSecret()))
}
