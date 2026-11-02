// "Disconnect all": the api-key plugin has no bulk delete, and its list answers at most 100 keys (the database
// adapter's default limit). So this lists, deletes every listed key, and lists again, until a fresh list comes back
// empty. A round that deletes nothing stops it (a refused delete, or Better Auth's 100 requests a minute per route),
// and the caller says how many keys are left: a full list (100) means at least that many, since more may lie
// beyond it.

export type KeyRef = { id: string }

/** The most keys one list answers (the database adapter's default limit). */
export const LIST_LIMIT = 100

export type Outcome = { removed: number; remaining: number; atLeast: boolean }

const left = (removed: number, keys: KeyRef[]): Outcome => ({
  removed,
  remaining: keys.length,
  atLeast: keys.length >= LIST_LIMIT,
})

/** Rounds of list then delete before giving up: far more than any owner's keys need. */
const MAX_ROUNDS = 50

export async function disconnectEvery(
  list: () => Promise<KeyRef[]>,
  remove: (id: string) => Promise<void>,
): Promise<Outcome> {
  let removed = 0
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const keys = await list()
    if (keys.length === 0) return left(removed, keys)
    let progress = 0
    for (const key of keys) {
      try {
        await remove(key.id)
        progress++
      } catch {
        // Counted below: the key is still in the next list.
      }
    }
    removed += progress
    if (progress === 0) return left(removed, keys)
  }
  return left(removed, await list())
}
