import { count, eq } from "drizzle-orm"
import { authUser, devices } from "../db/schema.ts"
import type { Ctx } from "./context.ts"

// The owner account is Better Auth's (src/server/auth/auth.ts). Mikud only reads whether it exists, and keeps its
// own browser identity for "new since your last visit".

export async function hasOwner(ctx: Ctx): Promise<boolean> {
  const [row] = await ctx.db.select({ n: count() }).from(authUser)
  return (row?.n ?? 0) > 0
}

// --- Browser identity (the mikud_browser cookie): "new since your last visit" per browser, never a credential ---

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The browser row the cookie names, or a new one when it names none (first signed-in request, or a cookie of
 * another installation). Records when it was last seen, once a minute. Bookkeeping, not a change: no audit row.
 */
export async function ensureBrowser(ctx: Ctx, cookie: string | undefined): Promise<{ id: string; created: boolean }> {
  const now = ctx.clock()
  if (cookie && UUID.test(cookie)) {
    const [row] = await ctx.db.select().from(devices).where(eq(devices.id, cookie))
    if (row) {
      if (!row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() > 60_000)
        await ctx.db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, row.id))
      return { id: row.id, created: false }
    }
  }
  const [row] = await ctx.db
    .insert(devices)
    .values({ label: "Browser", createdAt: now, lastSeenAt: now })
    .returning({ id: devices.id })
  if (!row) throw new Error("insert returned no row")
  return { id: row.id, created: true }
}
