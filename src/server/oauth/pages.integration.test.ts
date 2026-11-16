import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Language } from "../../shared/enums.ts"
import en from "../../shared/locales/en.json"
import he from "../../shared/locales/he.json"
import { createApp } from "../app.ts"
import { settings } from "../db/schema.ts"
import { getSettings } from "../services/admin.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import {
  type Answer,
  agentCall,
  browserCall,
  deviceRequest,
  type OAuthHarness,
  oauthHarness,
  ownerBy,
  pkce,
  pollDevice,
  register,
  uidOf,
  wideLimits,
} from "../testing/oauth.ts"
import { CONTENT_SECURITY_POLICY } from "../web.ts"
import { WindowLimit } from "./limits.ts"

/*
 * The library's own pages (the code page, the comparison, the done page, the error page) in the owner's language, and
 * the headers on every answer of the flow: the library's pages and redirects, the consent page served by the built UI,
 * and its API.
 */

const TEXTS = { en: en.agentPages, he: he.agentPages } as const
const escaped = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch)

let t: TestDatabase
let h: OAuthHarness
let webRoot: string

beforeAll(async () => {
  webRoot = await mkdtemp(join(tmpdir(), "adiutor-web-"))
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>the built UI</title>")
  t = await createTestDatabase("oauth_pages")
  h = await oauthHarness(t, { web: { root: webRoot } })
})
afterAll(async () => {
  await h?.close()
  await t?.close()
  if (webRoot) await rm(webRoot, { recursive: true, force: true })
})
beforeEach(async () => {
  await h.access.saveSettings(ownerBy, { enabled: true })
})

async function setLanguage(language: Language) {
  await getSettings(t.ctx.db)
  await t.ctx.db.update(settings).set({ language }).where(eq(settings.id, 1))
}

/** Every answer of the flow: never stored, never framed, no referrer. */
function expectFlowHeaders(answer: Answer, what: string) {
  expect(answer.headers.get("cache-control"), what).toBe("no-store")
  expect(answer.headers.get("x-frame-options"), what).toBe("DENY")
  expect(answer.headers.get("content-security-policy"), what).toContain("frame-ancestors 'none'")
  expect(answer.headers.get("referrer-policy"), what).toBe("no-referrer")
}

function expectPage(answer: Answer, language: Language, what: string) {
  expect(answer.headers.get("content-type"), what).toMatch(/^text\/html/)
  expect(answer.text, what).toContain(`<html lang="${language}" dir="${language === "he" ? "rtl" : "ltr"}">`)
  // No script of the page's own (the library's form carries none either).
  expect(answer.text, what).not.toMatch(/<script/i)
  expectFlowHeaders(answer, what)
}

const xsrfOf = (answer: Answer) => /name="xsrf" value="([^"]+)"/.exec(answer.text)?.[1] ?? ""

/** The code page, the code typed, then compared: every answer on the way. */
async function throughCode(label?: string) {
  const device = await deviceRequest(h.issuer, label ? { label } : {})
  const input = await browserCall(h.owner, "/connect/code")
  const xsrf = xsrfOf(input)
  const compare = await browserCall(h.owner, "/connect/code", { form: { xsrf, user_code: device.body.user_code } })
  return { device, input, xsrf, compare }
}

