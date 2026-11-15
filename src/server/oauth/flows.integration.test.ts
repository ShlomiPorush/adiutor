import { eq, isNull } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { agentConnections, agentConsent, agentState, audit, oauthStore } from "../db/schema.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import {
  agentCall,
  browserCall,
  connectBrowser,
  connectWithCode,
  httpBrowser,
  type OAuthHarness,
  oauthHarness,
  ownerBy,
  pkce,
  pollDevice,
  refresh,
  register,
  uidOf,
} from "../testing/oauth.ts"
import { CLI_CLIENT_ID } from "./provider.ts"

/*
 * The authorization server as agents and the owner drive it over HTTP (testing.md, OAuth): discovery, registration,
 * authorize, the device flow, tokens bound to one resource, rotation, reuse, revocation and lifetimes.
 */

let t: TestDatabase
let h: OAuthHarness

beforeAll(async () => {
  t = await createTestDatabase("oauth_flows")
  h = await oauthHarness(t)
})
afterAll(async () => {
  await h?.close()
  await t?.close()
})
afterEach(() => {
  vi.useRealTimers()
})

const live = async () => t.ctx.db.select().from(agentConnections).where(isNull(agentConnections.endedAt))
const connectionOf = async (grantId: string) =>
  (await t.ctx.db.select().from(agentConnections).where(eq(agentConnections.grantId, grantId)))[0]

