import { generateKeyPairSync } from "node:crypto"
import { describe, expect, it } from "vitest"
import { githubApiOrigin, githubMeantOn, loadConfig } from "../config.ts"
import { testSecret } from "../testing/secrets.ts"
import { CONTENT_SECURITY_POLICY, UI_CONTENT_SECURITY_POLICY } from "../web.ts"
import { GitHubRefused, guardedFetch } from "./client.ts"
import { describeFailure, graphqlRateLimit, restRateLimit } from "./errors.ts"
import { GitHubGate } from "./gate.ts"
import { keyFingerprint, keyProblem, normalizeKey, readPrivateKey } from "./key.ts"
import { CREATION_TTL_MS, PendingCreation, readConversion } from "./manifest.ts"
import { withinReadPermissions } from "./pull.ts"

// The local parts of the GitHub reading: the key checks, the configuration, the rate-limit forms, the guarded fetch
// and the gate. No network beyond a refused request; every key is new on every run.

const rsa = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
})

const baseEnv = () => ({
  DATABASE_URL: `postgres://adiutor:${testSecret()}@db:5432/adiutor`,
  ADIUTOR_PUBLIC_URL: "http://localhost:8090",
  ADIUTOR_AUTH_SECRETS: `1:${testSecret()}`,
  ADIUTOR_SETTINGS_KEYS: `1:${testSecret()}`,
})

describe("the App's private key", () => {
  it("reads GitHub's PKCS#1 key, and a key written on one line with \\n escapes", () => {
    expect("key" in readPrivateKey(rsa.privateKey)).toBe(true)
    expect("key" in readPrivateKey(rsa.privateKey.trim().split("\n").join("\\n"))).toBe(true)
    expect(normalizeKey(rsa.privateKey.trim().split("\n").join("\\n"))).toBe(rsa.privateKey.trim())
  })

  it("refuses text, an EC key and a small RSA key", () => {
    // Assembled at run time: the guards and push protection scan the literal text.
    expect(readPrivateKey(["-----BEGIN RSA", "PRIVATE KEY-----"].join(" "))).toEqual({ problem: "not_a_key" })
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" })
    expect(readPrivateKey(ec.toString())).toEqual({ problem: "not_rsa" })
    // A small RSA key is described, not made: no test creates a weak key.
    expect(
      keyProblem({ type: "private", asymmetricKeyType: "rsa", asymmetricKeyDetails: { modulusLength: 1024 } }),
    ).toBe("too_small")
  })

  it("is shown by the fingerprint GitHub shows: SHA-256 of the public key, in Base64", () => {
    const read = readPrivateKey(rsa.privateKey)
    if (!("key" in read)) throw new Error("not read")
    expect(keyFingerprint(read.key)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}=$/)
  })
})

describe("the configuration", () => {
  it("takes the GitHub overrides, and refuses a key that is not one without repeating it", () => {
    const config = loadConfig({
      ...baseEnv(),
      ADIUTOR_GITHUB_APP_ID: "123456",
      ADIUTOR_GITHUB_INSTALLATIONS: "11, 22,11",
      ADIUTOR_GITHUB_PRIVATE_KEY: rsa.privateKey,
    })
    expect(config.overrides).toMatchObject({ githubAppId: "123456", githubInstallations: [11, 22] })
    expect(githubMeantOn(config.overrides)).toBe(true)
    const value = `not-a-key-${testSecret()}`
    expect(() => loadConfig({ ...baseEnv(), ADIUTOR_GITHUB_PRIVATE_KEY: value })).toThrow(
      /ADIUTOR_GITHUB_PRIVATE_KEY is not a PEM private key/,
    )
    try {
      loadConfig({ ...baseEnv(), ADIUTOR_GITHUB_PRIVATE_KEY: value })
    } catch (error) {
      expect(String(error)).not.toContain(value)
    }
    expect(() => loadConfig({ ...baseEnv(), ADIUTOR_GITHUB_INSTALLATIONS: "12,abc" })).toThrow(
      /ADIUTOR_GITHUB_INSTALLATIONS/,
    )
  })

  it("takes the API origin only from the command-line flag, as an origin", () => {
    expect(githubApiOrigin([])).toBe("https://api.github.com")
    expect(githubApiOrigin(["--github-api-origin=http://github:8080"])).toBe("http://github:8080")
    expect(() => githubApiOrigin(["--github-api-origin=http://github:8080/api"])).toThrow(/without a path/)
    expect(() => githubApiOrigin(["--github-api-origin=file:///etc"])).toThrow()
  })

  it("lets the UI's pages post forms to this origin and GitHub only, and the authorization server's to this origin", () => {
    expect(UI_CONTENT_SECURITY_POLICY).toContain("form-action 'self' https://github.com;")
    expect(CONTENT_SECURITY_POLICY).toContain("form-action 'self';")
  })
})

