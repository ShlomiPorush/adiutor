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

/** Agent text is refused when it looks like a secret; the answer names the rule and the field only. */
export function checkAgentText(ctx: Ctx, by: By, fields: Record<string, string | null | undefined>): void {
  if (by.actor.kind !== "agent") return
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

/** Runs a write in one transaction. */
export function inTx<T>(ctx: Ctx, run: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.db.transaction(run)
}
