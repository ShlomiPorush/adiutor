// Better Auth's routes for the mock API (development and screenshots only; the production build drops it): the
// session, the browsers, the password, the backup codes, the agent keys and agent approvals, over the mock's state.
// The sign-in pages need the real server. Any password that is not empty is right: the mock holds none.

import { ENDED_OTHERS_KEY, endedOthers, mockState as state } from "./transport.ts"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const fail = (status: number, code: string, message: string) => json({ code, message }, status)

const letters = (n: number) =>
  Array.from(
    { length: n },
    () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 52)],
  ).join("")
const backupCodes = () => Array.from({ length: 10 }, () => `${letters(5)}-${letters(5)}`)

export async function mockAuthFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  await new Promise((resolve) => setTimeout(resolve, 120))
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href)
  const path = url.pathname.replace(/^\/api\/auth/, "")
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
  const sessions = endedOthers() ? state.sessions.slice(0, 1) : state.sessions
  const current = state.sessions[0]

  switch (path) {
    case "/get-session":
      return json({
        session: { ...current, token: "mock", userId: "owner" },
        user: { id: "owner", name: "owner", username: "owner", twoFactorEnabled: true },
      })
    case "/list-sessions":
      return json(sessions)
    case "/revoke-other-sessions":
      state.endedOthers = true
      try {
        sessionStorage.setItem(ENDED_OTHERS_KEY, "1")
      } catch {
        // Storage blocked: for this page only.
      }
      return json({ status: true })
    case "/revoke-sessions":
    case "/sign-out":
      return json({ success: true })
    case "/change-password":
      if (!body.currentPassword) return fail(400, "INVALID_PASSWORD", "Invalid password")
      return json({ token: "mock", user: { id: "owner" } })
    case "/two-factor/generate-backup-codes":
      if (!body.password) return fail(400, "INVALID_PASSWORD", "Invalid password")
      return json({ status: true, backupCodes: backupCodes() })
    case "/two-factor/disable":
      if (!body.password) return fail(400, "INVALID_PASSWORD", "Invalid password")
      return json({ status: true })
    case "/api-key/list":
      return json({ apiKeys: state.agentKeys, total: state.agentKeys.length })
    case "/revoke-session":
      state.sessions = state.sessions.filter((s) => s.token !== body.token)
      return json({ status: true })
    // An agent approval: any code of 8 letters and digits is waiting until this page answers it.
    case "/device": {
      const userCode = url.searchParams.get("user_code") ?? ""
      if (!/^[A-Z0-9]{8}$/.test(userCode))
        return json({ error: "invalid_request", error_description: "Invalid user code" }, 400)
      return json({ user_code: userCode, status: "pending", client_id: "mikud-connect" })
    }
    case "/device/approve":
    case "/device/deny":
      return json({ success: true })
    case "/api-key/delete":
      state.agentKeys = state.agentKeys.filter((k) => k.id !== body.keyId)
      return json({ success: true })
    default:
      return fail(404, "NOT_FOUND", "The mock does not answer this route; use the real server.")
  }
}
