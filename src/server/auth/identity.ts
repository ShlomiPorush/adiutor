import { APIError } from "better-auth/api"
import { errorFacts, log } from "../log.ts"
import type { By } from "../services/context.ts"

/**
 * Agent access around an identity change of the owner (D7, oauth/access.ts): `begin` ends every agent connection and
 * closes approvals before Better Auth writes an authorized change; `finish` ends them again and opens approvals once the
 * change was written or refused.
 */
export type IdentityChanges = {
  begin(by: By): Promise<string>
  finish(id: string, by: By): Promise<void>
}

type HookContext = { path?: string; request?: Request; context?: { session?: unknown } } | null | undefined

/*
 * Identity changes (D7): a password change, the recovery command's reset and turning two-factor off (also the first
 * step of a new authenticator) end every agent connection. The database hooks run only once Better Auth has verified
 * the change (the session, the password or the reset token), right before it writes it: `begin` ends every connection
 * and closes approvals in one transaction of Adiutor's own. A request over HTTP without a session Better Auth read is
 * refused there (fail closed). `release` runs in the matching database after hook (after the write commits) and in
 * hooks.after. A failure that is not an APIError runs neither: the change's record stays and approvals stay closed
 * until its process ends and the next start or sweep finishes it, or the owner's Disconnect all clears it when no
 * provably live process owns it (an open gap pending the owner's decision, see the foundation plan). Changes are
 * tracked per call: by its request, or for a server call by its per-call auth context.
 *
 * The release in hooks.after is the path for an APIError thrown after `begin` and before the database after hook. In
 * Better Auth 1.7.19 with Adiutor's configuration none can be thrown there:
 * - password change (`api/routes/update-user.mjs:173-180`): after `updateAccount` only `createSession` follows in the
 *   transaction, and its APIError (`:178`) needs a `session.create.before` hook that returns false
 *   (`db/with-hooks.mjs:18`); Adiutor's never does;
 * - the recovery command's reset (`utils/password.mjs:32-45`): `updatePassword` is the transaction's last step, and
 *   `onPasswordReset` (`api/routes/password.mjs:164`) is not set;
 * - turning two-factor off, also the first step of a new authenticator (`plugins/two-factor/index.mjs:275`): the
 *   update runs outside a transaction, so its after hook runs at once (`@better-auth/core` `context/transaction.mjs:139`).
 * The release there stays as the documented after hook for such a path in a later version; `identity.test.ts` covers
 * it directly.
 */
export function identityChangeTracker(identity: IdentityChanges | undefined, ownerBy: () => Promise<By>) {
  const begun = new WeakMap<object, { id: string; by: By }[]>()
  const serverCall = {}
  const callKey = (context: unknown): object => {
    const c = context as { request?: Request; context?: unknown } | null | undefined
    if (c?.request) return c.request
    return c?.context && typeof c.context === "object" ? c.context : serverCall
  }
  return {
    /** Before Better Auth writes the change: refuses an HTTP request without the session Better Auth read. */
    async begin(context: unknown): Promise<void> {
      if (!identity) return
      const hook = context as HookContext
      let by: By
      if (hook?.request) {
        if (!hook.context?.session)
          throw new APIError("UNAUTHORIZED", {
            code: "SESSION_REQUIRED",
            message: "Sign in again, then make the change.",
          })
        by = await ownerBy()
      } else {
        by = { actor: { kind: "system", label: hook?.path === "/reset-password" ? "cli" : "system" }, source: "cli" }
      }
      const id = await identity.begin(by)
      const key = callKey(context)
      begun.set(key, [...(begun.get(key) ?? []), { id, by }])
    },
    /** After the change was written or refused: finishes every change this call began. Never throws. */
    async release(context: unknown): Promise<void> {
      if (!identity) return
      const key = callKey(context)
      const changes = begun.get(key)
      if (!changes?.length) return
      begun.delete(key)
      for (const change of changes) {
        try {
          await identity.finish(change.id, change.by)
        } catch (error) {
          // Its record stays: approvals stay closed until it is finished later (the safe side).
          log.error("an identity change could not be finished for agent access", errorFacts(error))
        }
      }
    },
  }
}
