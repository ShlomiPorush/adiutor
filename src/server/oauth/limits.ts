/**
 * Requests per key (a client address or a session) in a fixed window, in memory: Adiutor runs as one process, and a
 * restart forgets them. `take` counts synchronously, so a caller that counts before its first `await` lets no two
 * requests sent at once both pass (S20). `give` returns one counted request (a device poll whose code turned out to be
 * waiting or approved). `firstOver` is true once per window, when the key first went over: the moment to audit it.
 */
export class WindowLimit {
  private readonly hits = new Map<string, { count: number; start: number; reported: boolean }>()

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private current(key: string) {
    const now = this.now()
    const hit = this.hits.get(key)
    if (hit && now - hit.start < this.windowMs) return hit
    if (this.hits.size > 10_000) for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k)
    const fresh = { count: 0, start: now, reported: false }
    this.hits.set(key, fresh)
    return fresh
  }

  /** Counts one request; false when the key is over its limit (the request is refused and still counted). */
  take(key: string): boolean {
    const hit = this.current(key)
    hit.count++
    return hit.count <= this.max
  }

  /** Whether the key is over its limit in the current window, without counting anything. */
  blocked(key: string): boolean {
    const hit = this.hits.get(key)
    return Boolean(hit && this.now() - hit.start < this.windowMs && hit.count > this.max)
  }

  /** Gives one counted request back. */
  give(key: string): void {
    const hit = this.hits.get(key)
    if (hit && hit.count > 0) hit.count--
  }

  /** True once per window for a key over its limit. */
  firstOver(key: string): boolean {
    const hit = this.current(key)
    if (hit.count <= this.max || hit.reported) return false
    hit.reported = true
    return true
  }
}

/**
 * One holder at a time, in this process: a cap is counted and filled under it, and it is released when the
 * authorization server has finished the request that fills the place (never on a timer).
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve()

  /** Waits for the turn; resolves to the function that releases it (calling it twice does nothing). */
  acquire(): Promise<() => void> {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const turn = this.tail.then(() => {
      let released = false
      return () => {
        if (released) return
        released = true
        release()
      }
    })
    this.tail = this.tail.then(() => held)
    return turn
  }
}
