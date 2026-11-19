import { createHash, type KeyObject, randomBytes, timingSafeEqual } from "node:crypto"
import { UI_ROUTES, uiUrl } from "../../shared/routes.ts"
import { GITHUB_ID } from "../config.ts"
import { readPrivateKey } from "./key.ts"
import { READ_PERMISSIONS } from "./pull.ts"

// The owner's GitHub App made from a manifest (GitHub's documented manifest flow): Settings posts the manifest to
// GitHub with a one-time state, the owner confirms there, GitHub sends the browser back with a code, and the server
// converts the code into the App's id and private key. Only the state's hash is kept, in this process, for an hour; a
// restart drops it. The conversion's client id, client secret and webhook secret are never read out of its answer.

/** How long a started creation waits for GitHub to send the browser back (GitHub's codes last an hour too). */
export const CREATION_TTL_MS = 60 * 60_000

/** The address the App's page names as its homepage. */
export const APP_HOMEPAGE = "https://github.com/ShlomiPorush/adiutor"

/** An App's slug, as its install address uses it. */
export const APP_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/

const sha256 = (text: string) => createHash("sha256").update(text).digest()

/**
 * The one creation started and not finished yet: its state's SHA-256, the GitHub generation it was started at, and its
 * end. A new start replaces it; a matching state removes it before anything else happens, so a state works once.
 */
export class PendingCreation {
  private pending: { hash: Buffer; generation: number; until: number } | null = null

  /** Starts a creation at `generation` and answers its state (32 random bytes, base64url), kept only as a hash. */
  start(generation: number, now: Date): string {
    const state = randomBytes(32).toString("base64url")
    this.pending = { hash: sha256(state), generation, until: now.getTime() + CREATION_TTL_MS }
    return state
  }

  /** The generation the creation of `state` was started at, or null: another state, used already, or expired. */
  take(state: string, now: Date): { generation: number } | null {
    const pending = this.pending
    if (!pending || !timingSafeEqual(sha256(state), pending.hash)) return null
    this.pending = null
    return now.getTime() < pending.until ? { generation: pending.generation } : null
  }
}

/** How long a started connection of an account waits for GitHub to send the browser back. */
export const INSTALL_TTL_MS = 5 * 60_000

/**
 * The one connection of an account started from Settings and not finished yet: its state's SHA-256 and its end. GitHub's
 * return names the installation in an address anyone can write (GitHub warns that its installation_id can be spoofed),
 * so the install link carries a one-time state (GitHub's documented `state` of the installation URL, which it brings
 * back), and only a return with that state adds an installation. Another state changes nothing; the matching one is
 * used up first, so it works once. A new start replaces it.
 */
export class PendingInstall {
  private pending: { hash: Buffer; until: number } | null = null

  /** Starts a connection and answers its state (32 random bytes, base64url), kept only as a hash. */
  start(now: Date): string {
    const state = randomBytes(32).toString("base64url")
    this.pending = { hash: sha256(state), until: now.getTime() + INSTALL_TTL_MS }
    return state
  }

  /** Whether `state` is the pending connection's and it is not over yet; a match is used up either way. */
  take(state: string, now: Date): boolean {
    const pending = this.pending
    if (!pending || !timingSafeEqual(sha256(state), pending.hash)) return false
    this.pending = null
    return now.getTime() < pending.until
  }
}

/** The manifest of the App Settings creates: read access to the security data and Issues only, no webhook. */
export function appManifest(publicUrl: URL) {
  const back = uiUrl(publicUrl, UI_ROUTES.githubSettings)
  return {
    name: `Adiutor reader ${randomBytes(2).toString("hex")}`,
    url: APP_HOMEPAGE,
    hook_attributes: { url: uiUrl(publicUrl, UI_ROUTES.home), active: false },
    redirect_url: back,
    setup_url: back,
    public: true,
    default_events: [],
    default_permissions: Object.fromEntries(READ_PERMISSIONS.map((name) => [name, "read"])),
    request_oauth_on_install: false,
    setup_on_update: true,
  }
}

/** The new App as Adiutor keeps it from the conversion's answer: nothing else of the answer is read. */
export type CreatedApp = {
  appId: string
  slug: string
  owner: { login: string; type: string | null }
  key: KeyObject
}

/** Why a conversion's answer is not the App the manifest asked for. */
export type ConversionProblem = "malformed" | "permissions" | "events" | "key"

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const shortText = (v: unknown, max = 100): v is string => typeof v === "string" && v.length > 0 && v.length <= max

/**
 * Reads the conversion's answer: a positive id, a short slug, an owner with a login, exactly the five read permissions
 * (not fewer, not more), no events, and an RSA private key of 2048 bits or more. The client id, client secret and
 * webhook secret are left where they are.
 */
export function readConversion(data: unknown): CreatedApp | { problem: ConversionProblem } {
  if (!isObject(data)) return { problem: "malformed" }
  const { id, slug, owner, permissions, events, pem } = data
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    !GITHUB_ID.test(String(id)) ||
    typeof slug !== "string" ||
    !APP_SLUG.test(slug) ||
    !isObject(owner) ||
    !shortText(owner.login) ||
    !isObject(permissions) ||
    !Array.isArray(events) ||
    typeof pem !== "string"
  )
    return { problem: "malformed" }
  const granted = Object.entries(permissions)
  if (granted.length !== READ_PERMISSIONS.length || !READ_PERMISSIONS.every((name) => permissions[name] === "read"))
    return { problem: "permissions" }
  if (events.length > 0) return { problem: "events" }
  const read = readPrivateKey(pem)
  if ("problem" in read) return { problem: "key" }
  return {
    appId: String(id),
    slug,
    owner: { login: owner.login, type: shortText(owner.type) ? owner.type : null },
    key: read.key,
  }
}
