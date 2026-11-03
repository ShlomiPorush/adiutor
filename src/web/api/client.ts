// The one HTTP client of the web UI. Every call goes through request(): it adds the CSRF header to
// state-changing requests, sends the session cookie (same origin), turns the server's
// {error: {code, message}} into an ApiError, and reports a 401 (and totp_required) to the app, which then
// goes to sign-in or to the TOTP setup. Paths are under /api/v1 unless they start with /api/.

import { API_ERROR_CODES, type ApiErrorCode } from "./types.ts"

export const API_BASE = "/api/v1"
/** A read or write without an answer fails after this long, so a hung request never holds a refresh. */
export const REQUEST_TIMEOUT_MS = 20_000

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
export type TransportRequest = { method: HttpMethod; path: string; body?: unknown }
export type TransportResponse = { status: number; body: unknown }
export type Transport = (request: TransportRequest) => Promise<TransportResponse>

export class ApiError extends Error {
  readonly status: number
  /** A server error code, "network" when no answer came, "unknown" for an answer without a code. */
  readonly code: ApiErrorCode | "network" | "unknown"
  /** The server's own sentence, shown as the reason after the UI's own text. */
  readonly serverMessage: string | null
  /** The error's other fields (docs/api.md, "Details"), such as `variable`, `field` or `issues`. */
  readonly details: Record<string, unknown>

  constructor(
    status: number,
    code: ApiError["code"],
    serverMessage: string | null,
    details: Record<string, unknown> = {},
  ) {
    super(serverMessage ?? code)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.serverMessage = serverMessage
    this.details = details
  }
}

/** The browser transport: same-origin fetch with the session cookie and the CSRF header. */
export const fetchTransport: Transport = async ({ method, path, body }) => {
  const headers: Record<string, string> = { Accept: "application/json" }
  // Every state-changing request carries the custom header; the browser adds Origin itself.
  if (method !== "GET") headers["X-Mikud-Request"] = "1"
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const response = await fetch(path.startsWith("/api/") ? path : `${API_BASE}${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  return { status: response.status, body: parsed }
}

let transport: Transport | Promise<Transport> = fetchTransport
let unauthorizedHandler: ((error: ApiError) => void) | null = null

// Development and screenshot builds may swap in the typed mock API. In the production build
// __MIKUD_MOCK__ is the literal false, so this branch and the mock module are dropped.
if (typeof __MIKUD_MOCK__ !== "undefined" && __MIKUD_MOCK__) {
  transport = import("./mock/transport.ts").then((module) => module.mockTransport)
}

/** Replaces the transport (tests). */
export function setTransport(next: Transport): void {
  transport = next
}

/** Called on each 401 answer and on totp_required: the app goes to sign-in or to the TOTP setup. */
export function onUnauthorized(handler: ((error: ApiError) => void) | null): void {
  unauthorizedHandler = handler
}

function errorFrom(status: number, body: unknown): ApiError {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error
  const code =
    typeof error?.code === "string" && (API_ERROR_CODES as readonly string[]).includes(error.code)
      ? (error.code as ApiErrorCode)
      : null
  const message = typeof error?.message === "string" && error.message.trim() ? error.message.trim() : null
  if (code) {
    const { code: _code, message: _message, ...details } = error as Record<string, unknown>
    return new ApiError(status, code, message, details)
  }
  if (status === 401) return new ApiError(status, "unauthorized", message)
  if (status === 403) return new ApiError(status, "forbidden", message)
  if (status === 404) return new ApiError(status, "not_found", message)
  return new ApiError(status, "unknown", message)
}

export async function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  let response: TransportResponse
  try {
    response = await (await transport)({ method, path, body })
  } catch {
    throw new ApiError(0, "network", null)
  }
  if (response.status >= 200 && response.status < 300) return response.body as T
  const error = errorFrom(response.status, response.body)
  if (error.status === 401 || error.code === "totp_required") unauthorizedHandler?.(error)
  throw error
}

/** Builds a query string from defined values only. */
export function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ""
}
