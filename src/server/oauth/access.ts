import { randomUUID } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { hostname } from "node:os"
import { and, asc, desc, eq, gt, inArray, isNull, like, lt, or, sql } from "drizzle-orm"
import type { KoaContextWithOIDC } from "oidc-provider"
import type { AgentArea, AgentConnectionMethod, AgentEndReason, AgentResource, Language } from "../../shared/enums.ts"
import { AGENT_IDLE_DAYS_MAX, AGENT_IDLE_DAYS_MIN, SETTINGS_DEFAULTS } from "../../shared/settings.ts"
import type { Db } from "../db/client.ts"
import { agentConnections, agentConsent, agentIdentityChanges, authUser, settings } from "../db/schema.ts"
import { invalid, notFound } from "../errors.ts"
import { errorFacts, log } from "../log.ts"
import { getSettings } from "../services/admin.ts"
import { type By, type Ctx, requireOwner, SYSTEM, type Tx, writeAudit } from "../services/context.ts"
import type { SettingsCipher } from "../settings/crypto.ts"
import {
  ensureState,
  gateExclusive,
  gateShared,
  generation,
  identityChanging,
  nextGeneration,
  storedFingerprint,
  storeFingerprint,
} from "./gate.ts"
import { checkIssuer, type IssuerProblem, issuerFingerprint } from "./issuer.ts"
import { defaultPages, type ProviderPages } from "./pages.ts"
import { currentProcess, processGone } from "./process.ts"
import {
  type AgentProvider,
  CLI_CLIENT_ID,
  consentPath,
  createAgentProvider,
  DEVICE_CODE_TTL_S,
  INTERACTION_TTL_S,
  PROVIDER_ROUTES,
  RESOURCE_AREAS,
  resourceUrls,
} from "./provider.ts"
import { loadSigningKey } from "./signing-key.ts"
import { cancelWaiting, deleteGrant, ONE_TIME, type StoreOptions, sha256, storeAdapter, sweepStore } from "./store.ts"

/** A connection's last use is written at most once a minute. */
const USE_WRITE_MS = 60_000
/** The sweep runs every 15 minutes: idle connections, grants without a connection, and the store's clean-up. */
export const SWEEP_EVERY_MS = 15 * 60_000

/** Who ends a connection when nobody asked: Adiutor itself. */
export const SYSTEM_END: By = SYSTEM
/** An agent that revoked one of its own tokens. */
const AGENT_END: By = { actor: { kind: "agent", label: "agent" }, source: "api" }

export type Connection = typeof agentConnections.$inferSelect

/**
 * What the per-call check answers for an access token (S17): the connection, the areas the token holds, and the
 * token's client and expiry (seconds since the epoch, as the MCP SDK's AuthInfo has them).
 */
export type TokenCheck =
  | { ok: true; connection: Connection; areas: AgentArea[]; clientId: string; expiresAt: number }
  | { ok: false; reason: "agents_off" | "invalid" }

/** A pending approval as the consent page shows it (oauth/routes.ts reads it from the library's interaction). */
export type PendingRequest = {
  uid: string
  clientId: string
  name: string
  /** The built-in client of the skill and the sync: its name is the label it sent, its own word. */
  builtIn: boolean
  via: AgentConnectionMethod
  resource: AgentResource
  /** Where the browser returns after approval; none for a code. */
  /** Where the browser returns: its host (empty for a private-use scheme), whether it is this computer, its scheme. */
  redirect: { host: string; loopback: boolean; scheme: string } | null
  /** The one set of areas shown, and the only ones that can be granted. */
  areas: AgentArea[]
  /** The device code's own value, for the request's generation record; null for an MCP client. */
  deviceCode: string | null
}

export type Decision =
  | { kind: "gone" }
  | { kind: "denied" }
  | { kind: "approved"; grantId: string; connectionId: string }

/** The areas offered for a request: what it asked for that its resource offers, or read and write when it asked none. */
export function offeredAreas(resource: AgentResource, scope: unknown): AgentArea[] {
  const allowed = RESOURCE_AREAS[resource]
  const asked = typeof scope === "string" ? scope.split(" ").filter(Boolean) : []
  const offered = allowed.filter((area) => asked.includes(area))
  return offered.length > 0 ? offered : allowed.filter((area) => area !== "sync")
}

