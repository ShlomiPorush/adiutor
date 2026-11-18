import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/core"

// The only place that builds GitHub clients (with github/pull.ts and services/github.ts, the only importers of
// Octokit's types). Octokit is used through its documented options only: `request.fetch`, `request.signal`,
// `request.redirect`, `log`, `baseUrl`, `authStrategy` with `auth`, and `hook.before`. No plugin: no pagination,
// throttling or retry (the hourly schedule is the retry, and stored data survives a failed read).

/** Every request carries this version of GitHub's REST API. */
export const GITHUB_API_VERSION = "2022-11-28"

/** Why a request was not sent, or its answer not used: a stable code, never a message from GitHub. */
export type RefusedCode = "origin" | "superseded" | "stopped" | "redirect"

export class GitHubRefused extends Error {
  override name = "GitHubRefused"
  constructor(readonly code: RefusedCode) {
    super(`GitHub request refused: ${code}`)
  }
}

/** A log that drops every message: Octokit and its auth never log a URL, a header or an answer of ours. */
export const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} }

export type FetchGuard = {
  /** The configured API origin: a URL elsewhere is refused before it is sent. */
  origin: string
  /** The pull's or the save's signal: aborting it stops every request, the token request included. */
  signal: AbortSignal
  /** Asked before every request: false refuses it (a GitHub settings save is in progress or committed). */
  maySend?: () => boolean
  /** Asked before every request: true refuses it (the pull already stopped, at a rate limit for example). */
  stopped?: () => boolean
}

/**
 * The one `fetch` every GitHub request goes through (a documented option of `@octokit/request`): it adds the signal,
 * refuses another origin and a request the gate no longer allows, and sends with `redirect: "manual"`, turning any 3xx
 * answer into a thrown error before Octokit sees it, so the token request, REST and GraphQL all fail the same way.
 * Octokit wraps a thrown error in a RequestError whose `cause` is it (github/errors.ts reads it back).
 */
export function guardedFetch(guard: FetchGuard): typeof fetch {
  return async (input, init) => {
    guard.signal.throwIfAborted()
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== guard.origin) throw new GitHubRefused("origin")
    if (guard.maySend && !guard.maySend()) throw new GitHubRefused("superseded")
    if (guard.stopped?.()) throw new GitHubRefused("stopped")
    const signal = init?.signal ? AbortSignal.any([init.signal, guard.signal]) : guard.signal
    const response = await fetch(url, { ...init, signal, redirect: "manual" })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {})
      throw new GitHubRefused("redirect")
    }
    return response
  }
}

function common(guard: FetchGuard) {
  return {
    baseUrl: guard.origin,
    log: SILENT_LOG,
    request: { fetch: guardedFetch(guard), signal: guard.signal, redirect: "manual" as const, log: SILENT_LOG },
  }
}

/** Pins the API version on every request of the client, the token request of the App's auth included. */
function pinVersion(octokit: Octokit): Octokit {
  octokit.hook.before("request", (options) => {
    options.headers["x-github-api-version"] = GITHUB_API_VERSION
  })
  return octokit
}

/**
 * A client of the App itself: App routes are signed with a JWT from the private key, made per request by
 * `@octokit/auth-app` (`createAppAuth`), one instance per pull or save. `auth({ type: "installation", ... })` on it
 * gives an installation token.
 */
export function appClient(guard: FetchGuard, appId: string, privateKey: string): Octokit {
  return pinVersion(new Octokit({ ...common(guard), authStrategy: createAppAuth, auth: { appId, privateKey } }))
}

/** A client of one installation, with a token the App's auth gave. */
export function installationClient(guard: FetchGuard, token: string): Octokit {
  return pinVersion(new Octokit({ ...common(guard), auth: token }))
}

export type { Octokit }