describe("discovery", () => {
  it("publishes the authorization server's metadata with the exact issuer, S256, public clients and no DPoP", async () => {
    const meta = await agentCall(h.issuer, "/.well-known/oauth-authorization-server")
    expect(meta.status).toBe(200)
    expect(meta.body).toMatchObject({
      issuer: h.issuer,
      authorization_endpoint: `${h.issuer}/oauth/authorize`,
      token_endpoint: `${h.issuer}/oauth/token`,
      device_authorization_endpoint: `${h.issuer}/oauth/device`,
      registration_endpoint: `${h.issuer}/oauth/register`,
      revocation_endpoint: `${h.issuer}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      response_types_supported: ["code"],
      authorization_response_iss_parameter_supported: true,
    })
    expect(meta.body.dpop_signing_alg_values_supported).toBeUndefined()
    expect(meta.body.userinfo_endpoint).toBeUndefined()
    expect(meta.body.end_session_endpoint).toBeUndefined()
    expect(meta.body.pushed_authorization_request_endpoint).toBeUndefined()
    expect(meta.body.introspection_endpoint).toBeUndefined()
    // The security headers set on the Node response reach the library's answers.
    expect(meta.headers.get("x-frame-options")).toBe("DENY")
    expect(meta.headers.get("referrer-policy")).toBe("no-referrer")
    expect(meta.headers.get("x-content-type-options")).toBe("nosniff")
    expect(meta.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    // Without the proxy (an http issuer), forwarded headers are not read: the URLs stay the issuer's.
    const forwarded = await agentCall(h.issuer, "/.well-known/oauth-authorization-server", {
      headers: { "x-forwarded-host": "evil.example.com", "x-forwarded-proto": "https" },
    })
    expect(forwarded.body.token_endpoint).toBe(`${h.issuer}/oauth/token`)
  })

  it("serves an https issuer behind the proxy: the forwarded host names it, another host is refused, cookies are Secure", async () => {
    const other = await createTestDatabase("oauth_https")
    const https = await oauthHarness(other, { publicUrl: () => "https://adiutor.example.com" })
    try {
      const forwarded = { "x-forwarded-host": "adiutor.example.com", "x-forwarded-proto": "https" }
      const meta = await agentCall(https.issuer, "/.well-known/oauth-authorization-server", { headers: forwarded })
      expect(meta.status).toBe(200)
      expect(meta.body).toMatchObject({
        issuer: "https://adiutor.example.com",
        token_endpoint: "https://adiutor.example.com/oauth/token",
      })
      expect((await agentCall(https.issuer, "/.well-known/oauth-authorization-server")).status).toBe(421)
      const elsewhere = { ...forwarded, "x-forwarded-host": "evil.example.com" }
      expect((await agentCall(https.issuer, "/oauth/token", { headers: elsewhere })).status).toBe(421)
      const page = await agentCall(https.issuer, "/connect/code", { headers: forwarded })
      expect(page.status).toBe(200)
      const cookies = page.headers.getSetCookie()
      expect(cookies.length).toBeGreaterThan(0)
      for (const cookie of cookies) expect(cookie.toLowerCase()).toContain("secure")
    } finally {
      await https.close()
      await other.close()
    }
  })

  it("publishes only the public half of the installation's own Ed25519 key, never the library's development keys", async () => {
    const jwks = await agentCall(h.issuer, "/oauth/jwks")
    expect(jwks.status).toBe(200)
    expect(jwks.body.keys).toHaveLength(1)
    expect(jwks.body.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", use: "sig" })
    expect(jwks.body.keys[0].d).toBeUndefined()
    // Stored encrypted, never in clear.
    const [state] = await t.ctx.db.select().from(agentState)
    expect(state?.signingKeyEnc).toMatch(/^v1\./)
    expect(state?.signingKeyEnc).not.toContain(jwks.body.keys[0].x)
  })

  it("serves both protected resource documents and the bare one for MCP, never cached", async () => {
    for (const [path, resource, scopes] of [
      ["/.well-known/oauth-protected-resource", `${h.issuer}/mcp`, ["read", "write"]],
      ["/.well-known/oauth-protected-resource/mcp", `${h.issuer}/mcp`, ["read", "write"]],
      ["/.well-known/oauth-protected-resource/api/v1", `${h.issuer}/api/v1`, ["read", "write", "sync"]],
    ] as const) {
      const doc = await agentCall(h.issuer, path)
      expect(doc.status, path).toBe(200)
      expect(doc.headers.get("cache-control")).toBe("no-store")
      expect(doc.body).toEqual({
        resource,
        authorization_servers: [h.issuer],
        scopes_supported: scopes,
        bearer_methods_supported: ["header"],
        resource_name: expect.any(String),
      })
    }
  })

  it("passes only the library's exact addresses, and refuses another host", async () => {
    expect((await agentCall(h.issuer, "/oauth/token/")).status).toBe(404)
    expect((await agentCall(h.issuer, "/OAUTH/token")).status).toBe(404)
    expect((await agentCall(h.issuer, "/oauth/userinfo")).status).toBe(404)
    expect((await agentCall(h.issuer, "/.well-known/openid-configuration")).status).toBe(404)
    const other = h.issuer.replace("127.0.0.1", "localhost")
    expect((await agentCall(other, "/.well-known/oauth-authorization-server")).status).toBe(421)
  })
})

describe("registration", () => {
  it("registers public clients, drops the scopes they ask for, and makes a loopback client native", async () => {
    const ok = await register(h.issuer, {
      redirect_uris: ["http://127.0.0.1:3000/cb", "https://app.example.com/cb"],
      scope: "read write sync",
    })
    expect(ok.status).toBe(201)
    expect(ok.body.scope).toBeUndefined()
    expect(ok.body.token_endpoint_auth_method).toBe("none")
    expect(ok.body.application_type).toBe("native")
    expect(ok.body.registration_access_token).toBeUndefined()
    const web = await register(h.issuer, { redirect_uris: ["https://app.example.com/cb"] })
    expect(web.body.application_type).toBe("web")
    const app = await register(h.issuer, { redirect_uris: ["com.example.agent:/callback"] })
    expect(app.status).toBe(201)
  })

  it("refuses each bad redirect shape, a secret, and metadata that would make it fetch", async () => {
    for (const redirect_uris of [
      ["http://app.example.com/cb"],
      [`http://${[127, 0, 0, 2].join(".")}:3000/cb`],
      ["https://app.example.com/cb#frag"],
      ["https://user:pw@app.example.com/cb"],
      ["myapp:/cb"],
      [],
      Array.from({ length: 6 }, (_, i) => `https://app.example.com/${i}`),
    ]) {
      const bad = await register(h.issuer, { redirect_uris })
      expect(bad.status, JSON.stringify(redirect_uris)).toBe(400)
      expect(bad.body.error).toBe("invalid_client_metadata")
    }
    for (const extra of [
      { token_endpoint_auth_method: "client_secret_basic" },
      { jwks_uri: "https://app.example.com/jwks" },
      { grant_types: ["client_credentials"] },
      { response_types: ["code id_token"] },
    ]) {
      const bad = await register(h.issuer, extra)
      expect(bad.status, JSON.stringify(extra)).toBe(400)
    }
  })
})