describe("the App made from a manifest", () => {
  const read = {
    vulnerability_alerts: "read",
    security_events: "read",
    secret_scanning_alerts: "read",
    issues: "read",
    metadata: "read",
  }
  const answer = (change: Record<string, unknown> = {}) => ({
    id: 123456,
    slug: "adiutor-reader-0a1b",
    owner: { login: "example-owner", type: "User" },
    permissions: read,
    events: [],
    pem: rsa.privateKey,
    ...change,
  })

  it("keeps the id, the slug, the owner and the key, and nothing else of the answer", () => {
    const created = readConversion(answer({ client_secret: testSecret(), webhook_secret: testSecret() }))
    expect("problem" in created).toBe(false)
    if ("problem" in created) return
    expect(Object.keys(created).sort()).toEqual(["appId", "key", "owner", "slug"])
    expect(created).toMatchObject({
      appId: "123456",
      slug: "adiutor-reader-0a1b",
      owner: { login: "example-owner", type: "User" },
    })
  })

  it("refuses other permissions, events, a malformed answer and a key that is not the App's kind", () => {
    expect(readConversion(answer({ permissions: { ...read, contents: "read" } }))).toEqual({ problem: "permissions" })
    expect(readConversion(answer({ permissions: { metadata: "read" } }))).toEqual({ problem: "permissions" })
    expect(readConversion(answer({ permissions: { ...read, issues: "write" } }))).toEqual({ problem: "permissions" })
    expect(readConversion(answer({ events: ["issues"] }))).toEqual({ problem: "events" })
    expect(readConversion(answer({ id: 0 }))).toEqual({ problem: "malformed" })
    expect(readConversion(answer({ owner: { type: "User" } }))).toEqual({ problem: "malformed" })
    expect(readConversion(answer({ slug: "../x" }))).toEqual({ problem: "malformed" })
    expect(readConversion(null)).toEqual({ problem: "malformed" })
    const ed = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    expect(readConversion(answer({ pem: ed }))).toEqual({ problem: "key" })
  })

  it("takes a state once, only the latest one, and only within the hour", () => {
    const pending = new PendingCreation()
    const now = new Date("2026-11-18T10:00:00Z")
    const first = pending.start(3, now)
    const second = pending.start(4, now)
    expect(pending.take(first, now)).toBeNull()
    expect(pending.take("other", now)).toBeNull()
    expect(pending.take(second, now)).toEqual({ generation: 4 })
    expect(pending.take(second, now)).toBeNull()
    const late = pending.start(5, now)
    expect(pending.take(late, new Date(now.getTime() + CREATION_TTL_MS))).toBeNull()
    expect(pending.take(late, now)).toBeNull()
  })
})

