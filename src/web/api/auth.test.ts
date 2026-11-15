import { describe, expect, it } from "vitest"
import en from "../../shared/locales/en.json" with { type: "json" }
import { authFailure, FAILURE_TEXT, isPasskeyFailure, PASSKEY_FAILURE_TEXT, passkeyFailure } from "./auth.ts"

describe("authFailure", () => {
  it("sorts failed sign-in answers by what the owner can do next", () => {
    expect(authFailure(null, "password")).toBe("network")
    expect(authFailure({ status: 401, code: "INVALID_USERNAME_OR_PASSWORD" }, "password")).toBe("wrong_password")
    expect(authFailure({ status: 400, code: "INVALID_PASSWORD" }, "password")).toBe("wrong_password")
    expect(authFailure({ status: 401, code: "INVALID_CODE" }, "code")).toBe("wrong_code")
    expect(authFailure({ status: 401, code: "INVALID_BACKUP_CODE" }, "code")).toBe("wrong_code")
    expect(authFailure({ status: 401, code: "INVALID_TWO_FACTOR_COOKIE" }, "code")).toBe("code_expired")
    expect(authFailure({ status: 429, code: "ACCOUNT_TEMPORARILY_LOCKED" }, "code")).toBe("account_locked")
    expect(authFailure({ status: 429 }, "password")).toBe("rate_limited")
  })

  it("shows a server failure as the UI's own sentence, not a number", () => {
    const failure = authFailure({ status: 500, code: "internal_error" }, "password")
    expect(failure).toBe("server")
    expect(FAILURE_TEXT.server).toBe("auth.error.server")
    expect(en.auth.error.server).toBe("The server failed. Try again in a moment.")
  })
})

describe("passkeyFailure", () => {
  it("tells a closed or timed-out prompt from an address, a device or a server that refuses", () => {
    const browser = (code: string) => passkeyFailure({ status: 400, code })
    expect(browser("AUTH_CANCELLED")).toBe("passkey_cancelled")
    expect(browser("ERROR_CEREMONY_ABORTED")).toBe("passkey_cancelled")
    expect(browser("ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY")).toBe("passkey_cancelled")
    expect(browser("ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED")).toBe("passkey_registered")
    expect(browser("ERROR_INVALID_DOMAIN")).toBe("passkey_address")
    expect(browser("ERROR_INVALID_RP_ID")).toBe("passkey_address")
    expect(browser("ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT")).toBe("passkey_unsuitable")
    expect(browser("ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT")).toBe("passkey_unsuitable")
    expect(browser("ERROR_AUTHENTICATOR_GENERAL_ERROR")).toBe("passkey_failed")
    // The server's answers keep their meaning.
    expect(passkeyFailure({ status: 401, code: "PASSKEY_NOT_FOUND" })).toBe("wrong_password")
    expect(passkeyFailure({ status: 429 })).toBe("rate_limited")
    expect(passkeyFailure(null)).toBe("network")
  })
})

describe("the sentence of a passkey failure", () => {
  // What the passkey client answers when the authenticator fails: SimpleWebAuthn's code, and "Auth cancelled" as the
  // message whatever happened (client.mjs of @better-auth/passkey 1.7.19).
  const lookup = (key: string) => key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], en)

  it("says the device failed, not that the prompt was cancelled", () => {
    const failure = passkeyFailure({
      status: 400,
      code: "ERROR_AUTHENTICATOR_GENERAL_ERROR",
      message: "Auth cancelled",
    })
    expect(isPasskeyFailure(failure)).toBe(true)
    if (!isPasskeyFailure(failure)) return
    const text = String(lookup(PASSKEY_FAILURE_TEXT[failure]))
    expect(text).toBe(en.auth.error.passkeyFailed)
    expect(text.toLowerCase()).not.toContain("cancel")
  })

  it("has a sentence in both languages for every failure the browser reports", () => {
    for (const key of Object.values(PASSKEY_FAILURE_TEXT)) expect(typeof lookup(key)).toBe("string")
  })
})
