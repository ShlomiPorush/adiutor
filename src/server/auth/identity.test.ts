import { describe, expect, it } from "vitest"
import type { By } from "../services/context.ts"
import { identityChangeTracker } from "./identity.ts"

// The tracking of identity changes for agent access, with Better Auth's hook contexts reduced to what it reads: the
// release that hooks.after runs after an APIError (a path Better Auth 1.7.19 never takes with Adiutor's configuration,
// see identity.ts) finishes exactly the changes its own call began.

const owner: By = { actor: { kind: "owner", label: "owner" }, source: "ui" }

function recorder() {
  const calls: string[] = []
  let next = 0
  return {
    calls,
    changes: {
      async begin(by: By) {
        next++
        calls.push(`begin ${next} ${by.actor.label}`)
        return `change-${next}`
      },
      async finish(id: string, by: By) {
        calls.push(`finish ${id} ${by.actor.label}`)
      },
    },
  }
}

describe("the identity-change tracker", () => {
  it("releases in hooks.after, by the same request, the change begun in the database hook, once", async () => {
    const r = recorder()
    const tracker = identityChangeTracker(r.changes, async () => owner)
    const request = new Request("http://127.0.0.1/api/auth/change-password", { method: "POST" })
    // The database before hook: the endpoint context with the session Better Auth read.
    await tracker.begin({ path: "/change-password", request, context: { session: { id: "s" } } })
    // hooks.after: another context object of the same call, with the same request.
    await tracker.release({ path: "/change-password", request, context: {} })
    await tracker.release({ path: "/change-password", request, context: {} })
    expect(r.calls).toEqual(["begin 1 owner", "finish change-1 owner"])
  })

  it("never releases another call's change", async () => {
    const r = recorder()
    const tracker = identityChangeTracker(r.changes, async () => owner)
    const mine = new Request("http://127.0.0.1/api/auth/two-factor/disable", { method: "POST" })
    const other = new Request("http://127.0.0.1/api/auth/two-factor/disable", { method: "POST" })
    await tracker.begin({ request: mine, context: { session: {} } })
    await tracker.release({ request: other, context: {} })
    expect(r.calls).toEqual(["begin 1 owner"])
  })

  it("refuses an HTTP change without the session Better Auth read, and begins nothing", async () => {
    const r = recorder()
    const tracker = identityChangeTracker(r.changes, async () => owner)
    const request = new Request("http://127.0.0.1/api/auth/change-password", { method: "POST" })
    await expect(tracker.begin({ request, context: {} })).rejects.toMatchObject({ statusCode: 401 })
    expect(r.calls).toEqual([])
  })

  it("tracks a server call (the recovery command) by its per-call auth context, as the command", async () => {
    const r = recorder()
    const tracker = identityChangeTracker(r.changes, async () => owner)
    const call = {}
    await tracker.begin({ path: "/reset-password", context: call })
    await tracker.release({ path: "/reset-password", context: call })
    expect(r.calls).toEqual(["begin 1 cli", "finish change-1 cli"])
  })

  it("keeps the change when finishing it fails, without throwing", async () => {
    const r = recorder()
    r.changes.finish = async () => {
      throw new Error("down")
    }
    const tracker = identityChangeTracker(r.changes, async () => owner)
    const call = {}
    await tracker.begin({ context: call })
    await expect(tracker.release({ context: call })).resolves.toBeUndefined()
  })

  it("does nothing where agent access is not mounted", async () => {
    const tracker = identityChangeTracker(undefined, async () => owner)
    await tracker.begin({ request: new Request("http://127.0.0.1/x"), context: {} })
    await tracker.release({})
  })
})