describe("authorize", () => {
  async function authorize(params: Record<string, string>) {
    const reg = await register(h.issuer, { redirect_uris: ["http://127.0.0.1:41000/cb"] })
    const { challenge } = pkce()
    const query = new URLSearchParams({
      client_id: reg.body.client_id,
      redirect_uri: "http://127.0.0.1:41000/cb",
      response_type: "code",
      scope: "read",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${h.issuer}/mcp`,
      ...params,
    })
    for (const [k, v] of Object.entries(params)) if (v === "") query.delete(k)
    return browserCall(h.owner, `/oauth/authorize?${query}`)
  }

  it("refuses a request without PKCE, with plain or with a short challenge (sent back to the registered address)", async () => {
    const cases: Record<string, string>[] = [
      { code_challenge: "", code_challenge_method: "" },
      { code_challenge_method: "plain" },
      { code_challenge: "short" },
    ]
    for (const params of cases) {
      const res = await authorize(params)
      // D1b: the library redirects these errors to the registered redirect URI (accepted gap).
      expect(res.status, JSON.stringify(params)).toBe(303)
      expect(res.location).toMatch(/^http:\/\/127\.0\.0\.1:41000\/cb\?error=invalid_request/)
    }
  })

  it("shows an unregistered redirect in the browser, never redirects there, and accepts loopback on any port", async () => {
    const wrong = await authorize({ redirect_uri: "http://127.0.0.1:41000/other" })
    expect(wrong.status).toBe(400)
    expect(wrong.location).toBeNull()
    const host = await authorize({ redirect_uri: "https://evil.example.com/cb" })
    expect(host.status).toBe(400)
    const missing = await authorize({ redirect_uri: "" })
    expect(missing.status).toBe(400)
    expect(missing.location).toBeNull()
    const port = await authorize({ redirect_uri: "http://127.0.0.1:52999/cb" })
    expect(uidOf(port.location)).not.toBe("")
  })

  it("refuses a request that names both resources", async () => {
    const reg = await register(h.issuer, { redirect_uris: ["http://127.0.0.1:41000/cb"] })
    const { challenge } = pkce()
    const query = new URLSearchParams({
      client_id: reg.body.client_id,
      redirect_uri: "http://127.0.0.1:41000/cb",
      response_type: "code",
      scope: "read",
      code_challenge: challenge,
      code_challenge_method: "S256",
    })
    query.append("resource", `${h.issuer}/mcp`)
    query.append("resource", `${h.issuer}/api/v1`)
    const res = await browserCall(h.owner, `/oauth/authorize?${query}`)
    expect(res.location).toMatch(/error=invalid_target/)
    const device = await agentCall(h.issuer, "/oauth/device", {
      form: { client_id: CLI_CLIENT_ID, scope: "read", resource: [`${h.issuer}/mcp`, `${h.issuer}/api/v1`] },
    })
    expect(device.status).toBe(400)
    expect(device.body.error).toBe("invalid_target")
  })

  it("asks the owner again for a second request in the same browser, even with no scope", async () => {
    await connectBrowser(h)
    const reg = await register(h.issuer, { redirect_uris: ["https://app.example.com/cb"] })
    const { challenge } = pkce()
    const query = new URLSearchParams({
      client_id: reg.body.client_id,
      redirect_uri: "https://app.example.com/cb",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${h.issuer}/mcp`,
    })
    const res = await browserCall(h.owner, `/oauth/authorize?${query}`)
    expect(uidOf(res.location)).not.toBe("")
  })
})

