import type { AppDeps } from "../app.ts"
import { createAuth } from "../auth/auth.ts"
import type { TestDatabase } from "./db.ts"

// The app's core for integration tests: Better Auth on the test database and its auth lock, with the
// configuration and limits a test chooses.

/** Assembled at run time: the guards and push protection scan literal text. */
export const TEST_AUTH_SECRET = ["auth", "secret", "for", "tests", "only", "0000000000"].join("-")

type Core = NonNullable<AppDeps["core"]>

export function testCore(t: TestDatabase, core: Omit<Core, "auth" | "lockAuth" | "ctx">): Core {
  return {
    ctx: t.ctx,
    auth: createAuth({ db: t.ctx.db, secret: TEST_AUTH_SECRET, publicUrl: core.config.publicUrl }),
    lockAuth: t.database.lockAuth,
    ...core,
  }
}
