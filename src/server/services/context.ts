import { sql } from "drizzle-orm"
import type { ActorKind, AuditSource } from "../../shared/enums.ts"
import type { Db } from "../db/client.ts"
import { audit } from "../db/schema.ts"
import { AppError, forbidden } from "../errors.ts"
import type { SecretScanner } from "./secrets.ts"

/** What every service needs. `clock` is injectable so tests can move time. */
export type Ctx = {
  db: Db
  secrets: SecretScanner
  clock: () => Date
}

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
export type DbOrTx = Db | Tx

export type Actor = { kind: ActorKind; label: string }

/** Who makes a change and through which door. Every write takes one. */
export type By = { actor: Actor; source: AuditSource }

export const SYSTEM: By = { actor: { kind: "system", label: "system" }, source: "api" }

export function requireOwner(by: By, what: string): void {
  if (by.actor.kind !== "owner") throw forbidden(`Only the owner can ${what}.`)
}

/**
 * Text from agents and the Telegram bot is refused when it looks like a secret; the answer names the rule and
 * the field only. The owner's own text and the sync (it redacts instead) are not checked.
 */
export function checkAgentText(ctx: Ctx, by: By, fields: Record<string, string | null | undefined>): void {
  if (by.actor.kind !== "agent" && by.actor.kind !== "bot") return
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue
    const rule = ctx.secrets.find(value)
    if (rule)
      throw new AppError(
        "secret_suspected",
        `The ${field} looks like it contains a secret (${rule}). Remove it and write it again.`,
        { rule, field },
      )
  }
}

/** Dates as ISO strings, so the audit JSON is stable and readable. */
function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

export type AuditEntry = {
  action: string
  entityType: string
  entityId: string | null
  before?: unknown
  after?: unknown
}

/** Writes an audit row. Call it inside the transaction of the change it records. */
export async function writeAudit(ctx: Ctx, tx: DbOrTx, by: By, entry: AuditEntry): Promise<void> {
  await tx.insert(audit).values({
    at: ctx.clock(),
    actorKind: by.actor.kind,
    actorLabel: by.actor.label,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: plain(entry.before),
    after: plain(entry.after),
    source: by.source,
  })
}

/**
 * The key of the one transaction-level advisory lock that serializes every change to the structure of
 * thread links and suppressions: creating, moving, linking and deleting thread links, the sync's creation
 * of items and projects, the owner's deletes of items and projects, and writing or removing suppressions.
 * Each such transaction takes it as its first statement (`inLinkTx`), before it reads or locks any row.
 * A transaction then never waits for this lock while it holds a row lock, so these transactions cannot
 * deadlock with each other, and a check of a suppression or a link under the lock stays true until
 * commit. Mikud has one owner and a low write volume: running these transactions one at a time costs
 * nothing noticeable. The value spells "mikd" in ASCII and fits in 31 bits.
 */
export const LINK_STRUCTURE_LOCK_KEY = 0x6d696b64

/**
 * The key of the advisory lock that serializes every change to the owner's credentials and sessions. Mikud's
 * auth services (setup, the password change, ending sessions, the clock sweep) and the recovery CLI take it as
 * the first statement of their transaction (`inAuthTx`, `pg_advisory_xact_lock`). Every state-changing Better
 * Auth request (sign-in, sign-out, TOTP enable and verify) holds it as a session-level lock on a connection of
 * its own for the whole request (`Database.lockAuth`, http/auth-guard.ts). The two conflict, so all auth state
 * changes run one at a time: fine for one owner. "mkau" in ASCII.
 */
export const AUTH_LOCK_KEY = 0x6d6b6175

/** Takes the link structure lock (see LINK_STRUCTURE_LOCK_KEY); released at commit or rollback. */
export async function lockLinkStructure(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(LINK_STRUCTURE_LOCK_KEY))})`)
}

/** Runs a write in one transaction. */
export function inTx<T>(ctx: Ctx, run: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.db.transaction(run)
}

/**
 * Runs a write that changes the link structure in one transaction whose first statement takes the link
 * structure lock (see LINK_STRUCTURE_LOCK_KEY).
 */
export function inLinkTx<T>(ctx: Ctx, run: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    await lockLinkStructure(tx)
    return run(tx)
  })
}

/** Runs an auth write in one transaction whose first statement takes the auth lock (see AUTH_LOCK_KEY). */
export function inAuthTx<T>(ctx: Ctx, run: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(AUTH_LOCK_KEY))})`)
    return run(tx)
  })
}
