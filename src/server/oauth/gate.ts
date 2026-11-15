import { eq, sql } from "drizzle-orm"
import { agentIdentityChanges, agentState } from "../db/schema.ts"
import type { DbOrTx, Tx } from "../services/context.ts"

/**
 * One PostgreSQL advisory lock keeps making a connection and ending connections apart (S19). Making one (answering an
 * approval) takes it shared; every end (one connection, all of them, agents turned off, a new idle period, an identity
 * change, a new issuer, the sweep of grants without a connection) takes it exclusive. Both hold it until their
 * transaction ends, so an approval either finished before an end began, and the end then ends what it made, or it runs
 * after the end and sees it. It is the first statement of each such transaction. The value spells "adto" in ASCII and
 * differs from the link structure lock (services/context.ts).
 */
export const AGENT_GATE_KEY = 0x6164746f

export async function gateShared(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${sql.raw(String(AGENT_GATE_KEY))})`)
}

export async function gateExclusive(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(AGENT_GATE_KEY))})`)
}

/** The single state row (id 1): created at start, idempotently. */
export async function ensureState(db: DbOrTx): Promise<void> {
  await db.insert(agentState).values({ id: 1 }).onConflictDoNothing()
}

/** The current generation: it goes up whenever every connection and every waiting request end. */
export async function generation(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ generation: agentState.generation }).from(agentState).where(eq(agentState.id, 1))
  return row?.generation ?? 0
}

/**
 * Starts a new generation, with the exclusive gate held, in the transaction that ends everything: a request that began
 * under the earlier generation can no longer be approved, even when the authorization server stores its records after.
 */
export async function nextGeneration(tx: Tx): Promise<number> {
  const [row] = await tx
    .insert(agentState)
    .values({ id: 1, generation: 1 })
    .onConflictDoUpdate({ target: agentState.id, set: { generation: sql`${agentState.generation} + 1` } })
    .returning({ generation: agentState.generation })
  return row?.generation ?? 0
}

/** The issuer fingerprint connections were last made under, or null before the first start that recorded one. */
export async function storedFingerprint(db: DbOrTx): Promise<string | null> {
  const [row] = await db
    .select({ fingerprint: agentState.issuerFingerprint })
    .from(agentState)
    .where(eq(agentState.id, 1))
  return row?.fingerprint ?? null
}

export async function storeFingerprint(db: DbOrTx, fingerprint: string): Promise<void> {
  await db
    .insert(agentState)
    .values({ id: 1, issuerFingerprint: fingerprint })
    .onConflictDoUpdate({ target: agentState.id, set: { issuerFingerprint: fingerprint } })
}

/** Whether an identity change is under way: no approval is answered meanwhile. */
export async function identityChanging(db: DbOrTx): Promise<boolean> {
  const [row] = await db.select({ id: agentIdentityChanges.id }).from(agentIdentityChanges).limit(1)
  return Boolean(row)
}
