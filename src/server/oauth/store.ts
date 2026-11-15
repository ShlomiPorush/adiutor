import { createHash } from "node:crypto"
import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm"
import { type Adapter, type AdapterPayload, errors } from "oidc-provider"
import type { Db } from "../db/client.ts"
import { agentConsent, oauthStore } from "../db/schema.ts"
import type { DbOrTx, Tx } from "../services/context.ts"

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

/**
 * The kinds whose value a client presents and which the authorization server looks up only by that value: kept by the
 * SHA-256 of the value alone (D1a). Two facts the library does not document make this work, and the pinning tests
 * (oauth/store.integration.test.ts) fail when either changes (D1-X 1): an opaque value is its record's id and `jti`,
 * and these kinds are found only through `find` with the presented value, then saved, consumed or destroyed by that
 * same id. Device codes are not here: the library finds them again by the id stored in a user-code lookup and in an
 * interaction, which a hash cannot give back (accepted gap, D1a).
 */
export const HASHED_KINDS = new Set(["AccessToken", "RefreshToken", "AuthorizationCode"])

/** The one-time kinds whose second use is reuse, and the end reason it gives. */
export const ONE_TIME = {
  RefreshToken: "refresh_reused",
  AuthorizationCode: "code_reused",
  DeviceCode: "code_reused",
} as const
export type OneTimeKind = keyof typeof ONE_TIME

export type StoreOptions = {
  /** The store's clock: the same as the services'. */
  now: () => Date
  /**
   * The loser of two uses of one refresh token or code at once (D1-X 2): the grant ends, with its connection, in one
   * transaction, as any reuse does. The library rejects only the request; ending the grant is Adiutor's policy.
   */
  onReuse: (grantId: string, kind: OneTimeKind) => Promise<void>
  /**
   * Sees every call the library makes, with the id it passed (never stored or logged): the pinning tests check what the
   * hashing relies on (D1-X 1). It changes nothing; production passes none.
   */
  observe?: (call: { kind: string; method: string; id: string; payload?: AdapterPayload }) => void
}

type Payload = AdapterPayload & Record<string, unknown>

/**
 * oidc-provider's storage on PostgreSQL (`oauth_store`), on its own small pool: an approval holds a transaction of the
 * main pool while the library stores its grant, which must never wait for a connection of the pool that transaction
 * holds. One row per record by kind and id, with the fields the library looks records up by. Records come back as
 * stored, expired or not: the library checks expiry itself (`ignoreExpiration` decides), and the sweep removes them.
 */
export function storeAdapter(db: Db, options: StoreOptions) {
  return class AdiutorStore implements Adapter {
    readonly hashed: boolean
    constructor(readonly name: string) {
      this.hashed = HASHED_KINDS.has(name)
    }

    private key(id: string) {
      return this.hashed ? sha256(id) : id
    }

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
      options.observe?.({ kind: this.name, method: "upsert", id, payload })
      let stored: Record<string, unknown> = payload
      if (this.hashed) {
        // Stored only when its value is its id: anything else would come back as a different record.
        if (payload.jti !== id) throw new Error(`${this.name}: the record's id is not its jti`)
        const { jti: _jti, ...rest } = payload
        stored = rest
      }
      const row = {
        type: this.name,
        id: this.key(id),
        payload: stored,
        grantId: typeof payload.grantId === "string" ? payload.grantId : null,
        userCode: typeof payload.userCode === "string" ? payload.userCode : null,
        uid: typeof payload.uid === "string" ? payload.uid : null,
        expiresAt: expiresIn ? new Date(options.now().getTime() + expiresIn * 1000) : null,
      }
      await db
        .insert(oauthStore)
        .values(row)
        .onConflictDoUpdate({ target: [oauthStore.type, oauthStore.id], set: row })
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      options.observe?.({ kind: this.name, method: "find", id })
      const found = await this.one(eq(oauthStore.id, this.key(id)))
      return found && this.hashed ? { ...found, jti: id } : found
    }

    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
      options.observe?.({ kind: this.name, method: "findByUserCode", id: userCode })
      return this.hashed ? undefined : this.one(eq(oauthStore.userCode, userCode))
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      options.observe?.({ kind: this.name, method: "findByUid", id: uid })
      return this.hashed ? undefined : this.one(eq(oauthStore.uid, uid))
    }

    /**
     * Atomic: of two requests that consume the same refresh token or code at once, one marks it; the other finds it
     * marked, and is reuse (S13, S14).
     */
    async consume(id: string): Promise<void> {
      options.observe?.({ kind: this.name, method: "consume", id })
      const key = this.key(id)
      const won = await db
        .update(oauthStore)
        .set({ consumedAt: options.now() })
        .where(and(eq(oauthStore.type, this.name), eq(oauthStore.id, key), isNull(oauthStore.consumedAt)))
        .returning({ id: oauthStore.id })
      if (won.length > 0) return
      const [row] = await db
        .select({ grantId: oauthStore.grantId })
        .from(oauthStore)
        .where(and(eq(oauthStore.type, this.name), eq(oauthStore.id, key)))
      if (row?.grantId && this.name in ONE_TIME) await options.onReuse(row.grantId, this.name as OneTimeKind)
      throw new errors.InvalidGrant(`${this.name} already used`)
    }

    async destroy(id: string): Promise<void> {
      options.observe?.({ kind: this.name, method: "destroy", id })
      await db.delete(oauthStore).where(and(eq(oauthStore.type, this.name), eq(oauthStore.id, this.key(id))))
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await db.delete(oauthStore).where(and(eq(oauthStore.type, this.name), eq(oauthStore.grantId, grantId)))
    }

    private async one(match: ReturnType<typeof eq>): Promise<Payload | undefined> {
      const [row] = await db
        .select()
        .from(oauthStore)
        .where(and(eq(oauthStore.type, this.name), match))
        .limit(1)
      if (!row) return undefined
      return {
        ...(row.payload as Payload),
        ...(row.consumedAt ? { consumed: Math.floor(row.consumedAt.getTime() / 1000) } : {}),
      }
    }
  }
}

