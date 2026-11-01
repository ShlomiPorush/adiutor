// Stable error codes shared by the HTTP API and the MCP tools. Clients branch on `code`; `message` is for
// people and never includes secrets or the text that was refused.

export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "validation_failed",
  "version_conflict",
  "secret_suspected",
  "not_top_level",
  "suppressed",
  "conflict",
  "rate_limited",
  "telegram_failed",
  "internal_error",
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export const ERROR_STATUS: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  version_conflict: 409,
  secret_suspected: 422,
  not_top_level: 422,
  suppressed: 409,
  conflict: 409,
  rate_limited: 429,
  telegram_failed: 502,
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
