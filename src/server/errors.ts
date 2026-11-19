// Stable error codes shared by the HTTP API and the MCP tools. Clients branch on `code`; `message` is for
// people and never includes secrets or the text that was refused.

export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "totp_required",
  "not_found",
  "validation_failed",
  "version_conflict",
  "secret_suspected",
  "not_top_level",
  "suppressed",
  "conflict",
  "rate_limited",
  "setting_locked",
  "telegram_failed",
  "telegram_uncertain",
  "github_key_invalid",
  "github_key_rejected",
  "github_app_mismatch",
  "github_unreachable",
  "github_installation_not_found",
  "github_key_required",
  "github_not_set_up",
  "github_rate_limited",
  "github_create_expired",
  "github_install_expired",
  "github_code_rejected",
  "github_app_invalid",
  "github_installation_suspended",
  "github_installation_too_broad",
  "internal_error",
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export const ERROR_STATUS: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503> = {
  unauthorized: 401,
  forbidden: 403,
  totp_required: 403,
  not_found: 404,
  validation_failed: 400,
  version_conflict: 409,
  secret_suspected: 422,
  not_top_level: 422,
  suppressed: 409,
  conflict: 409,
  rate_limited: 429,
  setting_locked: 409,
  telegram_failed: 502,
  telegram_uncertain: 502,
  github_key_invalid: 400,
  github_key_rejected: 422,
  github_app_mismatch: 422,
  github_unreachable: 502,
  github_installation_not_found: 422,
  github_key_required: 409,
  github_not_set_up: 409,
  github_rate_limited: 429,
  github_create_expired: 409,
  github_install_expired: 409,
  github_code_rejected: 422,
  github_app_invalid: 422,
  github_installation_suspended: 422,
  github_installation_too_broad: 422,
  internal_error: 500,
}

export class AppError extends Error {
  override name = "AppError"
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Extra machine-readable fields, for example the rule a secret matched or the current version. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }

  get status() {
    return ERROR_STATUS[this.code]
  }
}

export const notFound = (what: string) => new AppError("not_found", `${what} was not found.`)
export const forbidden = (message: string) => new AppError("forbidden", message)
export const invalid = (message: string, details?: Record<string, unknown>) =>
  new AppError("validation_failed", message, details)

/** The body of an error answer: {error: {code, message, ...details}}. */
export function errorBody(error: AppError) {
  return { error: { code: error.code, message: error.message, ...error.details } }
}
