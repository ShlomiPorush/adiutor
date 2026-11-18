import { GitHubRefused, type RefusedCode } from "./client.ts"

// A failed GitHub request reduced to what the pull decides by: a status with GitHub's message and headers, a rate
// limit with its end, a refusal of the guarded fetch, an abort, or a network failure. Only stable codes and statuses
// leave this module for a log, an answer or an audit row; GitHub's message is matched here and never stored.

export type Failure =
  | { kind: "status"; status: number; message: string; headers: Record<string, string> }
  | { kind: "rate_limit"; until: Date }
  | { kind: "refused"; code: RefusedCode }
  | { kind: "aborted" }
  | { kind: "network" }

/** A secondary rate limit without a reset header: wait this long (GitHub's guidance is at least a minute). */
const SECONDARY_WAIT_MS = 60_000
/** A reset further away than this is not believed (a clock far off): the pull waits this long at most. */
const MAX_WAIT_MS = 24 * 60 * 60_000

const SECONDARY = /secondary rate limit/i

type Shaped = { status?: unknown; response?: { headers?: unknown; data?: unknown }; cause?: unknown; name?: unknown }

export const lowerHeaders = (headers: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(typeof headers === "object" && headers !== null ? headers : {}).map(([k, v]) => [
      k.toLowerCase(),
      String(v),
    ]),
  )

export const messageOf = (data: unknown): string =>
  typeof data === "object" && data !== null && typeof (data as { message?: unknown }).message === "string"
    ? (data as { message: string }).message
    : typeof data === "string"
      ? data
      : ""

function waitUntil(now: Date, ms: number): Date {
  return new Date(now.getTime() + Math.min(Math.max(ms, 0), MAX_WAIT_MS))
}

/**
 * GitHub's rate limits on a REST answer (403 or 429): the primary limit (`x-ratelimit-remaining: 0`, until
 * `x-ratelimit-reset`), `retry-after`, or a secondary limit named in the message. A 429 is always one.
 */
export function restRateLimit(
  status: number,
  headers: Record<string, string>,
  message: string,
  now: Date,
): Date | null {
  if (status !== 403 && status !== 429) return null
  if (headers["x-ratelimit-remaining"] === "0") {
    const reset = Number(headers["x-ratelimit-reset"])
    return Number.isFinite(reset) && reset > 0
      ? waitUntil(now, reset * 1000 - now.getTime())
      : waitUntil(now, SECONDARY_WAIT_MS)
  }
  const retry = headers["retry-after"]
  if (retry !== undefined && /^\d{1,6}$/.test(retry.trim())) return waitUntil(now, Number(retry.trim()) * 1000)
  if (SECONDARY.test(message) || status === 429) return waitUntil(now, SECONDARY_WAIT_MS)
  return null
}

/**
 * A GraphQL answer's rate limit, whatever its HTTP status: an error of type RATE_LIMITED or naming a secondary one. It
 * ends at `retry-after` when given, else at `x-ratelimit-reset` when none remain, else after a minute.
 */
export function graphqlRateLimit(errors: unknown, headers: Record<string, string>, now: Date): Date | null {
  if (!Array.isArray(errors)) return null
  const limited = errors.some((e) => {
    const err = e as { type?: unknown; message?: unknown }
    return err?.type === "RATE_LIMITED" || (typeof err?.message === "string" && SECONDARY.test(err.message))
  })
  if (!limited) return null
  const retry = headers["retry-after"]
  if (retry !== undefined && /^\d{1,6}$/.test(retry.trim())) return waitUntil(now, Number(retry.trim()) * 1000)
  const reset = Number(headers["x-ratelimit-reset"])
  return headers["x-ratelimit-remaining"] === "0" && Number.isFinite(reset) && reset > 0
    ? waitUntil(now, reset * 1000 - now.getTime())
    : waitUntil(now, SECONDARY_WAIT_MS)
}

/** What a thrown error of an Octokit request comes to. */
export function describeFailure(error: unknown, now: Date): Failure {
  const shaped = (error ?? {}) as Shaped
  if (error instanceof GitHubRefused) return { kind: "refused", code: error.code }
  if (shaped.cause instanceof GitHubRefused) return { kind: "refused", code: shaped.cause.code }
  if (shaped.name === "AbortError" || shaped.name === "TimeoutError") return { kind: "aborted" }
  if (shaped.cause && (shaped.cause as Shaped).name === "AbortError") return { kind: "aborted" }
  const status = typeof shaped.status === "number" ? shaped.status : 0
  // Octokit answers a fetch that threw (DNS, connection, TLS) as a 500 without a response.
  if (!shaped.response || status === 0) return { kind: "network" }
  const headers = lowerHeaders(shaped.response.headers)
  const message = messageOf(shaped.response.data)
  const until = restRateLimit(status, headers, message, now)
  if (until) return { kind: "rate_limit", until }
  return { kind: "status", status, message, headers }
}

/** The stable code a failure is recorded under (a run's errors, a log line). */
export function failureCode(failure: Failure): string {
  switch (failure.kind) {
    case "status":
      return `http_${failure.status}`
    case "rate_limit":
      return "rate_limited"
    case "refused":
      return failure.code === "redirect" ? "moved" : failure.code === "origin" ? "origin_refused" : failure.code
    case "aborted":
      return "aborted"
    case "network":
      return "unreachable"
  }
}
