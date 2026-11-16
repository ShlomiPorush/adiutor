import { randomUUID } from "node:crypto"
import { agentConnections } from "../db/schema.ts"
import type { Ctx } from "../services/context.ts"

/**
 * A live connection of the sync, as an approval leaves its record, for tests of what reads it (the morning read and
 * its message). It has no grant: tests of agent access itself connect through the authorization server
 * (testing/oauth.ts).
 */
export async function addSyncConnection(ctx: Pick<Ctx, "db" | "clock">): Promise<string> {
  const [row] = await ctx.db
    .insert(agentConnections)
    .values({
      name: "Laptop sync",
      connectedVia: "code",
      resource: "rest",
      areas: ["sync"],
      clientId: "adiutor-agent",
      grantId: randomUUID(),
      issuer: "http://127.0.0.1:8090",
      approvedAt: ctx.clock(),
    })
    .returning({ id: agentConnections.id })
  return row?.id as string
}
