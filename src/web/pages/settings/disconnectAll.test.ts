import { describe, expect, it } from "vitest"
import { disconnectEvery, type KeyRef } from "./disconnectAll.ts"

/** A stand-in for the api-key plugin: the list answers at most 100 keys, as the database adapter does. */
function plugin(count: number, failing = new Set<string>()) {
  const keys: KeyRef[] = Array.from({ length: count }, (_, i) => ({ id: `key-${i}` }))
  let lists = 0
  return {
    keys,
    lists: () => lists,
    list: async () => {
      lists++
      return keys.slice(0, 100)
    },
    remove: async (id: string) => {
      if (failing.has(id)) throw new Error("refused")
      keys.splice(
        keys.findIndex((k) => k.id === id),
        1,
      )
    },
  }
}

describe("Disconnect all", () => {
  it("deletes all 101 keys although each list answers at most 100, and stops at an empty list", async () => {
    const p = plugin(101)
    expect(await disconnectEvery(p.list, p.remove)).toEqual({ removed: 101, remaining: 0, atLeast: false })
    expect(p.keys).toEqual([])
    // 100, then 1, then the empty list that confirms it.
    expect(p.lists()).toBe(3)
  })

  it("stops when a round deletes nothing and says how many are left", async () => {
    const p = plugin(101, new Set(["key-100", "key-3"]))
    expect(await disconnectEvery(p.list, p.remove)).toEqual({ removed: 99, remaining: 2, atLeast: false })
    expect(p.keys.map((k) => k.id)).toEqual(["key-3", "key-100"])
  })

  it("says at least 100 are left when a full list cannot be deleted, since more may lie beyond it", async () => {
    // 201 keys; deletes stop after 100, as the per-route rate limit would stop one browser.
    const p = plugin(201)
    let deletes = 0
    const limited = async (id: string) => {
      deletes++
      if (deletes > 100) throw new Error("rate limited")
      await p.remove(id)
    }
    expect(await disconnectEvery(p.list, limited)).toEqual({ removed: 100, remaining: 100, atLeast: true })
    expect(p.keys).toHaveLength(101)
  })

  it("lets a failed list reach the caller", async () => {
    await expect(
      disconnectEvery(
        async () => {
          throw new Error("offline")
        },
        async () => {},
      ),
    ).rejects.toThrow("offline")
  })
})