describe("an MCP client through the browser", () => {
  it("sends the client back with a code, its state and the issuer, and gives a token for /mcp only", async () => {
    const c = await connectBrowser(h, { scope: "read write sync openid offline_access", areas: ["read"] })
    expect(c.consent.details.body).toMatchObject({ via: "browser", resource: "mcp", areas: ["read", "write"] })
    const back = new URL(c.back.location ?? "")
    expect(back.searchParams.get("state")).toBe("s-1")
    expect(back.searchParams.get("iss")).toBe(h.issuer)
    expect(c.tokens.status).toBe(200)
    expect(c.tokens.body).toMatchObject({ token_type: "Bearer", expires_in: 900, scope: "read" })
    expect(c.tokens.body.refresh_token).toBeTruthy()
    expect(c.tokens.body.id_token).toBeUndefined()
    const at = c.tokens.body.access_token
    expect((await h.access.checkToken(at, "mcp")).ok).toBe(true)
    expect((await h.access.checkToken(at, "rest")).ok).toBe(false)
  })

  it("rotates the refresh token, keeps the resource and refuses a wider scope", async () => {
    const c = await connectBrowser(h, { areas: ["read"] })
    const next = await refresh(h.issuer, c.clientId, c.tokens.body.refresh_token)
    expect(next.status).toBe(200)
    expect(next.body.refresh_token).not.toBe(c.tokens.body.refresh_token)
    expect((await h.access.checkToken(next.body.access_token, "mcp")).ok).toBe(true)
    const other = await agentCall(h.issuer, "/oauth/token", {
      form: {
        grant_type: "refresh_token",
        refresh_token: next.body.refresh_token,
        client_id: c.clientId,
        resource: `${h.issuer}/api/v1`,
      },
    })
    expect(other.status).toBe(400)
    const wider = await agentCall(h.issuer, "/oauth/token", {
      form: {
        grant_type: "refresh_token",
        refresh_token: next.body.refresh_token,
        client_id: c.clientId,
        scope: "read write",
      },
    })
    expect(wider.status).toBe(400)
  })

  it("ends the grant and its connection when a spent refresh token comes back", async () => {
    const c = await connectBrowser(h)
    const next = await refresh(h.issuer, c.clientId, c.tokens.body.refresh_token)
    const replay = await refresh(h.issuer, c.clientId, c.tokens.body.refresh_token)
    expect(replay.status).toBe(400)
    expect((await h.access.checkToken(next.body.access_token, "mcp")).ok).toBe(false)
    expect((await refresh(h.issuer, c.clientId, next.body.refresh_token)).status).toBe(400)
    await vi.waitFor(async () => {
      const rows = await t.ctx.db.select().from(agentConnections).where(eq(agentConnections.clientId, c.clientId))
      expect(rows[0]?.endReason).toBe("refresh_reused")
    })
  })

  it("ends the grant when an authorization code is exchanged twice", async () => {
    const c = await connectBrowser(h)
    const again = await agentCall(h.issuer, "/oauth/token", {
      form: {
        grant_type: "authorization_code",
        code: c.code,
        code_verifier: c.verifier,
        client_id: c.clientId,
        redirect_uri: c.redirect,
        resource: c.resource,
      },
    })
    expect(again.status).toBe(400)
    expect((await h.access.checkToken(c.tokens.body.access_token, "mcp")).ok).toBe(false)
    await vi.waitFor(async () => {
      const rows = await t.ctx.db.select().from(agentConnections).where(eq(agentConnections.clientId, c.clientId))
      expect(rows[0]?.endReason).toBe("code_reused")
    })
  })

  it("ends the whole connection when the agent revokes even its access token", async () => {
    const c = await connectBrowser(h)
    const res = await agentCall(h.issuer, "/oauth/revoke", {
      form: { token: c.tokens.body.access_token, client_id: c.clientId },
    })
    expect(res.status).toBe(200)
    expect((await refresh(h.issuer, c.clientId, c.tokens.body.refresh_token)).status).toBe(400)
    await vi.waitFor(async () => {
      const rows = await t.ctx.db.select().from(agentConnections).where(eq(agentConnections.clientId, c.clientId))
      expect(rows[0]).toMatchObject({ endReason: "disconnected", endedBy: "agent" })
    })
    // Unknown tokens: still 200.
    expect(
      (await agentCall(h.issuer, "/oauth/revoke", { form: { token: "x".repeat(43), client_id: c.clientId } })).status,
    ).toBe(200)
  })

  it("issues a plain Bearer token for a request that carries a DPoP proof", async () => {
    const reg = await register(h.issuer)
    expect(reg.status).toBe(201)
    const c = await connectBrowser(h)
    const next = await agentCall(h.issuer, "/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: c.tokens.body.refresh_token, client_id: c.clientId },
      headers: { dpop: "eyJhbGciOiJFUzI1NiJ9.e30.c2ln" },
    })
    expect(next.status).toBe(200)
    expect(next.body.token_type).toBe("Bearer")
  })
})

