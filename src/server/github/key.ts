import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto"

// The private key of the owner's GitHub App. The owner generates it on GitHub and keeps the .pem in his own secret
// store; Adiutor never generates, prints or exports it. These checks are local: they never call GitHub, and their
// answers never repeat the key.

/** GitHub's App keys are 2048-bit RSA; a smaller one is not a key GitHub issued. */
const MIN_MODULUS_BITS = 2048

export type KeyProblem = "not_a_key" | "not_rsa" | "too_small"

/**
 * The key as pasted or set in the environment: surrounding space removed, and a key written on one line with `\n`
 * escapes (as an environment file often holds it) given its line breaks back.
 */
export function normalizeKey(text: string): string {
  const trimmed = text.trim()
  return trimmed.includes("\n") ? trimmed.replace(/\r\n/g, "\n") : trimmed.replace(/\\n/g, "\n")
}

/** Reads the key locally: an RSA private key of at least 2048 bits, or the reason it is not one. */
export function readPrivateKey(text: string): { key: KeyObject } | { problem: KeyProblem } {
  let key: KeyObject
  try {
    key = createPrivateKey({ key: normalizeKey(text), format: "pem" })
  } catch {
    return { problem: "not_a_key" }
  }
  const problem = keyProblem(key)
  return problem ? { problem } : { key }
}

/** What makes a key object unfit for the App: not a private key, not RSA, or under 2048 bits. */
export function keyProblem(
  key: Pick<KeyObject, "type" | "asymmetricKeyType" | "asymmetricKeyDetails">,
): KeyProblem | null {
  if (key.type !== "private") return "not_a_key"
  if (key.asymmetricKeyType !== "rsa") return "not_rsa"
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_MODULUS_BITS) return "too_small"
  return null
}

/**
 * The fingerprint GitHub shows beside each of an App's private keys: SHA-256 of the public key as SPKI DER, in
 * Base64, so the owner can tell which key to delete on GitHub during a rotation.
 */
export function keyFingerprint(key: KeyObject): string {
  const der = createPublicKey(key).export({ type: "spki", format: "der" })
  return `SHA256:${createHash("sha256").update(der).digest("base64")}`
}

/** The key in PKCS#8 PEM, as the App's JWT signing reads it (GitHub hands out PKCS#1). */
export function pkcs8(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }).toString()
}

export const KEY_PROBLEM_TEXT: Record<KeyProblem, string> = {
  not_a_key: "is not a PEM private key",
  not_rsa: "is not an RSA key",
  too_small: "is smaller than 2048 bits",
}
