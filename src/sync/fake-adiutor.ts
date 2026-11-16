// For the sync's tests only: a strict stand-in for Adiutor's authorization server and its agent REST channel, on
// 127.0.0.1. Like Adiutor it rotates refresh tokens and ends the whole grant when a spent one comes back, checks the
// token, the policy revision and the declared kind before a push runs, and answers the reserved refusals. Every token
// and code is made with randomBytes per run.

import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

const id = () => randomBytes(24).toString("base64url")
const SYNC_ROUTES = ["/api/v1/sync/t3", "/api/v1/sync/security"]
const CHECKIN = "/api/v1/sync/checkin"

export type Push = { path: string; body: unknown; policy?: string; kind?: string; auth?: string }

export async function startFakeAdiutor() {
  const s = {
    issuer: "",
    revision: randomBytes(8).toString("hex"),
    /** The scope the owner grants on the next approval (the areas ticked). */
    grantScope: "sync",
    devices: new Map<string, { state: "pending" | "approved" | "denied" | "used"; scope: string; label?: string }>(),
    grants: new Map<string, { alive: boolean; scope: string }>(),
    refresh: new Map<string, { grant: string; consumed: boolean }>(),
    access: new Map<string, { grant: string; exp: number }>(),
    counts: { device: 0, poll: 0, refresh: 0, reuse: 0, revoke: 0, listing: 0 },
    last: {} as { label?: string; scope?: string; resource?: string; clientId?: string },
    pushes: [] as Push[],
    /** Refusals before the next pushes run, in order: "invalid_token", "busy", "policy_changed". */
    beforePush: [] as string[],
    /** What happens after the next pushes ran, in order: "drop" (no answer), or a status to answer with. */
    afterPush: [] as Array<"drop" | number>,
    dropNextRefresh: false,
    dropNextPoll: false,
    /** The next revocation runs, and its answer is lost. */
    dropNextRevoke: false,
    /** The outcome the next pushes that run answer with, in order (succeeded when empty), as Adiutor's sync does. */
    pushOutcome: [] as Array<"succeeded" | "partial" | "failed">,
    listingStatus: 0,
    /** Whether the listing has the check-in (false: an Adiutor from before it). */
    offersCheckin: true,
    /** The check-ins that ran, their bodies in order. */
    checkins: [] as unknown[],
    /** The claim the next check-ins answer (a request id), or null. */
    claim: null as string | null,
    /** The next check-ins' answers wait for these, in order: an answer that arrives late. */
    checkinGates: [] as Promise<void>[],
    /** What happens after the next check-ins ran, in order: "drop" (no answer), or a status to answer with. */
    afterCheckin: [] as Array<"drop" | number>,
    /** What happens to the next listings, in order: "drop" (no answer) or "busy" (429 busy). */
    beforeListing: [] as Array<"drop" | "busy">,
    approve() {
      const d = [...s.devices.values()].at(-1)
      if (d) d.state = "approved"
    },
    deny() {
      const d = [...s.devices.values()].at(-1)
      if (d) d.state = "denied"
    },
    expireAccessTokens() {
      for (const a of s.access.values()) a.exp = 0
    },
    endAllGrants() {
      for (const g of s.grants.values()) g.alive = false
    },
    aliveGrants: () => [...s.grants.values()].filter((g) => g.alive).length,
    /** Every secret it handed out, to check that none shows up in the output. */
    secrets: () => [...s.refresh.keys(), ...s.access.keys(), ...s.devices.keys()],
    close: async () => {},
  }
  const issue = (grant: string) => {
    const refresh = id()
    const access = id()
    s.refresh.set(refresh, { grant, consumed: false })
    s.access.set(access, { grant, exp: Date.now() + 900_000 })
    const scope = s.grants.get(grant)?.scope ?? ""
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 900, scope }
  }

  const server: Server = createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const url = new URL(req.url ?? "/", s.issuer)
    const form = Object.fromEntries(new URLSearchParams(raw))
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers })
      res.end(JSON.stringify(body))
    }
    const drop = () => req.socket.destroy()

    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server")
      return send(200, { issuer: s.issuer, token_endpoint: `${s.issuer}/oauth/token` })
    if (req.method === "POST" && url.pathname === "/oauth/device") {
      s.counts.device++
      s.last = { label: form.client_label, scope: form.scope, resource: form.resource, clientId: form.client_id }
      if (form.client_id !== "adiutor-agent") return send(400, { error: "invalid_client" })
      const code = id()
      const userCode = `${randomBytes(2).toString("hex").toUpperCase()}${randomBytes(2).toString("hex").toUpperCase()}`
      s.devices.set(code, {
        state: "pending",
        scope: form.scope ?? "",
        ...(form.client_label ? { label: form.client_label } : {}),
      })
      return send(200, {
        device_code: code,
        user_code: userCode,
        verification_uri: `${s.issuer}/connect/code`,
        verification_uri_complete: `${s.issuer}/connect/code?user_code=${userCode}`,
        expires_in: 600,
        interval: 5,
      })
    }
    if (req.method === "POST" && url.pathname === "/oauth/token") {
      if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        s.counts.poll++
        const d = s.devices.get(form.device_code ?? "")
        if (!d) return send(400, { error: "invalid_grant" })
        if (d.state === "pending") return send(400, { error: "authorization_pending" })
        if (d.state === "denied") return send(400, { error: "access_denied" })
        if (d.state === "used") {
          s.counts.reuse++
          return send(400, { error: "invalid_grant" })
        }
        d.state = "used"
        const grant = id()
        s.grants.set(grant, { alive: true, scope: s.grantScope })
        const tokens = issue(grant)
        if (s.dropNextPoll) {
          s.dropNextPoll = false
          return drop()
        }
        return send(200, tokens)
      }
      if (form.grant_type === "refresh_token") {
        s.counts.refresh++
        const t = s.refresh.get(form.refresh_token ?? "")
        if (!t) return send(400, { error: "invalid_grant" })
        if (t.consumed) {
          s.counts.reuse++
          const g = s.grants.get(t.grant)
          if (g) g.alive = false
          return send(400, { error: "invalid_grant" })
        }
        if (!s.grants.get(t.grant)?.alive) return send(400, { error: "invalid_grant" })
        t.consumed = true
        const tokens = issue(t.grant)
        if (s.dropNextRefresh) {
          s.dropNextRefresh = false
          return drop()
        }
        return send(200, tokens)
      }
      return send(400, { error: "unsupported_grant_type" })
    }
    if (req.method === "POST" && url.pathname === "/oauth/revoke") {
      s.counts.revoke++
      const t = s.refresh.get(form.token ?? "")
      const g = t ? s.grants.get(t.grant) : undefined
      if (g) g.alive = false
      if (s.dropNextRevoke) {
        s.dropNextRevoke = false
        return drop()
      }
      return send(200, {})
    }
    if (url.pathname.startsWith("/api/v1/")) {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "")
      const a = s.access.get(bearer)
      const grant = a ? s.grants.get(a.grant) : undefined
      if (!a || a.exp < Date.now() || !grant?.alive)
        return send(
          401,
          { error: "invalid_token", message: "The token is not valid here." },
          {
            "www-authenticate": `Bearer resource_metadata="${s.issuer}/.well-known/oauth-protected-resource/api/v1", error="invalid_token"`,
          },
        )
      if (req.method === "GET" && url.pathname === "/api/v1/agent/endpoints") {
        s.counts.listing++
        const next = s.beforeListing.shift()
        if (next === "drop") return drop()
        if (next === "busy") return send(429, { error: "busy", message: "Busy." })
        if (s.listingStatus) return send(s.listingStatus, { error: "server_error" })
        const routes = [...SYNC_ROUTES, ...(s.offersCheckin ? [CHECKIN] : [])]
        const endpoints = grant.scope.split(" ").includes("sync")
          ? routes.map((path) => ({ method: "POST", path, kind: "act", area: "sync", description: "" }))
          : []
        return send(200, { endpoints, count: endpoints.length, revision: s.revision })
      }
      if (req.method === "POST" && SYNC_ROUTES.includes(url.pathname)) {
        const before = s.beforePush.shift()
        if (before === "invalid_token")
          return send(401, { error: "invalid_token" }, { "www-authenticate": 'Bearer error="invalid_token"' })
        if (before === "busy") return send(429, { error: "busy", message: "Busy." })
        const policy = req.headers["x-adiutor-policy"]
        const kind = req.headers["x-adiutor-kind"]
        if (before === "policy_changed" || policy !== s.revision || kind !== "act")
          return send(409, { error: "policy_changed", message: "Run endpoints again." })
        if (!grant.scope.split(" ").includes("sync"))
          return send(403, { error: "area_not_granted", message: "Not granted." })
        let body: unknown = raw
        try {
          body = JSON.parse(raw)
        } catch {}
        s.pushes.push({
          path: url.pathname,
          body,
          ...(typeof policy === "string" ? { policy } : {}),
          ...(typeof kind === "string" ? { kind } : {}),
          ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
        })
        const after = s.afterPush.shift()
        if (after === "drop") return drop()
        if (typeof after === "number") return send(after, { error: "internal_error", message: "Something went wrong." })
        return send(200, { data: { outcome: s.pushOutcome.shift() ?? "succeeded", counts: {} } })
      }
      if (req.method === "POST" && url.pathname === CHECKIN && s.offersCheckin) {
        if (req.headers["x-adiutor-policy"] !== s.revision || req.headers["x-adiutor-kind"] !== "act")
          return send(409, { error: "policy_changed", message: "Run endpoints again." })
        if (!grant.scope.split(" ").includes("sync"))
          return send(403, { error: "area_not_granted", message: "Not granted." })
        s.checkins.push(JSON.parse(raw))
        // The answer is decided when the check-in arrives, as Adiutor's is, and may be held back.
        const claim = s.claim
        const gate = s.checkinGates.shift()
        if (gate) await gate
        const after = s.afterCheckin.shift()
        if (after === "drop") return drop()
        if (typeof after === "number") return send(after, { error: "validation_failed", message: "Not valid." })
        const now = Date.now()
        return send(200, {
          data: {
            claim: claim
              ? {
                  requestId: claim,
                  claimedAt: new Date(now).toISOString(),
                  leaseUntil: new Date(now + 600_000).toISOString(),
                }
              : null,
          },
        })
      }
      return send(403, { error: "forbidden", message: "Agents cannot make this call." })
    }
    send(404, { error: "not_found" })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  s.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  s.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return s
}

export type FakeAdiutor = Awaited<ReturnType<typeof startFakeAdiutor>>