describe("a script with a code", () => {
  it("waits for the owner, then gets tokens for the REST API with the areas ticked", async () => {
    const c = await connectWithCode(h, { scope: "read write sync", label: "Laptop sync", areas: ["sync"] })
    expect(c.device.body.verification_uri_complete).toBe(
      `${h.issuer}/connect/code?user_code=${encodeURIComponent(c.device.body.user_code)}`,
    )
    expect(c.device.body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(c.device.body.expires_in).toBe(600)
    expect(c.pending.body.error).toBe("authorization_pending")
    expect(c.consent.details.body).toMatchObject({
      via: "code",
      resource: "rest",
      areas: ["read", "write", "sync"],
      client: { name: "Laptop sync", builtIn: true },
    })
    expect(c.tokens.status).toBe(200)
    expect(c.tokens.body.scope).toBe("sync")
    expect(c.tokens.body.refresh_token).toBeTruthy()
    const check = await h.access.checkToken(c.tokens.body.access_token, "rest")
    expect(check).toMatchObject({
      ok: true,
      areas: ["sync"],
      connection: { name: "Laptop sync", connectedVia: "code" },
    })
    expect((await h.access.checkToken(c.tokens.body.access_token, "mcp")).ok).toBe(false)
  })

  it("opens the code page from the link the agent shows, with the code filled in, through the library's own form", async () => {
    const device = await agentCall(h.issuer, "/oauth/device", { form: { client_id: CLI_CLIENT_ID, scope: "read" } })
    const link = new URL(device.body.verification_uri_complete)
    const page = await browserCall(h.owner, `${link.pathname}${link.search}`)
    expect(page.status).toBe(200)
    // The library's auto-submit script runs only by the hash it adds to the Content-Security-Policy.
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/)
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(page.text)?.[1] ?? ""
    const code = /name="user_code" value="([^"]+)"/.exec(page.text)?.[1] ?? ""
    expect(code).toBe(device.body.user_code)
    const confirm = await browserCall(h.owner, "/connect/code", { form: { xsrf, user_code: code } })
    expect(confirm.text).toContain("Does your agent show this code?")
    expect(confirm.text).toContain(device.body.user_code)
  })

  it("names a script with a label that is not plain text Script", async () => {
    const c = await connectWithCode(h, { label: "bad\u202ename" })
    expect(c.consent.details.body.client.name).toBe("Script")
  })

  it("tells the script when the owner denies it, and leaves no connection", async () => {
    const before = (await live()).length
    const device = await agentCall(h.issuer, "/oauth/device", { form: { client_id: CLI_CLIENT_ID, scope: "read" } })
    const { confirmCode, answerConsent } = await import("../testing/oauth.ts")
    const uid = await confirmCode(h.owner, device.body.user_code)
    const { decision } = await answerConsent(h.owner, uid, { approve: false })
    expect(decision.body.outcome).toBe("denied")
    await browserCall(h.owner, decision.body.redirectTo)
    const res = await pollDevice(h.issuer, device.body.device_code)
    expect(res.body.error).toBe("access_denied")
    expect((await live()).length).toBe(before)
  })

  it("ends the grant when a device code is collected twice", async () => {
    const c = await connectWithCode(h)
    const again = await pollDevice(h.issuer, c.device.body.device_code)
    expect(again.status).toBe(400)
    expect((await h.access.checkToken(c.tokens.body.access_token, "rest")).ok).toBe(false)
  })

  it("gives two scripts of the same client two separate connections", async () => {
    const one = await connectWithCode(h)
    const two = await connectWithCode(h)
    const a = await h.access.checkToken(one.tokens.body.access_token, "rest")
    const b = await h.access.checkToken(two.tokens.body.access_token, "rest")
    expect(a.ok && b.ok && a.connection.id !== b.connection.id).toBe(true)
  })
})