describe("GitHub's rate limits", () => {
  const now = new Date("2026-11-18T10:00:00Z")
  it("reads the primary limit, retry-after and a secondary limit named in the message", () => {
    const reset = String(now.getTime() / 1000 + 300)
    expect(restRateLimit(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, "", now)).toEqual(
      new Date(now.getTime() + 300_000),
    )
    expect(restRateLimit(429, { "retry-after": "30" }, "", now)).toEqual(new Date(now.getTime() + 30_000))
    expect(restRateLimit(403, {}, "You have exceeded a secondary rate limit.", now)).toEqual(
      new Date(now.getTime() + 60_000),
    )
    expect(restRateLimit(403, {}, "Resource not accessible by integration", now)).toBeNull()
    expect(restRateLimit(404, { "x-ratelimit-remaining": "0" }, "", now)).toBeNull()
  })

  it("reads a GraphQL limit by its type or message, whatever the status", () => {
    expect(graphqlRateLimit([{ type: "RATE_LIMITED" }], {}, now)).toEqual(new Date(now.getTime() + 60_000))
    expect(graphqlRateLimit([{ message: "secondary rate limit" }], {}, now)).not.toBeNull()
    expect(graphqlRateLimit([{ type: "NOT_FOUND" }], {}, now)).toBeNull()
  })

  it("does not believe a reset more than a day away", () => {
    const far = String(now.getTime() / 1000 + 7 * 86_400)
    expect(restRateLimit(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": far }, "", now)).toEqual(
      new Date(now.getTime() + 86_400_000),
    )
  })

  it("takes the later end when one answer gives both a reset and a retry-after", () => {
    const soon = String(now.getTime() / 1000 + 30)
    expect(
      restRateLimit(429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": soon, "retry-after": "600" }, "", now),
    ).toEqual(new Date(now.getTime() + 600_000))
  })

  it("waits as long as a GraphQL answer's retry-after says", () => {
    expect(graphqlRateLimit([{ type: "RATE_LIMITED" }], { "retry-after": "120" }, now)).toEqual(
      new Date(now.getTime() + 120_000),
    )
  })
})

describe("the guarded fetch", () => {
  it("refuses another origin and a request the gate no longer allows, before anything is sent", async () => {
    const signal = new AbortController().signal
    const fetchOn = guardedFetch({ origin: "http://127.0.0.1:9", signal, maySend: () => false })
    await expect(fetchOn("http://127.0.0.1:9/app")).rejects.toMatchObject({ code: "superseded" })
    const other = guardedFetch({ origin: "http://127.0.0.1:9", signal })
    await expect(other("https://api.github.com/app")).rejects.toMatchObject({ code: "origin" })
    const stopped = guardedFetch({ origin: "http://127.0.0.1:9", signal, stopped: () => true })
    await expect(stopped("http://127.0.0.1:9/app")).rejects.toMatchObject({ code: "stopped" })
  })

  it("is read back from Octokit's wrapped error", () => {
    expect(describeFailure({ status: 500, cause: new GitHubRefused("redirect") }, new Date())).toEqual({
      kind: "refused",
      code: "redirect",
    })
  })
})

describe("the gate", () => {
  it("blocks every send from a save's start until its generation is published, one save at a time", async () => {
    const gate = new GitHubGate(4)
    expect(gate.maySend(4)).toBe(true)
    let finishFirst: () => void = () => {}
    const first = gate.save(
      () =>
        new Promise<{ result: string; generation: number }>((resolve) => {
          finishFirst = () => resolve({ result: "first", generation: 5 })
        }),
    )
    const order: string[] = []
    const second = gate.save(async () => {
      order.push("second ran")
      return { result: "second", generation: 6 }
    })
    expect(gate.maySend(4)).toBe(false)
    await Promise.resolve()
    expect(order).toEqual([])
    finishFirst()
    expect(await first).toBe("first")
    expect(await second).toBe("second")
    expect(gate.generation).toBe(6)
    expect(gate.maySend(4)).toBe(false)
    expect(gate.maySend(6)).toBe(true)
  })

  it("lets a refused save go without publishing a generation", async () => {
    const gate = new GitHubGate(1)
    await expect(gate.save(() => Promise.reject(new Error("refused")))).rejects.toThrow("refused")
    expect(gate.maySend(1)).toBe(true)
  })
})

describe("the read permissions", () => {
  it("accept only read access to the five permissions", () => {
    expect(withinReadPermissions({ metadata: "read", issues: "read" })).toBe(true)
    expect(withinReadPermissions({ metadata: "read", issues: "write" })).toBe(false)
    expect(withinReadPermissions({ metadata: "read", contents: "read" })).toBe(false)
  })
})