describe("the library's pages", () => {
  for (const language of ["en", "he"] as const) {
    const texts = TEXTS[language]
    it(`speak the owner's language (${language}) from the code to the done page, with the library's forms`, async () => {
      await setLanguage(language)
      const { device, input, xsrf, compare } = await throughCode("Laptop skill")
      expectPage(input, language, "code page")
      expect(input.text).toContain(escaped(texts.codeLead))
      expect(input.text).toContain('<form id="op.deviceInputForm"')
      expect(input.text).toContain('form="op.deviceInputForm"')

      expectPage(compare, language, "comparison")
      expect(compare.text).toContain(escaped(texts.confirmTitle))
      expect(compare.text).toContain(`<bdi dir="ltr">${device.body.user_code}</bdi>`)
      expect(compare.text).toContain('<bdi dir="auto">Laptop skill</bdi>')
      expect(compare.text).toContain(escaped(texts.nameTag))
      expect(compare.text).toContain('<form id="op.deviceConfirmForm"')

      const toConsent = await browserCall(h.owner, "/connect/code", {
        form: { xsrf, user_code: device.body.user_code, confirm: "yes" },
      })
      const uid = uidOf(toConsent.location)
      expect(uid).not.toBe("")
      expectFlowHeaders(toConsent, "redirect to the consent page")

      // The link the agent shows: the library's own page that posts the code on, with its script hash in the policy.
      const link = await browserCall(h.owner, `/connect/code?user_code=${encodeURIComponent(device.body.user_code)}`)
      expect(link.status).toBe(200)
      expectFlowHeaders(link, "the code link")

      const details = await browserCall(h.owner, `/connect/approve/${uid}/details`)
      const decision = await browserCall(h.owner, `/connect/approve/${uid}/decision`, {
        json: { approve: true, areas: details.body.areas },
      })
      expect(decision.status).toBe(200)
      const done = await browserCall(h.owner, String(decision.body.redirectTo))
      expectPage(done, language, "done page")
      expect(done.text).toContain(escaped(texts.doneTitle))
      expect((await pollDevice(h.issuer, device.body.device_code)).status).toBe(200)
    })

    it(`say in ${language} that a wrong code did not work, and keep the form`, async () => {
      await setLanguage(language)
      const input = await browserCall(h.owner, "/connect/code")
      const wrong = await browserCall(h.owner, "/connect/code", {
        form: { xsrf: xsrfOf(input), user_code: "BCDF-GHJK" },
      })
      expectPage(wrong, language, "wrong code")
      expect(wrong.text).toContain(escaped(texts.wrongTitle))
      expect(wrong.text).toContain('<form id="op.deviceInputForm"')
    })

    it(`say in ${language} that a cancelled or denied connection was not approved`, async () => {
      await setLanguage(language)
      // Cancel on the comparison page (the library's own abort).
      const first = await throughCode()
      const cancelled = await browserCall(h.owner, "/connect/code", {
        form: { xsrf: first.xsrf, user_code: first.device.body.user_code, abort: "yes" },
      })
      expectPage(cancelled, language, "cancelled")
      expect(cancelled.text).toContain(escaped(texts.denied))
      expect((await pollDevice(h.issuer, first.device.body.device_code)).body.error).toBe("access_denied")

      // Deny on the consent page, then the address it answers with.
      const second = await throughCode()
      const toConsent = await browserCall(h.owner, "/connect/code", {
        form: { xsrf: second.xsrf, user_code: second.device.body.user_code, confirm: "yes" },
      })
      const uid = uidOf(toConsent.location)
      await browserCall(h.owner, `/connect/approve/${uid}/details`)
      const decision = await browserCall(h.owner, `/connect/approve/${uid}/decision`, { json: { approve: false } })
      expect(decision.body.outcome).toBe("denied")
      const back = await browserCall(h.owner, String(decision.body.redirectTo))
      expectPage(back, language, "denied")
      expect(back.text).toContain(escaped(texts.denied))
      expect((await pollDevice(h.issuer, second.device.body.device_code)).body.error).toBe("access_denied")
    })

    it(`show the library's error page in ${language}`, async () => {
      await setLanguage(language)
      const { challenge } = pkce()
      const query = new URLSearchParams({
        client_id: "no-such-client",
        redirect_uri: "http://127.0.0.1:33418/callback",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })
      const error = await browserCall(h.owner, `/oauth/authorize?${query}`, { headers: { accept: "text/html" } })
      expect(error.status).toBeGreaterThanOrEqual(400)
      expectPage(error, language, "error page")
      expect(error.text).toContain(escaped(texts.errors.invalid_client))
      expect(error.text).not.toContain("no-such-client")
    })
  }
})

