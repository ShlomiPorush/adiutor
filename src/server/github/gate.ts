import { sql } from "drizzle-orm"
import type { Tx } from "../services/context.ts"

/**
 * The key of the transaction-level advisory lock between saves of GitHub settings and the writes of a pull: a save
 * takes it exclusive, a pull's write shared, each as the first statement of its transaction. So a pull compares the
 * stored generation with its own while no save can commit, and a save waits for a pull's write that already holds it.
 * The value spells "gith" in ASCII and fits in 31 bits.
 */
export const GITHUB_LOCK_KEY = 0x67697468

export async function lockGitHubExclusive(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(GITHUB_LOCK_KEY))})`)
}

export async function lockGitHubShared(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${sql.raw(String(GITHUB_LOCK_KEY))})`)
}

/**
 * What a running pull may send, in this process (the server is one process). Every save of a GitHub field goes
 * through `save`: saves run one at a time, in order, and from the moment one is queued until the last queued save has
 * committed and published its generation, no request of any pull is sent. A pull of an older generation never sends
 * again after that. So no request under old settings is sent once a save's commit can be visible (plan R4-P54, P63).
 */
export class GitHubGate {
  private published: number
  private saving = 0
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  constructor(generation: number) {
    this.published = generation
  }

  /** The generation of the settings in effect, as last published by a save (or read at start). */
  get generation(): number {
    return this.published
  }

  /** Whether a pull started under `generation` may send a request now. */
  maySend(generation: number): boolean {
    return this.saving === 0 && this.published === generation
  }

  /** Called when a save is queued: a running pull stops at once instead of failing request by request. */
  onSave(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Runs one save after every save queued before it. `work` commits and answers the new generation, or null when it
   * changed nothing (a refusal): the mark is held until the work settled and its generation was published.
   */
  save<T>(work: () => Promise<{ result: T; generation: number | null }>): Promise<T> {
    this.saving++
    for (const listener of this.listeners) listener()
    const run = this.queue.then(async () => {
      try {
        const { result, generation } = await work()
        if (generation !== null) this.published = generation
        return result
      } finally {
        this.saving--
      }
    })
    this.queue = run.catch(() => {})
    return run
  }
}
