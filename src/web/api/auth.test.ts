import { describe, expect, it } from "vitest"
import en from "../../shared/locales/en.json" with { type: "json" }
import { authFailure, FAILURE_TEXT } from "./auth.ts"

describe("authFailure", () => {
  it("sorts failed sign-in answers by what the owner can do next", () => {
    expect(authFailure(null, "password")).toBe("network")
    expect(authFailure({ status: 401, code: "INVALID_USERNAME_OR_PASSWORD" }, "password")).toBe("wrong_password")
    expect(authFailure({ status: 401, code: "INVALID_CODE" }, "code")).toBe("wrong_code")
    expect(authFailure({ status: 401, code: "INVALID_TWO_FACTOR_COOKIE" }, "code")).toBe("code_expired")
    expect(authFailure({ status: 429, code: "rate_limited" }, "password")).toBe("rate_limited")
    expect(authFailure({ status: 503, code: "busy" }, "password")).toBe("busy")
    expect(authFailure({ status: 401, code: "session_ended", reason: "idle" }, "code")).toBe("session_ended")
  })

  it("shows a server failure (the wrapper's safe 500) as the UI's own sentence, not a number", () => {
    const failure = authFailure({ status: 500, code: "internal_error" }, "password")
    expect(failure).toBe("server")
    expect(FAILURE_TEXT.server).toBe("auth.error.server")
    expect(en.auth.error.server).toBe("The server failed. Try again in a moment.")
  })
})
