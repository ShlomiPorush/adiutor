// Sends one payload to the Mikud API with the agent token. The answer is treated as opaque JSON to
// print. Redirects are refused, so the token is only ever sent to the configured URL.

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type PostResult = {
  ok: boolean
  status?: number
  /** The parsed JSON answer, or its text when it is not JSON. */
  body?: unknown
  /** Why the request failed before an answer arrived. Never holds the token. */
  error?: string
}

export async function postJson(
  fetchImpl: FetchLike,
  baseUrl: string,
  path: string,
  token: string,
  payload: unknown,
  timeoutMs: number,
): Promise<PostResult> {
  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const err = error as Error & { cause?: { code?: string } }
    if (err.name === "TimeoutError") return { ok: false, error: `no answer within ${Math.round(timeoutMs / 1000)} s` }
    const code = err.cause?.code
    return { ok: false, error: code ? `cannot reach the server (${code})` : "cannot reach the server" }
  }
  const text = await response.text().catch(() => "")
  let body: unknown = text
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text.length > 500 ? `${text.slice(0, 500)}...` : text
  }
  return { ok: response.ok, status: response.status, body }
}
