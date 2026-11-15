// The consent page's API (docs/api.md, "The approval API"): under the request's own address, /connect/approve/<uid>,
// so the authorization server's cookie for that request comes along; outside /api/v1, so not through client.ts. Its
// errors are flat ({error, message}) and are turned into one stable reason the page shows in words.

import type { AgentArea } from "../../shared/enums.ts"
import { REQUEST_TIMEOUT_MS } from "./client.ts"
import type { ConsentDetails } from "./types.ts"

/**
 * Why the page cannot go on: sign in first, set up two-factor first, the request is no longer open (expired, answered,
 * or opened in another browser session), agents cannot connect here (agents off, or the public URL does not allow it,
 * or an Adiutor without agent access: 404), refused, another refusal of the request, or an answer that may not be the
 * server's own (a server error, or not JSON: lost on its way, so the request may have been carried out), or no answer
 * at all.
 */
export type ConsentFailure =
  | "unauthorized"
  | "totp_required"
  | "gone"
  | "not_configured"
  | "forbidden"
  | "validation"
  | "other"
  | "lost"
  | "network"

export class ConsentError extends Error {
  readonly reason: ConsentFailure
  constructor(reason: ConsentFailure) {
    super(reason)
    this.name = "ConsentError"
    this.reason = reason
  }
}

/** The reason of a refused answer, from its stable code first and its status second. */
export function consentFailure(status: number, code: unknown): ConsentFailure {
  if (code === "unauthorized" || status === 401) return "unauthorized"
  if (code === "totp_required") return "totp_required"
  if (code === "gone" || status === 410) return "gone"
  if (code === "not_configured" || status === 404) return "not_configured"
  if (code === "validation_failed" || status === 400) return "validation"
  if (code === "forbidden" || status === 403) return "forbidden"
  return "other"
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new ConsentError("network")
  }
  // A server error, or an answer that is not the API's JSON (a proxy's page, a cut connection), says nothing about
  // whether the request was carried out.
  if (response.status >= 500 || !(response.headers.get("content-type") ?? "").includes("application/json"))
    throw new ConsentError("lost")
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ConsentError("lost")
  }
  if (!response.ok) throw new ConsentError(consentFailure(response.status, (body as { error?: unknown })?.error))
  return body as T
}

const base = (uid: string) => `/connect/approve/${encodeURIComponent(uid)}`

export const consentApi = {
  /** Binds the request to this browser session the first time, and says what it asks for. */
  details: (uid: string) => call<ConsentDetails>(`${base(uid)}/details`, { headers: { Accept: "application/json" } }),
  /**
   * Answers the request once; `redirectTo` is where the browser goes next, an address of this origin. An answer that
   * breaks this contract (no known outcome, another address) may hide a decision that was recorded, so it is lost.
   */
  decide: async (uid: string, approve: boolean, areas: AgentArea[]): Promise<Decision> => {
    const answer = await call<unknown>(`${base(uid)}/decision`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ approve, areas: approve ? areas : [] }),
    })
    const decision = decisionOf(answer, window.location.origin)
    if (!decision) throw new ConsentError("lost")
    return decision
  },
}

export type Decision = { outcome: "approved" | "denied"; redirectTo?: string }

/** The decision API's answer as its contract has it, or null: a known outcome, and no address or one of `origin`. */
export function decisionOf(answer: unknown, origin: string): Decision | null {
  if (typeof answer !== "object" || answer === null) return null
  const { outcome, redirectTo } = answer as { outcome?: unknown; redirectTo?: unknown }
  if (outcome !== "approved" && outcome !== "denied") return null
  if (redirectTo === undefined) return { outcome }
  if (typeof redirectTo !== "string" || sameOrigin(redirectTo, origin) === null) return null
  return { outcome, redirectTo }
}

/** Only an address of this origin is followed: the server answers the authorization server's own resume address. */
export function sameOrigin(address: string | undefined, origin: string): string | null {
  if (!address) return null
  const url = URL.parse(address, origin)
  return url && url.origin === origin && (url.protocol === "https:" || url.protocol === "http:") ? url.href : null
}