export type AgentAccessOptions = {
  ctx: Ctx
  /** ADIUTOR_PUBLIC_URL as configured: the issuer, when agents may connect under it (S3). */
  publicUrl: string
  /** The cookie keys (config.ts, derived from ADIUTOR_AUTH_SECRETS), newest first. Required. */
  cookieKeys: string[]
  /** The storage adapter's own small pool (see oauth/store.ts). */
  storeDb: Db
  /** ADIUTOR_SETTINGS_KEYS: encrypts the signing key (oauth/signing-key.ts). */
  cipher: SettingsCipher
  pages?: ProviderPages
  /** The pinning tests' view of the store's calls (oauth/store.ts); production passes none. */
  observeStore?: StoreOptions["observe"]
  /** Pending requests kept of each kind at most (MAX_PENDING_REQUESTS unless a test names fewer). */
  maxPending?: number
}

/** Pending requests of each kind (approval pages, device codes) kept at most; the oldest unanswered goes first. */
export const MAX_PENDING_REQUESTS = 100
/** The lock that recording a pending request takes while it counts and makes room ("adtq"). */
const PENDING_LOCK_KEY = 0x61647471

/**
 * Agent access by approval: the authorization server for the configured public URL, the connection records, every way a
 * connection ends, the per-call token check, the owner's approval, the identity-change hooks and the sweep. Built by
 * index.ts (mounted through `createApp`'s `agentOAuth`) and by the recovery command (cli.ts, for its identity hooks).
 */
