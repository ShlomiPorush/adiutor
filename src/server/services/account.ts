import { count } from "drizzle-orm"
import { authUser } from "../db/schema.ts"
import type { Ctx } from "./context.ts"

// The owner account is Better Auth's (src/server/auth/auth.ts). Adiutor only reads whether it exists.

export async function hasOwner(ctx: Ctx): Promise<boolean> {
  const [row] = await ctx.db.select({ n: count() }).from(authUser)
  return (row?.n ?? 0) > 0
}