/** Every record of a grant, of every kind, and the grant itself: what ending a connection removes. */
export async function deleteGrant(db: DbOrTx, grantId: string): Promise<void> {
  await db.delete(oauthStore).where(eq(oauthStore.grantId, grantId))
  await db.delete(oauthStore).where(and(eq(oauthStore.type, "Grant"), eq(oauthStore.id, grantId)))
}

/**
 * Every request still waiting: codes not yet exchanged, device requests, approvals not yet answered, the library's
 * sessions and the requests' approval records. Run with the exclusive gate when every connection ends.
 */
export async function cancelWaiting(tx: Tx): Promise<void> {
  await tx
    .delete(oauthStore)
    .where(inArray(oauthStore.type, ["AuthorizationCode", "DeviceCode", "Interaction", "Session"]))
  await tx.delete(agentConsent)
}

/** How many device requests are open (not expired, not approved): capped so nobody can fill the table. */
export async function openDeviceRequests(db: DbOrTx, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(oauthStore)
    .where(and(eq(oauthStore.type, "DeviceCode"), gt(oauthStore.expiresAt, now), isNull(oauthStore.grantId)))
  return row?.n ?? 0
}

/** The lock that registrations take while they count and make room: an advisory lock of its own ("adtp"). */
export const REGISTRATION_LOCK_KEY = 0x61647470

/**
 * Makes room for one more self-registered agent (RFC 7591) under a cap: when full, the oldest registrations no person
 * approved (no grant and no live connection) go first. False when no place can be freed. Runs under its own advisory
 * lock, so the count and the eviction of two transactions never interleave; the caller also holds the in-process
 * registration lock until the library has stored the new one.
 */
export async function roomForClient(db: Db, max: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(REGISTRATION_LOCK_KEY))})`)
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(oauthStore)
      .where(eq(oauthStore.type, "Client"))
    const over = (row?.n ?? 0) - max + 1
    if (over <= 0) return true
    const evicted = await tx.execute<{ id: string }>(sql`
      delete from oauth_store
      where type = 'Client' and id in (
        select c.id from oauth_store c
        where c.type = 'Client'
          and not exists (select 1 from oauth_store g where g.type = 'Grant' and g.payload->>'clientId' = c.id)
          and not exists (select 1 from agent_connections a where a.client_id = c.id and a.ended_at is null)
        order by coalesce((c.payload->>'client_id_issued_at')::bigint, 0), c.id
        limit ${over})
      returning id`)
    return [...evicted].length === over
  })
}

/**
 * The store's clean-up (S20), by the services' clock:
 * - records that expired more than a day ago, except refresh tokens: a spent refresh token of a live grant stays until
 *   its grant ends, so its reuse is seen for the whole life of the connection (D1k, P18);
 * - every record of a grant that no longer exists (left by an issuance that raced an end, D1f);
 * - registrations older than a day that no grant and no connection uses;
 * - approval records whose request ran out.
 * Grants without a live connection are removed by the sweep under the exclusive gate (oauth/access.ts).
 */
export async function sweepStore(db: DbOrTx, now: Date): Promise<void> {
  const dayAgo = new Date(now.getTime() - 86_400_000)
  await db.delete(oauthStore).where(and(lt(oauthStore.expiresAt, dayAgo), sql`${oauthStore.type} <> 'RefreshToken'`))
  await db.execute(sql`
    delete from oauth_store s
    where s.grant_id is not null and s.type <> 'Grant'
      and not exists (select 1 from oauth_store g where g.type = 'Grant' and g.id = s.grant_id)`)
  await db.execute(sql`
    delete from oauth_store c
    where c.type = 'Client'
      and coalesce((c.payload->>'client_id_issued_at')::bigint, 0) < ${Math.floor(dayAgo.getTime() / 1000)}
      and not exists (select 1 from oauth_store g where g.type = 'Grant' and g.payload->>'clientId' = c.id)
      and not exists (select 1 from agent_connections a where a.client_id = c.id and a.ended_at is null)`)
  await db.delete(agentConsent).where(lt(agentConsent.expiresAt, now))
}
