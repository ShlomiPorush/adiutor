import { generateKeyPairSync } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import type { JWK } from "oidc-provider"
import type { Db } from "../db/client.ts"
import { agentState } from "../db/schema.ts"
import type { SettingsCipher } from "../settings/crypto.ts"

/** The additional data of the encrypted key: a value copied into another column does not decrypt. */
export const SIGNING_KEY_COLUMN = "agent_state.signing_key_enc"

/**
 * The authorization server's one signing key (D1i): an Ed25519 key generated with the CSPRNG at the first start that
 * needs it, kept encrypted with ADIUTOR_SETTINGS_KEYS in the state row, and never regenerated. Two first starts at once
 * agree on one key (the row is locked). A stored key that no listed settings key decrypts stops the start: replacing it
 * silently would hide that the settings keys changed.
 */
export async function loadSigningKey(db: Db, cipher: SettingsCipher): Promise<JWK> {
  return db.transaction(async (tx) => {
    await tx.insert(agentState).values({ id: 1 }).onConflictDoNothing()
    const rows = await tx.execute<{ signing_key_enc: string | null }>(
      sql`select signing_key_enc from agent_state where id = 1 for update`,
    )
    const stored = [...rows][0]?.signing_key_enc ?? null
    if (stored) {
      const plain = cipher.decrypt(SIGNING_KEY_COLUMN, stored)
      if (!plain) throw new Error("the agent signing key cannot be decrypted with ADIUTOR_SETTINGS_KEYS")
      return JSON.parse(plain) as JWK
    }
    const { privateKey } = generateKeyPairSync("ed25519")
    const jwk = privateKey.export({ format: "jwk" }) as JWK
    await tx
      .update(agentState)
      .set({ signingKeyEnc: cipher.encrypt(SIGNING_KEY_COLUMN, JSON.stringify(jwk)) })
      .where(eq(agentState.id, 1))
    return jwk
  })
}
