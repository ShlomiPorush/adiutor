import { ownerEmail } from "../../shared/auth.ts"
import { testPassword } from "./secrets.ts"
import { secretOf, totp } from "./totp.ts"

// A browser for HTTP integration tests: a cookie jar, the Origin and X-Mikud-Request headers of the Mikud page,
// and the owner's flows (setup, enrolment, sign-in) on Better Auth's routes against an app's fetch. Better Auth keys
// its rate limits on X-Forwarded-For: give each browser its own address (extra headers).

export const TEST_ORIGIN = "http://127.0.0.1:8090"
export const TEST_USERNAME = "Owner.Name"
/** New for every test process (one per test file). */
export const TEST_PASSWORD = testPassword()

type Fetch = (request: Request) => Response | Promise<Response>
// biome-ignore lint/suspicious/noExplicitAny: tests read each answer as the shape they expect
export type Answer = { status: number; headers: Headers; json: any; setCookies: string[] }

export class TestBrowser {
  readonly cookies = new Map<string, string>()

  constructor(
    private readonly fetch: Fetch,
    readonly origin = TEST_ORIGIN,
    /** Extra headers on every request (a test client address, for example). */
    readonly extra: Record<string, string> = {},
  ) {}

  get cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
  }

  /** A copy of this browser, the same cookies: another tab. */
  tab(): TestBrowser {
    const copy = new TestBrowser(this.fetch, this.origin, this.extra)
    for (const [name, value] of this.cookies) copy.cookies.set(name, value)
    return copy
  }

  async call(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; page?: boolean } = {},
  ): Promise<Answer> {
    const headers: Record<string, string> = { ...this.extra, ...options.headers }
    if (this.cookies.size > 0) headers.cookie = this.cookieHeader
    // The page's own headers on everything but GET, unless a test leaves them out.
    if (method !== "GET" && options.page !== false) {
      headers.origin ??= this.origin
      headers["x-mikud-request"] ??= "1"
    }
    if (options.body !== undefined) headers["content-type"] = "application/json"
    const response = await this.fetch(
      new Request(`${this.origin}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
    )
    const setCookies = response.headers.getSetCookie()
    for (const cookie of setCookies) {
      const [pair = "", ...attributes] = cookie.split(";")
      const eq = pair.indexOf("=")
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      if (!value || attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a))) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    const text = await response.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = text
    }
    return { status: response.status, headers: response.headers, json, setCookies }
  }

  /** First run: Better Auth's sign-up creates the owner (signed in, two-factor not set up yet). */
  async setup(username = TEST_USERNAME, password = TEST_PASSWORD): Promise<Answer> {
    return this.call("POST", "/api/auth/sign-up/email", {
      body: { name: username, email: ownerEmail(username), username, displayUsername: username, password },
    })
  }

  /** Starts enrolment: the TOTP secret and the backup codes. */
  async enable(password = TEST_PASSWORD): Promise<{ secret: string; backupCodes: string[] }> {
    const res = await this.call("POST", "/api/auth/two-factor/enable", { body: { password } })
    if (res.status !== 200) throw new Error(`enable answered ${res.status}: ${JSON.stringify(res.json)}`)
    return { secret: secretOf(res.json.totpURI), backupCodes: res.json.backupCodes }
  }

  verify(code: string): Promise<Answer> {
    return this.call("POST", "/api/auth/two-factor/verify-totp", { body: { code } })
  }

  /** Setup and enrolment: a signed-in owner with two-factor on. Returns the TOTP secret and the backup codes. */
  async enrolledOwner(
    username = TEST_USERNAME,
    password = TEST_PASSWORD,
  ): Promise<{ secret: string; backupCodes: string[] }> {
    const created = await this.setup(username, password)
    if (created.status !== 200) throw new Error(`setup answered ${created.status}: ${JSON.stringify(created.json)}`)
    const enrolment = await this.enable(password)
    const verified = await this.verify(totp(enrolment.secret))
    if (verified.status !== 200) throw new Error(`verify answered ${verified.status}: ${JSON.stringify(verified.json)}`)
    return enrolment
  }

  /** enrolledOwner, returning the TOTP secret only. */
  async owner(username = TEST_USERNAME, password = TEST_PASSWORD): Promise<string> {
    return (await this.enrolledOwner(username, password)).secret
  }

  passwordSignIn(username = TEST_USERNAME, password = TEST_PASSWORD): Promise<Answer> {
    return this.call("POST", "/api/auth/sign-in/username", { body: { username, password } })
  }

  /** A full sign-in of an enrolled owner: password, then the code. */
  async signIn(secret: string, username = TEST_USERNAME, password = TEST_PASSWORD): Promise<void> {
    const first = await this.passwordSignIn(username, password)
    if (first.status !== 200 || !first.json?.twoFactorRedirect)
      throw new Error(`sign-in answered ${first.status}: ${JSON.stringify(first.json)}`)
    const second = await this.verify(totp(secret))
    if (second.status !== 200) throw new Error(`verify answered ${second.status}: ${JSON.stringify(second.json)}`)
  }
}
