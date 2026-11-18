import { type EnvOverrides, githubMeantOn, OVERRIDE_VARIABLES } from "../config.ts"
import type { StoredInstallation } from "../db/schema.ts"
import type { SettingsRow } from "../services/admin.ts"
import type { SettingsCipher } from "../settings/crypto.ts"
import { keyFingerprint, readPrivateKey } from "./key.ts"

// The GitHub settings in effect, as settings/effective.ts does for the others: the environment first, per field, then
// the database. The private key never leaves this module except to the pull; the view carries its fingerprint only.

/** The column the App's private key is stored in; also the additional authenticated data of its encryption. */
export const GITHUB_KEY_COLUMN = "github_private_key_enc"

/** An installation the server may read: from Settings with its bound account, or from the environment by id alone. */
export type AllowedInstallation = { id: number; accountId: number | null; accountType: string | null; login: string | null }

export type GitHubKeyView = {
  set: boolean
  /** False when a stored key cannot be decrypted (other settings keys, a damaged value): paste it again. */
  readable: boolean
  /** Whether GitHub accepted the stored key on its save or at a pull; null for a key set by the environment. */
  verified: boolean | null
  fingerprint: string | null
  locked: boolean
  variable: string | null
}

export type GitHubSettingsView = {
  appId: { value: string | null; locked: boolean; variable: string | null }
  key: GitHubKeyView
  installations: { value: AllowedInstallation[]; locked: boolean; variable: string | null }
  /** Every save of a GitHub field raises it; a save names the one it was based on. */
  generation: number
  /** App id, a readable key and at least one installation: the server reads GitHub. */
  on: boolean
}

export type EffectiveGitHub = {
  appId: string | null
  /** The private key in effect (PEM), or null when none is set or the stored one cannot be read. */
  privateKey: string | null
  installations: AllowedInstallation[]
  on: boolean
  /** The environment names the App or its installations: start refuses without a key in effect. */
  meantOn: boolean
  view: GitHubSettingsView
}

const fromStored = (i: StoredInstallation): AllowedInstallation => ({
  id: i.id,
  accountId: i.accountId,
  accountType: i.accountType,
  login: i.login,
})

export function effectiveGitHub(row: SettingsRow, overrides: EnvOverrides, cipher: SettingsCipher): EffectiveGitHub {
  const appLocked = overrides.githubAppId !== undefined
  const appId = appLocked ? (overrides.githubAppId ?? null) : row.githubAppId

  const keyLocked = overrides.githubPrivateKey !== undefined
  let privateKey: string | null
  let fingerprint: string | null
  if (keyLocked) {
    privateKey = overrides.githubPrivateKey ?? null
    const read = privateKey ? readPrivateKey(privateKey) : null
    fingerprint = read && "key" in read ? keyFingerprint(read.key) : null
  } else {
    const stored = row.githubPrivateKeyEnc
    const plain = stored ? cipher.decrypt(GITHUB_KEY_COLUMN, stored) : null
    // A decrypted value is checked again: a key that no longer reads as one is treated as unreadable.
    privateKey = plain && "key" in readPrivateKey(plain) ? plain : null
    fingerprint = stored ? row.githubKeyFingerprint : null
  }
  const keySet = keyLocked || row.githubPrivateKeyEnc !== null

  const installationsLocked = overrides.githubInstallations !== undefined
  const installations = installationsLocked
    ? (overrides.githubInstallations ?? []).map((id) => {
        // A stored entry of the same id still gives the login to show; the environment's list is what is read.
        const stored = row.githubInstallations.find((i) => i.id === id)
        return stored ? fromStored(stored) : { id, accountId: null, accountType: null, login: null }
      })
    : row.githubInstallations.map(fromStored)

  const on = appId !== null && privateKey !== null && installations.length > 0
  return {
    appId,
    privateKey,
    installations,
    on,
    meantOn: githubMeantOn(overrides),
    view: {
      appId: {
        value: appId,
        locked: appLocked,
        variable: appLocked ? OVERRIDE_VARIABLES.githubAppId : null,
      },
      key: {
        set: keySet,
        readable: !keySet || privateKey !== null,
        verified: keyLocked ? null : keySet ? row.githubKeyVerified : false,
        fingerprint,
        locked: keyLocked,
        variable: keyLocked ? OVERRIDE_VARIABLES.githubPrivateKey : null,
      },
      installations: {
        value: installations,
        locked: installationsLocked,
        variable: installationsLocked ? OVERRIDE_VARIABLES.githubInstallations : null,
      },
      generation: row.githubGeneration,
      on,
    },
  }
}
