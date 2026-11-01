// RFC 6238 codes for the end-to-end tests, from the self-written implementation the server tests use too.
import { totp } from "../src/server/testing/totp.ts"
import { loadState, saveState } from "./helpers.ts"

export { totp }

/**
 * A code from a 30-second step not used yet in this run (spec files and projects share the record), waiting for
 * the next step when needed, so a code is never sent twice.
 */
export async function freshTotp(secret: string): Promise<string> {
  const last = loadState().lastStep ?? -1
  let step = Math.floor(Date.now() / 30_000)
  if (step <= last) {
    await new Promise((resolve) => setTimeout(resolve, (last + 1) * 30_000 - Date.now() + 500))
    step = Math.floor(Date.now() / 30_000)
  }
  saveState({ lastStep: step })
  return totp(secret)
}
