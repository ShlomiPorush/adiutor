import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto"
import type { Answer, TestBrowser } from "./browser.ts"

// A software passkey for integration tests: one discoverable ES256 credential with "none" attestation, its key pair
// new on every run, answering the options Better Auth's passkey plugin hands out the way a browser would pass them on.
// It can leave out user verification (UV), sign another challenge or claim another origin, for the refusals.

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest()

/** The CBOR (RFC 8949) subset WebAuthn needs here: integers, byte and text strings, and maps. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n])
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n])
    if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff])
    const b = Buffer.alloc(5)
    b[0] = (major << 5) | 26
    b.writeUInt32BE(n, 1)
    return b
  }
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8")
    return Buffer.concat([head(3, text.length), text])
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)])
  if (value instanceof Map) {
    const parts: Buffer[] = [head(5, value.size)]
    for (const [k, v] of value) parts.push(cbor(k), cbor(v))
    return Buffer.concat(parts)
  }
  throw new Error(`cbor: unsupported ${typeof value}`)
}

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40

export type CeremonyOptions = {
  /** Set the UV flag (the person was verified with a PIN or biometrics). */
  uv?: boolean
  /** The origin the browser reports in clientDataJSON. */
  origin?: string
  /** Sign this challenge instead of the one the server handed out. */
  challenge?: string
}

export class SoftwarePasskey {
  readonly credentialId = b64url(randomBytes(16))
  private readonly privateKey: KeyObject
  private readonly cosePublicKey: Buffer
  private counter: number
  private readonly zero: boolean

  /**
   * @param origin the page's origin, as the browser would report it
   * @param counter the signature counter: "zero" for a synced passkey (always 0), else a start value that grows
   */
  constructor(
    readonly origin: string,
    counter: number | "zero" = 1,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
    this.privateKey = privateKey
    const jwk = publicKey.export({ format: "jwk" })
    this.cosePublicKey = cbor(
      new Map<number, unknown>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
      ]),
    )
    this.zero = counter === "zero"
    this.counter = counter === "zero" ? 0 : counter
  }

  private nextCounter(): Buffer {
    if (!this.zero) this.counter += 1
    const b = Buffer.alloc(4)
    b.writeUInt32BE(this.counter >>> 0)
    return b
  }

  private clientData(type: string, challenge: string, options: CeremonyOptions): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge: options.challenge ?? challenge, origin: options.origin ?? this.origin }),
    )
  }

  /** The registration response for options from /passkey/generate-register-options. */
  attestation(creation: { challenge: string; rp: { id: string } }, options: CeremonyOptions = {}) {
    const credentialId = Buffer.from(this.credentialId, "base64url")
    const length = Buffer.alloc(2)
    length.writeUInt16BE(credentialId.length)
    const authData = Buffer.concat([
      sha256(creation.rp.id),
      Buffer.from([FLAG_UP | FLAG_AT | (options.uv === false ? 0 : FLAG_UV)]),
      this.nextCounter(),
      Buffer.alloc(16), // AAGUID: none
      length,
      credentialId,
      this.cosePublicKey,
    ])
    const attestationObject = cbor(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    )
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", creation.challenge, options)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    }
  }

  /** The sign-in response for options from /passkey/generate-authenticate-options. */
  assertion(request: { challenge: string; rpId: string }, options: CeremonyOptions = {}) {
    const authData = Buffer.concat([
      sha256(request.rpId),
      Buffer.from([FLAG_UP | (options.uv === false ? 0 : FLAG_UV)]),
      this.nextCounter(),
    ])
    const clientDataJSON = this.clientData("webauthn.get", request.challenge, options)
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey)
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
    }
  }

  /** Adds this passkey for the signed-in browser `b`: options, then the response. */
  async register(b: TestBrowser, name = "Test laptop", options: CeremonyOptions = {}): Promise<Answer> {
    const creation = await b.call("GET", "/api/auth/passkey/generate-register-options")
    if (creation.status !== 200) return creation
    return b.call("POST", "/api/auth/passkey/verify-registration", {
      body: { name, response: this.attestation(creation.json, options) },
    })
  }

  /** Signs browser `b` in with this passkey: options, then the response. */
  async signIn(b: TestBrowser, options: CeremonyOptions = {}): Promise<Answer> {
    const request = await b.call("GET", "/api/auth/passkey/generate-authenticate-options")
    if (request.status !== 200) return request
    return b.call("POST", "/api/auth/passkey/verify-authentication", {
      body: { response: this.assertion(request.json, options) },
    })
  }
}
