import { and, eq, isNull, sql } from "drizzle-orm"
import { SETTINGS_DEFAULTS } from "../../shared/settings.ts"
import type { Db } from "../db/client.ts"
import { agentConnections, settings } from "../db/schema.ts"

/*
 * Whether the sync is connected, for the morning read (services/reads.ts): a live agent connection holds the `sync`
 * area. Every way a connection ends (Disconnect, agents off, the idle days, a reused refresh token, a new public URL,
 * an identity change) sets its end. A connection past the idle days is refused at once but ended only by the next
 * sweep, so it counts as ended here already, by the token check's rule (oauth/access.ts): last used, or approved when
 * never used, within the idle days. This module loads nothing of the authorization server: the morning read and its
 * message never start it.
 */
export async function syncConnected(db: Db, now: Date): Promise<boolean> {
  const [config] = await db.select({ idleDays: settings.agentIdleDays }).from(settings).where(eq(settings.id, 1))
  const idleDays = config?.idleDays ?? SETTINGS_DEFAULTS.agentIdleDays
  const cutoff = new Date(now.getTime() - idleDays * 86_400_000)
  const [row] = await db
    .select({ id: agentConnections.id })
    .from(agentConnections)
    .where(
      and(
        isNull(agentConnections.endedAt),
        sql`'sync' = any(${agentConnections.areas})`,
        sql`coalesce(${agentConnections.lastUsedAt}, ${agentConnections.approvedAt}) >= ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .limit(1)
  return row !== undefined
}
