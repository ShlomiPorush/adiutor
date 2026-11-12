// A stand-in for Mikud's agent approval (Better Auth's device authorization, api-key and revoke-session routes) and
// its /api/v1 routes, strict like the real ones: an approved code is redeemed once, a session token works until it is
// revoked, a key until it ends. Every code, token and key is generated here, new for every run. Tests drive it
// through its state and a few switches.
import { randomBytes, randomUUID } from "node:crypto"
import http from "node:http"

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const USER_CODE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const pick = (alphabet, n) => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join("")
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

/** A gate a test opens: requests wait at it until `open()`; `reached` resolves when the first one arrives. */
function gate() {
  let open
  let arrived
  const g = {
    opened: new Promise((resolve) => {
      open = resolve
    }),
    reached: new Promise((resolve) => {
      arrived = resolve
    }),
  }
  g.open = () => open()
  g.arrive = () => arrived()
  return g
}

export async function startFakeServer() {
  const s = {
    origin: "",
    devices: new Map(), // device_code -> {userCode, state: pending|approved|denied|used, expiresAt}
    sessions: new Map(), // token -> {alive, userAgent}
    keys: new Map(), // key -> {name, expiresIn, expiresAt, alive}
    writes: [], // the /api/v1 writes that landed
    requests: [], // {method, path, userAgent, authorization, agent}
    counts: { deviceCode: 0, deviceToken: 0, keyCreate: 0, revoke: 0, api: 0, apiWrites: 0 },
    interval: 1,
    expiresIn: 600,
    slowDownOnce: false,
    linkOrigin: null, // the approval link on another origin
    redirect: {}, // path -> Location answered with 302
    lose: { token: false, key: false, revoke: false, api: false }, // processed, then the connection is cut
    gates: {}, // token | key | api -> gate (waits before processing)
    revokeStatus: 200,
    apiStatus: null, // the next /api/v1 answer's status, after the write landed
    apiError: null, // {status, code, message} answered by every /api/v1 call
    apiDelayMs: 0, // a write lands and is answered only after this
  }

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString("utf8")
    const url = new URL(req.url, s.origin)
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {}
    const send = (status, value, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers })
      res.end(value === undefined ? "" : JSON.stringify(value))
    }
    const cut = () => req.socket.destroy()
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? ""
    s.requests.push({
      method: req.method,
      path: url.pathname,
      userAgent: req.headers["user-agent"] ?? "",
      authorization: req.headers.authorization ?? "",
      agent: req.headers["x-mikud-agent"] ?? null,
    })
    if (s.redirect[url.pathname]) return send(302, {}, { location: s.redirect[url.pathname] })

    if (req.method === "POST" && url.pathname === "/api/auth/device/code") {
      s.counts.deviceCode++
      if (body?.client_id !== "mikud-connect") return send(400, { error: "invalid_client" })
      const deviceCode = pick(LETTERS, 40)
      const userCode = pick(USER_CODE, 8)
      s.devices.set(deviceCode, { userCode, state: "pending", expiresAt: Date.now() + s.expiresIn * 1000 })
      const linkBase = s.linkOrigin ?? s.origin
      return send(200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${linkBase}/connect/device`,
        verification_uri_complete: `${linkBase}/connect/device?user_code=${userCode}`,
        expires_in: s.expiresIn,
        interval: s.interval,
      })
    }

    if (req.method === "POST" && url.pathname === "/api/auth/device/token") {
      s.counts.deviceToken++
      const g = s.gates.token
      if (g) {
        g.arrive()
        await g.opened
      }
      if (body?.grant_type !== DEVICE_GRANT || body?.client_id !== "mikud-connect")
        return send(400, { error: "invalid_request" })
      const d = s.devices.get(body.device_code)
      if (!d || d.state === "used")
        return send(400, { error: "invalid_grant", error_description: "Invalid device code" })
      if (d.expiresAt <= Date.now()) return send(400, { error: "expired_token" })
      if (s.slowDownOnce) {
        s.slowDownOnce = false
        return send(400, { error: "slow_down" })
      }
      if (d.state === "pending") return send(400, { error: "authorization_pending" })
      if (d.state === "denied") {
        d.state = "used"
        return send(400, { error: "access_denied" })
      }
      d.state = "used"
      const token = pick(LETTERS, 32)
      s.sessions.set(token, { alive: true, userAgent: req.headers["user-agent"] ?? "" })
      if (s.lose.token) {
        s.lose.token = false
        return cut()
      }
      return send(200, { access_token: token, token_type: "Bearer", expires_in: 2_592_000 })
    }

    if (req.method === "POST" && url.pathname === "/api/auth/api-key/create") {
      s.counts.keyCreate++
      const g = s.gates.key
      if (g) {
        g.arrive()
        await g.opened
      }
      if (!s.sessions.get(bearer)?.alive) return send(401, { code: "UNAUTHORIZED" })
      const name = String(body?.name ?? "")
      const expiresIn = Number(body?.expiresIn)
      if (name.length < 1 || name.length > 32) return send(400, { code: "INVALID_NAME_LENGTH" })
      if (!Number.isInteger(expiresIn) || expiresIn < 86_400 || expiresIn > 365 * 86_400)
        return send(400, { code: "EXPIRES_IN_IS_TOO_SMALL" })
      const key = `mkd_${pick(LETTERS, 64)}`
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
      s.keys.set(key, { name, expiresIn, expiresAt, alive: true })
      if (s.lose.key) {
        s.lose.key = false
        return cut()
      }
      return send(200, { id: randomUUID(), key, name, start: key.slice(0, 6), expiresAt })
    }

    if (req.method === "POST" && url.pathname === "/api/auth/revoke-session") {
      s.counts.revoke++
      const session = s.sessions.get(bearer)
      if (!session?.alive) return send(401, { code: "UNAUTHORIZED" })
      if (body?.token !== bearer) return send(403, { code: "OWN_SESSION_ONLY" })
      if (s.revokeStatus !== 200) return send(s.revokeStatus, { code: "FAILED" })
      session.alive = false
      if (s.lose.revoke) {
        s.lose.revoke = false
        return cut()
      }
      return send(200, { status: true })
    }

    if (url.pathname.startsWith("/api/v1/")) {
      s.counts.api++
      const k = s.keys.get(bearer)
      if (!k?.alive || Date.parse(k.expiresAt) <= Date.now())
        return send(401, { error: { code: "unauthorized", message: "The key is not valid." } })
      const g = s.gates.api
      if (g) {
        g.arrive()
        await g.opened
      }
      if (s.apiError) {
        const { status, code, message } = s.apiError
        return send(status, { error: { code, message } })
      }
      const write = req.method !== "GET"
      if (write) {
        s.counts.apiWrites++
        const land = () => s.writes.push({ method: req.method, path: url.pathname, body })
        if (s.apiDelayMs) {
          // The write lands late, after the client gave up waiting.
          await new Promise((resolve) => setTimeout(resolve, s.apiDelayMs))
        }
        land()
      }
      if (s.lose.api) {
        s.lose.api = false
        return cut()
      }
      if (s.apiStatus) {
        const status = s.apiStatus
        s.apiStatus = null
        return send(status, { error: { code: "bad_gateway", message: "The proxy did not get an answer." } })
      }
      // Mikud's envelope: {data}, and a page of notes with its cursor.
      const echo = {
        method: req.method,
        path: url.pathname,
        query: url.search,
        agent: req.headers["x-mikud-agent"] ?? null,
        body,
        writes: s.writes.length,
      }
      if (req.method === "GET" && url.pathname === "/api/v1/notes") return send(200, { data: echo, nextCursor: "page-2" })
      return send(write ? 201 : 200, { data: echo })
    }
    send(404, { error: { code: "not_found", message: "No such route." } })
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  s.port = server.address().port
  s.origin = `http://127.0.0.1:${s.port}`
  s.close = () =>
    new Promise((resolve) => {
      for (const g of Object.values(s.gates)) g?.open()
      server.closeAllConnections?.()
      server.close(resolve)
    })
  /** The owner approves (or denies) the latest code. */
  s.approve = () => {
    ;[...s.devices.values()].at(-1).state = "approved"
  }
  s.deny = () => {
    ;[...s.devices.values()].at(-1).state = "denied"
  }
  s.expire = () => {
    for (const d of s.devices.values()) d.expiresAt = 0
  }
  /** Holds the next requests of a route until the test opens the gate. */
  s.hold = (name) => {
    const g = gate()
    s.gates[name] = g
    return {
      reached: g.reached,
      open: () => {
        delete s.gates[name]
        g.open()
      },
    }
  }
  s.aliveSessions = () => [...s.sessions.values()].filter((x) => x.alive).length
  s.aliveKeys = () => [...s.keys.entries()].filter(([, k]) => k.alive)
  s.authRequests = () => s.requests.filter((r) => r.path.startsWith("/api/auth/"))
  /** Every secret it handed out, to check that none shows up where it must not. */
  s.secrets = () => ({
    deviceCodes: [...s.devices.keys()],
    sessions: [...s.sessions.keys()],
    keys: [...s.keys.keys()],
  })
  s.reset = () => {
    for (const map of [s.devices, s.sessions, s.keys]) map.clear()
    s.writes.length = 0
    s.requests.length = 0
    for (const k of Object.keys(s.counts)) s.counts[k] = 0
    Object.assign(s, {
      interval: 1,
      expiresIn: 600,
      slowDownOnce: false,
      linkOrigin: null,
      redirect: {},
      lose: { token: false, key: false, revoke: false, api: false },
      revokeStatus: 200,
      apiStatus: null,
      apiError: null,
      apiDelayMs: 0,
    })
    for (const g of Object.values(s.gates)) g?.open()
    s.gates = {}
  }
  return s
}
