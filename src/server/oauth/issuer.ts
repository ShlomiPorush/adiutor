import { createHash } from "node:crypto"

/**
 * The only names on which the authorization server accepts plain http, for trying Adiutor on this computer. Exactly
 * these three (not all of 127.0.0.0/8); nothing adds to them, not a setting, a variable or a build flag, and not for
 * tests either: the verification stack reaches the server on 127.0.0.1.
 */
export const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const

/**
 * Why agents cannot connect at a public URL, as a stable code the Agent access page shows in words:
 * - `invalid`: not an http or https URL;
 * - `not_origin`: it has a path, a query, a fragment or user information (the issuer is an origin);
 * - `plain_http`: http on a host other than the three loopback names;
 * - `spelling`: a browser would send it spelled differently (a host with non-ASCII letters, a short or hex IPv4 form,
 *   an IPv4-mapped IPv6 address, a default port written out), so its `Origin` would never match.
 */
export type IssuerProblem = "invalid" | "not_origin" | "plain_http" | "spelling"

export type IssuerCheck = { issuer: string; problem: null } | { issuer: null; problem: IssuerProblem }

/**
 * The OAuth issuer for ADIUTOR_PUBLIC_URL: its origin exactly as a browser serializes it (WHATWG URL), or the reason
 * there is none. The text must already be in that form, apart from letter case and one trailing slash: Adiutor
 * refuses a URL a browser would spell differently instead of rebuilding the browser's normalization.
 */
export function checkIssuer(text: string): IssuerCheck {
  const typed = text.trim()
  const url = URL.parse(typed)
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return { issuer: null, problem: "invalid" }
  if (url.username || url.password || url.search || url.hash || typed.endsWith("?") || typed.endsWith("#"))
    return { issuer: null, problem: "not_origin" }
  if (url.pathname !== "/") return { issuer: null, problem: "not_origin" }
  if (url.protocol === "http:" && !(LOOPBACK_HOSTNAMES as readonly string[]).includes(url.hostname))
    return { issuer: null, problem: "plain_http" }
  if (url.hostname.startsWith("[::ffff:")) return { issuer: null, problem: "spelling" }
  const withoutSlash = typed.endsWith("/") ? typed.slice(0, -1) : typed
  if (withoutSlash.toLowerCase() !== url.origin) return { issuer: null, problem: "spelling" }
  return { issuer: url.origin, problem: null }
}

/**
 * What connections are bound to (S18): a hash of the issuer. Adiutor signs people in with its own Better Auth, so there
 * is no identity provider or sign-in client to add. When it changes every connection ends, and changing it back
 * revives none.
 */
export function issuerFingerprint(issuer: string): string {
  return createHash("sha256").update(`adiutor-agents:1\n${issuer}`).digest("hex")
}
