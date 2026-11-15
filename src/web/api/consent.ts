// The consent page's API (docs/api.md, "The approval API"): under the request's own address, /connect/approve/<uid>,
// so the authorization server's cookie for that request comes along; outside /api/v1, so not through client.ts. Its
// errors are flat ({error, message}) and are turned into one stable reason the page shows in words.

import type { AgentArea } from "../../shared/enums.ts"
import { REQUEST_TIMEOUT_MS } from "./client.ts"
import type { ConsentDetails } from "./types.ts"

/**
 * Why the page cannot go on: sign in first, set up two-factor first, the request is no longer open (expired, answered,
 * or opened in another browser session), agents cannot connect here (agents off, or the public URL does not allow it,
 * or an Adiutor without agent access), refused, an answer the page cannot use, or no answer at all.
 */
export type ConsentFailure =
  | "unauthorized"
  | "totp_required"
  | "gone"
  | "not_configured"
  | "forbidden"
  | "validation"
  | "other"
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
  // An Adiutor without agent access answers this address with the app's own page: nothing to approve here.
  if (!(response.headers.get("content-type") ?? "").includes("application/json"))
    throw new ConsentError(response.ok ? "not_configured" : consentFailure(response.status, null))
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ConsentError("other")
  }
  if (!response.ok) throw new ConsentError(consentFailure(response.status, (body as { error?: unknown })?.error))
  return body as T
}

const base = (uid: string) => `/connect/approve/${encodeURIComponent(uid)}`

export const consentApi = {
  /** Binds the request to this browser session the first time, and says what it asks for. */
  details: (uid: string) => call<ConsentDetails>(`${base(uid)}/details`, { headers: { Accept: "application/json" } }),
  /** Answers the request once; `redirectTo` is where the browser goes next. */
  decide: (uid: string, approve: boolean, areas: AgentArea[]) =>
    call<{ outcome: "approved" | "denied"; redirectTo?: string }>(`${base(uid)}/decision`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ approve, areas: approve ? areas : [] }),
    }),
}

/** Only an address of this origin is followed: the server answers the authorization server's own resume address. */
export function sameOrigin(address: string | undefined, origin: string): string | null {
  if (!address) return null
  const url = URL.parse(address, origin)
  return url && url.origin === origin && (url.protocol === "https:" || url.protocol === "http:") ? url.href : null
}