describe("what the store holds", () => {
  it("keeps no issued access token, refresh token or code, and refuses what it stored when it is presented", async () => {
    const c = await connectBrowser(h)
    const next = await refresh(h.issuer, c.clientId, c.tokens.body.refresh_token)
    const rows = await t.ctx.db.select().from(oauthStore)
    const dump = JSON.stringify(rows)
    for (const value of [
      c.code,
      c.tokens.body.access_token,
      c.tokens.body.refresh_token,
      next.body.access_token,
      next.body.refresh_token,
    ])
      expect(dump).not.toContain(value)
    for (const row of rows.filter((r) => r.type === "AccessToken"))
      expect((await h.access.checkToken(row.id, "mcp")).ok).toBe(false)
  })

  it("records the generation each request began under", async () => {
    const device = await agentCall(h.issuer, "/oauth/device", { form: { client_id: CLI_CLIENT_ID, scope: "read" } })
    const { sha256 } = await import("./store.ts")
    const rows = await t.ctx.db
      .select()
      .from(agentConsent)
      .where(eq(agentConsent.key, `d:${sha256(device.body.device_code)}`))
    expect(rows).toHaveLength(1)
  })
})

describe("lifetimes", () => {
  it("keeps a connection in use past the library's default lifetimes, by Adiutor's clock", async () => {
    const c = await connectWithCode(h)
    let tokens = c.tokens.body
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() })
    for (let day = 0; day < 20; day += 5) {
      vi.setSystemTime(Date.now() + 5 * 86_400_000)
      const next = await refresh(h.issuer, CLI_CLIENT_ID, tokens.refresh_token)
      expect(next.status, `day ${day + 5}`).toBe(200)
      tokens = next.body
      expect((await h.access.checkToken(tokens.access_token, "rest", { use: true })).ok).toBe(true)
    }
  })

  it("never ends a connection on the access token's 15 minutes, which refuses the token itself", async () => {
    const c = await connectWithCode(h)
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 16 * 60_000 })
    expect((await h.access.checkToken(c.tokens.body.access_token, "rest")).ok).toBe(false)
    const next = await refresh(h.issuer, CLI_CLIENT_ID, c.tokens.body.refresh_token)
    expect(next.status).toBe(200)
  })
})

describe("the audit", () => {
  it("records approvals and ends without any token or code", async () => {
    const c = await connectWithCode(h)
    const check = await h.access.checkToken(c.tokens.body.access_token, "rest")
    if (!check.ok) throw new Error("no connection")
    await h.access.disconnect(ownerBy, check.connection.id)
    expect((await connectionOf(check.connection.grantId))?.endReason).toBe("disconnected")
    const rows = await t.ctx.db.select().from(audit)
    const dump = JSON.stringify(rows)
    for (const value of [
      c.device.body.device_code,
      c.device.body.user_code,
      c.tokens.body.access_token,
      c.tokens.body.refresh_token,
    ])
      expect(dump).not.toContain(value)
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["agent.approve", "agent.end"]))
  })
})

describe("the owner's second browser", () => {
  it("cannot see or answer a request another browser opened", async () => {
    const device = await agentCall(h.issuer, "/oauth/device", { form: { client_id: CLI_CLIENT_ID, scope: "read" } })
    const { confirmCode } = await import("../testing/oauth.ts")
    const uid = await confirmCode(h.owner, device.body.user_code)
    const first = await browserCall(h.owner, `/connect/approve/${uid}/details`)
    expect(first.status).toBe(200)
    const other = httpBrowser(h.issuer)
    await other.signIn(h.ownerSecret)
    for (const [name, value] of h.owner.cookies) if (name.startsWith("_interaction")) other.cookies.set(name, value)
    expect((await browserCall(other, `/connect/approve/${uid}/details`)).status).toBe(410)
    const answer = await browserCall(other, `/connect/approve/${uid}/decision`, {
      json: { approve: true, areas: ["read"] },
    })
    expect(answer.status).toBe(410)
  })
})

beforeEach(async () => {
  await h.access.saveSettings(ownerBy, { enabled: true })
})
