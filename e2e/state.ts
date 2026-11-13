// The run's shared state, in one file in the temporary directory (mode 0600): the owner password global setup made
// for scripts/verify.sh's throwaway stack, the TOTP secret made by the setup test, the backup codes and the last
// TOTP step used, and each project's signed-in browser state. Nothing here reads a credential when it is imported:
// global setup imports it before it writes one.
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const STATE_FILE = join(tmpdir(), "adiutor-e2e-auth.json")

type State = { password?: string; secret?: string; lastStep?: number; backupCodes?: string[]; usedCodes?: number }

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

/** Where a project keeps its signed-in browser (cookies) for the next spec file. */
export const storageFile = (project: string) => join(tmpdir(), `adiutor-e2e-${project}.json`)

/** Forgets the state of an earlier run (global setup). */
export function resetState(): void {
  rmSync(STATE_FILE, { force: true })
  for (const project of ["desktop", "phone"]) rmSync(storageFile(project), { force: true })
}

/** The next backup code saved at setup that no test used yet. */
export function nextBackupCode(): string | undefined {
  const { backupCodes = [], usedCodes = 0 } = loadState()
  const code = backupCodes[usedCodes]
  if (code) saveState({ usedCodes: usedCodes + 1 })
  return code
}