describe("the consent page's address", () => {
  it("serves the built UI with no-store, no framing and no referrer, keeping its whole policy", async () => {
    const reg = await register(h.issuer)
    const { challenge } = pkce()
    const authorize = await browserCall(
      h.owner,
      `/oauth/authorize?${new URLSearchParams({
        client_id: String(reg.body.client_id),
        redirect_uri: "http://127.0.0.1:33418/callback",
        response_type: "code",
        scope: "read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
    )
    expectFlowHeaders(authorize, "redirect from authorize")
    const uid = uidOf(authorize.location)
    expect(uid).not.toBe("")
    const page = await browserCall(h.owner, `/connect/approve/${uid}`)
    expect(page.status).toBe(200)
    expect(page.text).toContain("the built UI")
    expectFlowHeaders(page, "consent page")
    expect(page.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY)
    // Its API keeps its own answers' policy.
    const details = await browserCall(h.owner, `/connect/approve/${uid}/details`)
    expectFlowHeaders(details, "details")
    expect(details.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
    // Not signed in, gone, not configured: every answer the page handles carries them too.
    expectFlowHeaders(await agentCall(h.issuer, `/connect/approve/${uid}/details`), "signed out")
    expectFlowHeaders(await browserCall(h.owner, "/connect/approve/unknown-uid/details"), "gone")
    await h.access.saveSettings(ownerBy, { enabled: false })
    const off = await browserCall(h.owner, `/connect/approve/${uid}/details`)
    expect(off.status).toBe(404)
    expect(off.body.error).toBe("not_configured")
    expectFlowHeaders(off, "not configured")
  })

  it("leaves the built UI's other pages as they were", async () => {
    const page = await browserCall(h.owner, "/settings/agents")
    expect(page.status).toBe(200)
    expect(page.headers.get("cache-control")).toBe("no-cache")
  })
})

describe("where the browser returns", () => {
  it("names an app's own scheme, which has no host, next to a loopback address with its host", async () => {
    const shown = async (redirect: string) => {
      const reg = await register(h.issuer, { redirect_uris: [redirect] })
      const { challenge } = pkce()
      const authorize = await browserCall(
        h.owner,
        `/oauth/authorize?${new URLSearchParams({
          client_id: String(reg.body.client_id),
          redirect_uri: redirect,
          response_type: "code",
          scope: "read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        })}`,
      )
      return (await browserCall(h.owner, `/connect/approve/${uidOf(authorize.location)}/details`)).body.redirect
    }
    expect(await shown("com.example.agent:/callback")).toEqual({
      host: "",
      loopback: false,
      scheme: "com.example.agent",
    })
    expect(await shown("http://127.0.0.1:33418/callback")).toEqual({
      host: "127.0.0.1:33418",
      loopback: true,
      scheme: "http",
    })
  })
})

describe("refusals before the hand-off to the library", () => {
  it("carry the flow headers: agents off, an address the library does not serve, another host", async () => {
    const other = h.issuer.replace("127.0.0.1", "localhost")
    for (const [what, answer, status] of [
      ["unknown address", await agentCall(h.issuer, "/oauth/token/"), 404],
      ["another host, code page", await agentCall(other, "/connect/code"), 421],
      ["another host, token", await agentCall(other, "/oauth/token", { form: { grant_type: "x" } }), 421],
    ] as const) {
      expect(answer.status, what).toBe(status)
      expectFlowHeaders(answer, what)
    }
    await h.access.saveSettings(ownerBy, { enabled: false })
    for (const path of ["/connect/code", "/connect/code/some-uid", "/oauth/authorize", "/oauth/register"]) {
      const answer = await agentCall(h.issuer, path, path === "/oauth/register" ? { json: {} } : {})
      expect(answer.status, path).toBe(404)
      expect(answer.body.error, path).toBe("not_configured")
      expectFlowHeaders(answer, `agents off: ${path}`)
    }
  })

  it("carry the flow headers when the public URL is not an issuer agents may use", async () => {
    const t3 = await createTestDatabase("oauth_pages_issuer")
    const h3 = await oauthHarness(t3, { publicUrl: () => "http://adiutor.example.com" })
    try {
      for (const path of ["/connect/code", "/oauth/token"]) {
        const answer = await agentCall(h3.issuer, path, path === "/oauth/token" ? { form: { grant_type: "x" } } : {})
        expect(answer.status, path).toBe(404)
        expectFlowHeaders(answer, `no issuer: ${path}`)
      }
    } finally {
      await h3.close()
      await t3.close()
    }
  })
})

describe("an app built without agent access (tests only)", () => {
  it("answers 404 not_found on the owner's agent settings without agentOAuth", async () => {
    const withoutAgents = createApp({ checkDatabase: async () => true, core: h.core })
    const headers = { cookie: h.owner.cookieHeader, ...h.owner.extra }
    const mounted = await browserCall(h.owner, "/api/v1/agents/settings")
    expect(mounted.status).toBe(200)
    const answer = await withoutAgents.request(`${h.issuer}/api/v1/agents/settings`, { headers })
    expect(answer.status).toBe(404)
    expect(((await answer.json()) as { error: { code: string } }).error.code).toBe("not_found")
  })
})

describe("too many codes", () => {
  it("answers 429 with the code page's note in the owner's language, and the flow headers", async () => {
    const t2 = await createTestDatabase("oauth_pages_limit")
    const h2 = await oauthHarness(t2, {
      limits: {
        ...wideLimits(),
        code: new WindowLimit(3, 600_000),
        codeSession: new WindowLimit(1, 600_000),
        token: new WindowLimit(1, 600_000),
      },
    })
    try {
      await getSettings(t2.ctx.db)
      await t2.ctx.db.update(settings).set({ language: "en" }).where(eq(settings.id, 1))
      const input = await browserCall(h2.owner, "/connect/code")
      const form = { xsrf: xsrfOf(input), user_code: "BCDF-GHJK" }
      expect((await browserCall(h2.owner, "/connect/code", { form })).status).toBe(200)
      const limited = await browserCall(h2.owner, "/connect/code", { form })
      expect(limited.status).toBe(429)
      expectPage(limited, "en", "limited")
      expect(limited.text).toContain(escaped(en.agentPages.limitedTitle))
      expect(limited.text).not.toContain("<form")
      // The address limits answer before the library: the code page's, and the token endpoint's.
      const byAddress = await browserCall(h2.owner, "/connect/code")
      expect(byAddress.status).toBe(429)
      expectFlowHeaders(byAddress, "address limit on the code page")
      expect((await agentCall(h2.issuer, "/oauth/revoke", { form: { token: "x" } })).status).not.toBe(429)
      const token = await agentCall(h2.issuer, "/oauth/revoke", { form: { token: "x" } })
      expect(token.status).toBe(429)
      expectFlowHeaders(token, "address limit on the token endpoint")
    } finally {
      await h2.close()
      await t2.close()
    }
  })
})