export async function createAgentAccess(options: AgentAccessOptions) {
  const { ctx } = options
  const db = ctx.db
  const maxPending = options.maxPending ?? MAX_PENDING_REQUESTS
  const checked = checkIssuer(options.publicUrl)
  const issuer = checked.issuer
  const issuerProblem: IssuerProblem | null = checked.problem
  // A public URL agents may not use has a fingerprint too (of the refused value): moving to it ends every connection,
  // and moving back from it revives none.
  const fingerprint = issuerFingerprint(issuer ?? `refused:${options.publicUrl.trim()}`)
  if (options.cookieKeys.length === 0) throw new Error("the authorization server needs its cookie keys")

  /** Set by the routes: a counted device poll that turned out to be waiting or approved, and a capped request done. */
  const hooks: {
    devicePollAnswered?: (req: IncomingMessage) => void
    providerDone?: (req: IncomingMessage) => void
    /** A code typed on the code page in this provider session (its signed cookie), or none: false when over the limit. */
    codeAttempt?: (session: string | undefined, req: IncomingMessage) => boolean
  } = {}

  // --- Ending connections (every end is one transaction with all its side effects) ---

  /**
   * Ends one connection in the caller's transaction (which holds the exclusive gate): its record, every record of its
   * grant and the grant itself, and the audit row. Ending one twice does nothing the second time. Grant records
   * without a connection (an approval that failed after the library stored its grant) go too.
   */
  async function endIn(
    tx: Tx,
    which: { id: string } | { grantId: string },
    reason: AgentEndReason,
    by: By,
  ): Promise<Connection | null> {
    const [row] = await tx
      .update(agentConnections)
      .set({ endedAt: ctx.clock(), endReason: reason, endedBy: by.actor.kind })
      .where(
        and(
          "id" in which ? eq(agentConnections.id, which.id) : eq(agentConnections.grantId, which.grantId),
          isNull(agentConnections.endedAt),
        ),
      )
      .returning()
    const grantId = row?.grantId ?? ("grantId" in which ? which.grantId : null)
    if (grantId) await deleteGrant(tx, grantId)
    if (!row) return null
    await writeAudit(ctx, tx, by, {
      action: "agent.end",
      entityType: "agent_connection",
      entityId: row.id,
      after: { name: row.name, reason, resource: row.resource },
    })
    return row
  }

  /**
   * Ends one connection for good, under the exclusive gate. With `unusedSince`, only while it still has not been used
   * since then, checked under the gate: a call that came in meanwhile keeps it (lesson 20).
   */
  async function end(
    which: { id: string } | { grantId: string },
    reason: AgentEndReason,
    by: By,
    unusedSince?: Date,
  ): Promise<Connection | null> {
    return db.transaction(async (tx) => {
      await gateExclusive(tx)
      if (unusedSince && "id" in which) {
        const [still] = await tx
          .select({ id: agentConnections.id })
          .from(agentConnections)
          .where(and(eq(agentConnections.id, which.id), idleBefore(unusedSince)))
        if (!still) return null
      }
      return endIn(tx, which, reason, by)
    })
  }

  /**
   * Ends every connection and every request still waiting (codes, device requests, approvals), and starts a new
   * generation so a request that began before cannot be approved after. Under the exclusive gate, in one transaction;
   * `alsoIn` runs first in the same transaction, for a change that must hold exactly when everything ended (agents
   * turned off, an identity change recorded as under way); what it returns joins the audit row. Returns how many
   * connections ended.
   */
  async function endEverything(reason: AgentEndReason, by: By, alsoIn?: (tx: Tx) => Promise<unknown>): Promise<number> {
    return db.transaction(async (tx) => {
      await gateExclusive(tx)
      const extra = await alsoIn?.(tx)
      const details = extra && typeof extra === "object" ? (extra as Record<string, unknown>) : {}
      await nextGeneration(tx)
      const live = await tx
        .select({ id: agentConnections.id })
        .from(agentConnections)
        .where(isNull(agentConnections.endedAt))
        .orderBy(asc(agentConnections.id))
      for (const r of live) await endIn(tx, { id: r.id }, reason, by)
      await cancelWaiting(tx)
      // Grants no connection holds (an approval that failed halfway) end with the rest.
      await tx.execute(sql`
        delete from oauth_store g where g.type = 'Grant'
          and not exists (select 1 from agent_connections a where a.grant_id = g.id and a.ended_at is null)`)
      await tx.execute(sql`
        delete from oauth_store s where s.grant_id is not null
          and not exists (select 1 from oauth_store g where g.type = 'Grant' and g.id = s.grant_id)`)
      await writeAudit(ctx, tx, by, {
        action: "agent.end_all",
        entityType: "agent_connection",
        entityId: null,
        after: { count: live.length, reason, ...details },
      })
      return live.length
    })
  }

  // --- Identity changes (D7): Better Auth's documented hooks call these (auth/auth.ts) ---

  /**
   * Before Better Auth writes an authorized change of the owner's identity: records the change as under way (no
   * approval is answered while any is) and ends every connection, in one transaction. Returns the change's id.
   */
  async function beginIdentityChange(by: By): Promise<string> {
    const id = randomUUID()
    const owner = currentProcess()
    await endEverything("person_changed", by, async (tx) => {
      await tx.insert(agentIdentityChanges).values({
        id,
        startedAt: ctx.clock(),
        host: owner.host,
        pid: owner.pid,
        processStartedAt: owner.startedAt,
      })
    })
    return id
  }

  /**
   * Finishes every identity change whose process is certainly gone (it stopped between its hooks): its after hook can
   * never run now. A change of a process that still runs, such as the recovery command at this moment, stays.
   */
  async function finishAbandonedChanges(): Promise<void> {
    const rows = await db.select().from(agentIdentityChanges)
    for (const row of rows)
      if (processGone({ host: row.host, pid: row.pid, startedAt: row.processStartedAt }))
        await finishIdentityChange(row.id, SYSTEM_END)
  }

  /**
   * After the change was written, or refused: ends every connection again (one approved in between, before the change
   * was written, ends too) and removes this change's own record, in one transaction. Other changes stay under way.
   */
  async function finishIdentityChange(id: string, by: By): Promise<void> {
    await endEverything("person_changed", by, async (tx) => {
      await tx.delete(agentIdentityChanges).where(eq(agentIdentityChanges.id, id))
    })
  }

  // --- The issuer (S18) and the switch (D6) ---

  /**
   * Whether connections are bound to this issuer: when the stored fingerprint differs, everything ends with reason
   * `issuer_changed` and the new one is stored; a connection made under another issuer never works again, also when the
   * public URL is changed back. Run at start, before a grant and in every token check.
   */
  async function reconcileIssuer(): Promise<void> {
    const known = await storedFingerprint(db)
    if (known === fingerprint) return
    await endEverything("issuer_changed", SYSTEM_END, async (tx) => {
      await storeFingerprint(tx, fingerprint)
    })
  }

  /**
   * Brings connections in line with how things are now; run at start, before any request: the state row, an identity
   * change left behind by a process that is certainly gone, the issuer, and agents turned off while connections stayed
   * (a turn-off interrupted halfway).
   */
  async function reconcile(): Promise<void> {
    await ensureState(db)
    await finishAbandonedChanges()
    await reconcileIssuer()
    const row = await getSettings(db)
    if (!row.agentsEnabled) {
      const [live] = await db
        .select({ id: agentConnections.id })
        .from(agentConnections)
        .where(isNull(agentConnections.endedAt))
        .limit(1)
      if (live) await endEverything("turned_off", SYSTEM_END)
    }
  }

  /** The agent settings: whether agents may connect, and the idle days. */
  async function agentSettings(): Promise<{ enabled: boolean; idleDays: number }> {
    const row = await getSettings(db)
    return { enabled: row.agentsEnabled, idleDays: row.agentIdleDays }
  }

  /**
   * Saves the agent settings, owner only, under the exclusive gate, in one transaction with what they end: turning
   * agents off ends every connection and every waiting request; fewer idle days end every connection idle longer.
   * More idle days revive nothing. Two saves at once run one after the other, each on what the other saved.
   */
  async function saveSettings(by: By, patch: { enabled?: boolean; idleDays?: number }): Promise<void> {
    requireOwner(by, "change the agent settings")
    const days = patch.idleDays
    if (days !== undefined && !(Number.isInteger(days) && days >= AGENT_IDLE_DAYS_MIN && days <= AGENT_IDLE_DAYS_MAX))
      throw invalid(`idleDays must be a whole number between ${AGENT_IDLE_DAYS_MIN} and ${AGENT_IDLE_DAYS_MAX}.`)
    const save = async (tx: Tx) => {
      const before = await getSettings(tx)
      const [after] = await tx
        .update(settings)
        .set({
          ...(patch.enabled === undefined ? {} : { agentsEnabled: patch.enabled }),
          ...(days === undefined ? {} : { agentIdleDays: days }),
          updatedAt: ctx.clock(),
        })
        .where(eq(settings.id, 1))
        .returning()
      if (!after) throw new Error("settings row missing")
      await writeAudit(ctx, tx, by, {
        action: "agent.settings_update",
        entityType: "settings",
        entityId: "1",
        before: { agentsEnabled: before.agentsEnabled, agentIdleDays: before.agentIdleDays },
        after: { agentsEnabled: after.agentsEnabled, agentIdleDays: after.agentIdleDays },
      })
      return { before, after }
    }
    if (patch.enabled === false) {
      // Saving "off" and ending everything are one transaction.
      await endEverything("turned_off", by, async (tx) => {
        await save(tx)
      })
      return
    }
    await db.transaction(async (tx) => {
      await gateExclusive(tx)
      const { before, after } = await save(tx)
      // A connection already past its end under the period in force before this save ends now, in the same
      // transaction, also when the new period is longer: saving a longer period never revives one.
      const days = Math.min(before.agentIdleDays, after.agentIdleDays)
      const cutoff = new Date(ctx.clock().getTime() - days * 86_400_000)
      const idle = await tx
        .select({ id: agentConnections.id })
        .from(agentConnections)
        .where(and(isNull(agentConnections.endedAt), idleBefore(cutoff)))
      for (const r of idle) await endIn(tx, { id: r.id }, "unused", by)
    })
  }

  // --- The authorization server ---

  async function accountExists(accountId: string): Promise<boolean> {
    const [row] = await db.select({ id: authUser.id }).from(authUser).where(eq(authUser.id, accountId))
    return Boolean(row)
  }

  /**
   * The language of the library's pages: the owner's language setting, which the morning message and the bot use too
   * and the app's own signed-out pages read from the browser's cached copy (a page without script cannot). Read only,
   * and never a failure: the default instead.
   */
  async function pageLanguage(): Promise<Language> {
    try {
      const [row] = await db.select({ language: settings.language }).from(settings).where(eq(settings.id, 1))
      return row?.language ?? SETTINGS_DEFAULTS.language
    } catch {
      return SETTINGS_DEFAULTS.language
    }
  }
  const pages = options.pages ?? defaultPages

  const Adapter = storeAdapter(options.storeDb, {
    now: ctx.clock,
    ...(options.observeStore ? { observe: options.observeStore } : {}),
    // A refresh token or code used twice at once: the loser ends the connection, like any reuse.
    onReuse: async (grantId, kind) => {
      await end({ grantId }, ONE_TIME[kind], SYSTEM_END)
    },
  })

  const provider: AgentProvider | null = issuer
    ? createAgentProvider({
        issuer,
        adapter: Adapter,
        cookieKeys: options.cookieKeys,
        pages,
        language: pageLanguage,
        accountExists,
        signingKey: await loadSigningKey(db, options.cipher),
      })
    : null

  if (provider) {
    // The library removed a grant: a spent refresh token or code came back, or the agent revoked one of its tokens.
    // The connection ends with it; the per-call check refuses the grant's tokens meanwhile (it looks the grant up).
    provider.on("grant.revoked", (k: KoaContextWithOIDC, grantId: string) => {
      const revocation = k.oidc?.route === "revocation"
      const grantType = String(k.oidc?.params?.grant_type ?? "")
      const reason: AgentEndReason = revocation
        ? "disconnected"
        : grantType === "refresh_token"
          ? "refresh_reused"
          : "code_reused"
      void end({ grantId }, reason, revocation ? AGENT_END : SYSTEM_END).catch((error: unknown) =>
        log.error("an agent connection could not be ended", errorFacts(error)),
      )
    })
    provider.on("server_error", (_k: KoaContextWithOIDC, error: Error) =>
      log.error("the authorization server failed", errorFacts(error)),
    )
    /*
     * The library's documented middleware (D1-X 4). Before it builds any record of a request that may open an approval
     * (authorize and its resume, the code page and its resume, a device code request) it reads the generation; after,
     * it records that generation for the approval to compare, keyed by the interaction uid from the redirect to the
     * consent page and by the device code's hash from the answer. A request that began before every connection ended
     * can then not be approved, even when the library stored its records later. With no record, an approval is refused.
     */
    provider.use(async (k, next) => {
      try {
        // Koa's context; the library adds `oidc` while it handles the request (read only after next()).
        await around(k as unknown as KoaContextWithOIDC, next)
      } finally {
        // Whatever happened, a capped request gives its place back once the library is done with it.
        hooks.providerDone?.(k.req)
      }
    })
  }

  const opensApproval = (path: string) =>
    path === PROVIDER_ROUTES.authorization ||
    path.startsWith(`${PROVIDER_ROUTES.authorization}/`) ||
    path === PROVIDER_ROUTES.code_verification ||
    path.startsWith(`${PROVIDER_ROUTES.code_verification}/`) ||
    path === PROVIDER_ROUTES.device_authorization

  async function around(k: KoaContextWithOIDC, next: () => Promise<unknown>) {
    const path = k.path
    // Codes typed on the code page count per provider session too (its own signed cookie), so one session cannot try
    // them from many addresses; counted before anything is awaited.
    const limited =
      path === PROVIDER_ROUTES.code_verification &&
      k.method === "POST" &&
      hooks.codeAttempt?.(k.cookies.get(provider?.cookieName("session") ?? "_session", { signed: true }), k.req) ===
        false
    if (limited) {
      k.status = 429
      k.set("Retry-After", "600")
      k.type = "html"
      k.body = pages.codeInput(await pageLanguage(), "", "limited")
      return
    }
    const opens = opensApproval(path)
    const gen = opens ? await generation(db) : 0
    let failure: unknown
    try {
      await next()
    } catch (error) {
      failure = error
    }
    if (opens && !failure) {
      const location = String(k.response.get("location") ?? "")
      const uid = /^\/connect\/approve\/([A-Za-z0-9_-]+)$/.exec(location)?.[1]
      if (uid) await recordRequest(`i:${uid}`, gen, INTERACTION_TTL_S)
      const body = k.body as { device_code?: unknown } | undefined
      if (path === PROVIDER_ROUTES.device_authorization && typeof body?.device_code === "string")
        await recordRequest(`d:${sha256(body.device_code)}`, gen, DEVICE_CODE_TTL_S)
    }
    if (path === PROVIDER_ROUTES.token) {
      const grantType = k.oidc?.params?.grant_type
      const error =
        (failure as { error?: unknown } | undefined)?.error ?? (k.body as { error?: unknown } | undefined)?.error
      const answered = k.status === 200 || error === "authorization_pending" || error === "slow_down"
      if (grantType === "urn:ietf:params:oauth:grant-type:device_code" && answered) hooks.devicePollAnswered?.(k.req)
    }
    if (failure) throw failure
  }

  /**
   * Records the generation a request began under (`agent_consent`), for its approval to compare. Pending requests of
   * each kind (approvals `i:`, device codes `d:`) are capped: when full, the oldest unanswered one goes and can no longer
   * be approved. Counted and evicted under an advisory lock of its own, so requests at once never pass the cap.
   */
  async function recordRequest(key: string, gen: number, ttlSeconds: number): Promise<void> {
    const now = ctx.clock()
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(PENDING_LOCK_KEY))})`)
      const open = await tx
        .select({ key: agentConsent.key })
        .from(agentConsent)
        .where(
          and(
            like(agentConsent.key, `${key.slice(0, 2)}%`),
            isNull(agentConsent.answeredAt),
            gt(agentConsent.expiresAt, now),
          ),
        )
        .orderBy(asc(agentConsent.createdAt), asc(agentConsent.key))
      const over = open.length - maxPending + 1
      if (over > 0)
        await tx.delete(agentConsent).where(
          inArray(
            agentConsent.key,
            open.slice(0, over).map((r) => r.key),
          ),
        )
      await tx
        .insert(agentConsent)
        .values({ key, generation: gen, createdAt: now, expiresAt: new Date(now.getTime() + ttlSeconds * 1000) })
        .onConflictDoNothing()
    })
  }

  // --- The owner's approval (S11, S19) ---

  /**
   * Binds a pending request to the browser session that first opens it: the first open fills the session only while it
   * is empty, and every later open or answer must come from that session. Another browser, or the owner after signing
   * in again, never sees or answers it. False when it is not open in the current generation.
   */
  async function bindRequest(uid: string, sessionId: string): Promise<boolean> {
    const key = `i:${uid}`
    const session = sha256(sessionId)
    await db
      .update(agentConsent)
      .set({ sessionId: session })
      .where(and(eq(agentConsent.key, key), isNull(agentConsent.sessionId)))
    const [row] = await db.select().from(agentConsent).where(eq(agentConsent.key, key))
    return Boolean(
      row &&
        row.sessionId === session &&
        !row.answeredAt &&
        row.expiresAt.getTime() > ctx.clock().getTime() &&
        row.generation === (await generation(db)),
    )
  }

  /**
   * Answers a request once, approve or deny, under the shared gate in one transaction: an end that began first has
   * finished and moved the generation; one that begins now waits until this connection is recorded, and then ends it.
   * The request is taken by its session only while it and its device code began in the current generation, no identity
   * change is under way, the issuer is the one connections are bound to, agents are on and the owner exists with
   * two-factor on. `areas` must already be a non-empty part of the request's offered set (checked by the caller before
   * this takes the request). The grant is stored through the library, on the store's own pool.
   */
  async function decide(input: {
    request: PendingRequest
    sessionId: string
    approve: boolean
    areas: AgentArea[]
    accountId: string
    by: By
  }): Promise<Decision> {
    const { request, by } = input
    if (!provider || !issuer) return { kind: "gone" }
    if (input.approve && (input.areas.length === 0 || !input.areas.every((a) => request.areas.includes(a))))
      throw invalid("Choose what the agent may do from the areas shown.")
    await reconcileIssuer()
    const outcome = await db.transaction(async (tx): Promise<Decision> => {
      await gateShared(tx)
      const now = ctx.clock()
      const [taken] = await tx
        .update(agentConsent)
        .set({ answeredAt: now })
        .where(
          and(
            eq(agentConsent.key, `i:${request.uid}`),
            eq(agentConsent.sessionId, sha256(input.sessionId)),
            isNull(agentConsent.answeredAt),
            gt(agentConsent.expiresAt, now),
          ),
        )
        .returning({ generation: agentConsent.generation })
      const current = await generation(tx)
      if (!taken || taken.generation !== current) return { kind: "gone" }
      if (request.deviceCode) {
        const [device] = await tx
          .select({ generation: agentConsent.generation })
          .from(agentConsent)
          .where(eq(agentConsent.key, `d:${sha256(request.deviceCode)}`))
        if (!device || device.generation !== current) return { kind: "gone" }
      }
      if (!input.approve) {
        await writeAudit(ctx, tx, by, {
          action: "agent.deny",
          entityType: "agent_connection",
          entityId: null,
          after: { name: request.name, via: request.via, resource: request.resource },
        })
        return { kind: "denied" }
      }
      if (await identityChanging(tx)) return { kind: "gone" }
      if ((await storedFingerprint(tx)) !== fingerprint) return { kind: "gone" }
      const row = await getSettings(tx)
      if (!row.agentsEnabled) return { kind: "gone" }
      const [owner] = await tx
        .select({ id: authUser.id, twoFactorEnabled: authUser.twoFactorEnabled })
        .from(authUser)
        .where(eq(authUser.id, input.accountId))
      if (!owner?.twoFactorEnabled) return { kind: "gone" }
      // If this transaction fails after the library stored the grant, the sweep removes the grant.
      const grant = new provider.Grant({ accountId: input.accountId, clientId: request.clientId })
      const resource = resourceUrls(issuer)[request.resource]
      grant.addResourceScope(resource, input.areas.join(" "))
      const refused = RESOURCE_AREAS[request.resource].filter((a) => !input.areas.includes(a))
      if (refused.length) grant.rejectResourceScope(resource, refused.join(" "))
      // openid is never granted (D1i): rejected, so the library does not ask again.
      grant.rejectOIDCScope("openid")
      const grantId = await grant.save()
      const [connection] = await tx
        .insert(agentConnections)
        .values({
          name: request.name,
          connectedVia: request.via,
          resource: request.resource,
          areas: input.areas,
          clientId: request.clientId,
          grantId,
          issuer,
          redirectHost: request.redirect?.host ?? null,
          approvedAt: now,
        })
        .returning({ id: agentConnections.id })
      if (!connection) throw new Error("the connection was not recorded")
      await writeAudit(ctx, tx, by, {
        action: "agent.approve",
        entityType: "agent_connection",
        entityId: connection.id,
        after: { name: request.name, via: request.via, resource: request.resource, areas: input.areas },
      })
      return { kind: "approved", grantId, connectionId: connection.id }
    })
    return outcome
  }

  // --- The per-call token check (S17), for /api/v1 and /mcp (PR 4) ---

  /**
   * Checks an access token presented to a resource, before any route code runs: agents are on; the issuer is the one
   * connections are bound to; the library finds the token, unexpired, made for this resource; its connection record
   * has not ended, is for this issuer and resource; the library's grant still exists (it removes a grant before the
   * event that ends the record arrives); the owner exists; and the connection was used within the idle days, by
   * Adiutor's clock. A connection found past its idle days or without its owner ends for good. With `use`, the call
   * counts as use (at most one write a minute); a refresh never does. The areas come from the token itself.
   */
  async function checkToken(
    token: string,
    resource: AgentResource,
    { use = false }: { use?: boolean } = {},
  ): Promise<TokenCheck> {
    const refused = { ok: false as const, reason: "invalid" as const }
    if (!provider || !issuer) return refused
    const current = await agentSettings()
    if (!current.enabled) return { ok: false, reason: "agents_off" }
    await reconcileIssuer()
    const at = await provider.AccessToken.find(token).catch(() => undefined)
    if (!at || at.isExpired || !at.grantId) return refused
    if (at.aud !== resourceUrls(issuer)[resource]) return refused
    const [row] = await db
      .select()
      .from(agentConnections)
      .where(and(eq(agentConnections.grantId, at.grantId), isNull(agentConnections.endedAt)))
    if (!row || row.issuer !== issuer || row.resource !== resource) return refused
    if (!(await provider.Grant.find(at.grantId))) return refused
    if (!at.accountId || !(await accountExists(at.accountId))) {
      await end({ id: row.id }, "person_changed", SYSTEM_END)
      return refused
    }
    const now = ctx.clock()
    const cutoff = new Date(now.getTime() - current.idleDays * 86_400_000)
    if ((row.lastUsedAt ?? row.approvedAt).getTime() < cutoff.getTime()) {
      // Ended for good: a longer idle period saved later revives nothing.
      await end({ id: row.id }, "unused", SYSTEM_END, cutoff)
      return refused
    }
    let connection = row
    if (use) {
      const touched = await recordUse(row)
      if (!touched) return refused
      connection = touched
    }
    const granted = String(at.scope ?? "").split(" ")
    return {
      ok: true,
      connection,
      areas: row.areas.filter((a) => granted.includes(a)),
      clientId: String(at.clientId ?? ""),
      expiresAt: Number(at.exp ?? 0),
    }
  }

  /**
   * A real API or MCP call of a connection that passed the check counts as use (the idle rule), written at most once a
   * minute. Null when the connection ended meanwhile. `access`, `endpoints`, `tools/list` and refused calls never
   * count (agents/channel.ts decides).
   */
  async function recordUse(row: Connection): Promise<Connection | null> {
    const now = ctx.clock()
    if (row.lastUsedAt && now.getTime() - row.lastUsedAt.getTime() < USE_WRITE_MS) {
      // Used within the minute: no write, but always a fresh read that it has not ended since it was checked.
      const [live] = await db
        .select()
        .from(agentConnections)
        .where(and(eq(agentConnections.id, row.id), isNull(agentConnections.endedAt)))
      return live ?? null
    }
    const [touched] = await db
      .update(agentConnections)
      .set({ lastUsedAt: now })
      .where(and(eq(agentConnections.id, row.id), isNull(agentConnections.endedAt)))
      .returning()
    return touched ?? null
  }

  // --- The owner's management ---

  async function listConnections(by: By): Promise<Connection[]> {
    requireOwner(by, "see the agent connections")
    return db
      .select()
      .from(agentConnections)
      .where(isNull(agentConnections.endedAt))
      .orderBy(desc(agentConnections.approvedAt))
  }

  async function disconnect(by: By, id: string): Promise<void> {
    requireOwner(by, "disconnect an agent")
    const ended = await end({ id }, "disconnected", by)
    if (!ended) throw notFound("The connection")
  }

  /**
   * Ends every connection and every waiting request. In the same transaction it also clears every identity change of
   * another host (an earlier container: the recovery command runs with `docker compose exec` in the server's own
   * container, so a change under way always has this host) and every change of this host whose process is certainly
   * gone (`processGone`): the owner's way out of an approval block such a row would keep for ever. A change of this host
   * whose process runs, or cannot be read, or has no recorded start time, stays (a change may still be under way); the
   * server's own stuck change ends with a restart of the container. The audit row names how many it cleared.
   */
  async function disconnectAll(by: By): Promise<number> {
    requireOwner(by, "disconnect every agent")
    return endEverything("all_disconnected", by, async (tx) => {
      const here = hostname()
      const rows = await tx.select().from(agentIdentityChanges)
      const stale = rows.filter(
        (r) => r.host !== here || processGone({ host: r.host, pid: r.pid, startedAt: r.processStartedAt }),
      )
      if (stale.length > 0)
        await tx.delete(agentIdentityChanges).where(
          inArray(
            agentIdentityChanges.id,
            stale.map((r) => r.id),
          ),
        )
      return { identityChangesCleared: stale.length }
    })
  }

  // --- The sweep (S20) ---

  /** Ends every connection not used within `days`, each under the exclusive gate, looked at again there. */
  async function endIdle(days: number): Promise<number> {
    const cutoff = new Date(ctx.clock().getTime() - days * 86_400_000)
    const rows = await db
      .select({ id: agentConnections.id })
      .from(agentConnections)
      .where(and(isNull(agentConnections.endedAt), idleBefore(cutoff)))
    let ended = 0
    for (const r of rows) if (await end({ id: r.id }, "unused", SYSTEM_END, cutoff)) ended++
    return ended
  }

  /**
   * Every 15 minutes, by Adiutor's clock: the issuer and the switch as at start, connections past the idle days end,
   * connections whose grant the library removed (an event that never arrived) end, grants and records no live
   * connection holds go, and the store's clean-up runs. Requests check everything themselves and never wait for it.
   */
  async function sweep(): Promise<void> {
    await finishAbandonedChanges()
    await reconcileIssuer()
    const current = await agentSettings()
    if (!current.enabled) {
      const [live] = await db
        .select({ id: agentConnections.id })
        .from(agentConnections)
        .where(isNull(agentConnections.endedAt))
        .limit(1)
      if (live) await endEverything("turned_off", SYSTEM_END)
    }
    await endIdle(current.idleDays)
    const orphans = await db
      .select({ id: agentConnections.id })
      .from(agentConnections)
      .where(
        and(
          isNull(agentConnections.endedAt),
          sql`not exists (select 1 from oauth_store g where g.type = 'Grant' and g.id = ${agentConnections.grantId})`,
        ),
      )
    for (const r of orphans) await end({ id: r.id }, "disconnected", SYSTEM_END)
    await db.transaction(async (tx) => {
      await gateExclusive(tx)
      await tx.execute(sql`
        delete from oauth_store g where g.type = 'Grant'
          and not exists (select 1 from agent_connections a where a.grant_id = g.id and a.ended_at is null)`)
    })
    await sweepStore(db, ctx.clock())
  }

  let timer: NodeJS.Timeout | null = null

  return {
    /** The issuer agents connect to, or null with the reason in `issuerProblem`. */
    issuer,
    issuerProblem,
    provider,
    hooks,
    resources: issuer ? resourceUrls(issuer) : null,
    CLI_CLIENT_ID,
    consentPath,
    agentSettings,
    saveSettings,
    reconcile,
    checkToken,
    recordUse,
    bindRequest,
    decide,
    end,
    endEverything,
    endIdle,
    listConnections,
    disconnect,
    disconnectAll,
    sweep,
    /** Better Auth's identity-change hooks (auth/auth.ts, D7). */
    identity: { begin: beginIdentityChange, finish: finishIdentityChange },
    /** Reconciles, then sweeps every 15 minutes until `stop`. */
    async start(): Promise<void> {
      await reconcile()
      timer = setInterval(() => {
        void sweep().catch((error: unknown) => log.error("the agent sweep failed", errorFacts(error)))
      }, SWEEP_EVERY_MS)
      timer.unref()
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

export type AgentAccess = Awaited<ReturnType<typeof createAgentAccess>>

/** A connection not used since `cutoff` (or never used, and approved before it). */
const idleBefore = (cutoff: Date) =>
  or(
    lt(agentConnections.lastUsedAt, cutoff),
    and(isNull(agentConnections.lastUsedAt), lt(agentConnections.approvedAt, cutoff)),
  )

/** The client of a pending request: the built-in one names itself per request. */
export const isBuiltIn = (clientId: string) => clientId === CLI_CLIENT_ID
