import { and, isNull, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { agentConnections } from "../db/schema.ts"

/*
 * Whether the sync is connected, for the morning read (services/reads.ts): a live agent connection holds the `sync`
 * area. Every way a connection ends (Disconnect, agents off, the idle days, a reused refresh token, a new public URL,
 * an identity change) sets its end, so none of them leaves the sync shown as connected. This module loads nothing of
 * the authorization server: the morning read and its message never start it.
 */
export async function syncConnected(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ id: agentConnections.id })
    .from(agentConnections)
    .where(and(isNull(agentConnections.endedAt), sql`'sync' = any(${agentConnections.areas})`))
    .limit(1)
  return row !== undefined
}
