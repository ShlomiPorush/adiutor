import { createHmac, timingSafeEqual } from "node:crypto"
import type { Auth } from "./auth.ts"

// Better Auth's signed cookies (better-call): the value is encodeURIComponent(`${value}.${signature}`), where
// the signature is the standard base64 of HMAC-SHA256(value) under the auth secret. The names carry the
// `__Secure-` prefix when secure cookies are on; they are read from Better Auth's own configuration.

/** The value of a signed cookie, or null when it is empty, malformed or its signature does not match. */
export function verifySigned(raw: string, secret: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  const dot = decoded.lastIndexOf(".")
  if (dot <= 0) return null
  const value = decoded.slice(0, dot)
  const given = Buffer.from(decoded.slice(dot + 1))
  const expected = Buffer.from(createHmac("sha256", secret).update(value).digest("base64"))
  return given.length === expected.length && timingSafeEqual(given, expected) ? value : null
}

export type CookieNames = { secret: string; sessionToken: string; twoFactor: string; clearing: string[] }

/** The names Mikud reads, the signing secret, and Set-Cookie values that clear the session cookies. */
export async function cookieNames(auth: Auth): Promise<CookieNames> {
  const context = await auth.$context
  const { authCookies } = context
  const clearing = [authCookies.sessionToken, authCookies.sessionData, authCookies.dontRememberToken].map(
    (cookie) =>
      `${cookie.name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${cookie.attributes.secure ? "; Secure" : ""}`,
  )
  return {
    secret: context.secret,
    sessionToken: authCookies.sessionToken.name,
    twoFactor: context.createAuthCookie("two_factor").name,
    clearing,
  }
}

/** The verified value a response sets for `name`, ignoring cookies that delete it (empty or Max-Age=0). */
export function signedFromSetCookie(response: Response, name: string, secret: string): string | null {
  for (const cookie of response.headers.getSetCookie()) {
    if (!cookie.startsWith(`${name}=`)) continue
    const [pair = "", ...attributes] = cookie.split(";")
    const raw = pair.slice(name.length + 1)
    if (!raw || attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a))) continue
    const value = verifySigned(raw, secret)
    if (value) return value
  }
  return null
}

/** The verified value of the request's cookie `name`, or null. */
export function signedFromRequest(headers: Headers, name: string, secret: string): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=")
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue
    const value = verifySigned(part.slice(eq + 1).trim(), secret)
    if (value) return value
  }
  return null
}

/** The verification rows of one two-factor challenge: the challenge and its attempt counter. */
export const challengeRows = (identifier: string) => [identifier, `2fa-attempts-${identifier}`]
