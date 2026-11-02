import { sql } from "drizzle-orm"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import { telegramUpdates } from "./schema.ts"

// The driver's transaction and savepoint contract that the services rely on (the bot's update and its inbox item
// share one transaction, the item in a savepoint): a transaction whose connection was lost must reject and store
// nothing (a savepoint inside it may still resolve, see below), and a rollback must undo exactly its own writes.

let t: TestDatabase
let killer: postgres.Sql

beforeAll(async () => {
  t = await createTestDatabase("tx")
  killer = postgres(t.url, { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  await killer?.end({ timeout: 5 })
  await t?.close()
})

beforeEach(async () => {
  await t.reset()
})

type Tx = Parameters<Parameters<TestDatabase["ctx"]["db"]["transaction"]>[0]>[0]

const record = (tx: Tx, updateId: number) =>
  tx.insert(telegramUpdates).values({ updateId, outcome: "ignored", at: t.clock.now() })

const stored = async () =>
  (await t.ctx.db.select({ id: telegramUpdates.updateId }).from(telegramUpdates)).map((row) => row.id).sort()

/** Ends the backend that runs `tx` and waits until it is gone. */
async function loseConnection(tx: Tx) {
  const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
  if (!row) throw new Error("no backend pid")
  const [ended] = await killer<{ ok: boolean }[]>`select pg_terminate_backend(${row.pid}::int, 5000) as ok`
  expect(ended?.ok).toBe(true)
}

describe("a lost connection", () => {
  // The driver races the transaction against the connection's close, so the transaction can reject while its
  // callback is still running. Each test keeps the callback's own promise and waits for it to settle before it
  // asserts on what the callback reached.
  // The savepoint itself may still resolve after its connection was lost (porsager/postgres#1281, unreleased fix;
  // the owner accepted it with 4.0.0). What holds is that the next write and the transaction fail and nothing is
  // stored, so the test asserts only that.
  it("rejects the transaction when the connection is lost inside a savepoint, and stores nothing", async () => {
    let body: Promise<void> | undefined
    const run = t.ctx.db.transaction((tx) => {
      body = (async () => {
        await record(tx, 1)
        await tx.transaction(async (sp) => {
          await record(sp, 2)
          await loseConnection(sp)
        })
        await record(tx, 3)
      })()
      return body
    })
    await expect(run).rejects.toThrow()
    await expect(body).rejects.toThrow()
    expect(await stored()).toEqual([])
  })

  it("rejects the transaction when the connection is lost after a savepoint, and stores nothing", async () => {
    let body: Promise<void> | undefined
    const run = t.ctx.db.transaction((tx) => {
      body = (async () => {
        await record(tx, 1)
        await tx.transaction((sp) => record(sp, 2))
        await loseConnection(tx)
      })()
      return body
    })
    await expect(run).rejects.toThrow()
    await Promise.allSettled([body])
    expect(await stored()).toEqual([])
  })

  it("leaves the pool usable afterwards", async () => {
    await expect(
      t.ctx.db.transaction(async (tx) => {
        await tx.transaction((sp) => loseConnection(sp))
      }),
    ).rejects.toThrow()
    await t.ctx.db.transaction((tx) => record(tx, 4))
    expect(await stored()).toEqual([4])
  })
})

describe("a rollback", () => {
  it("undoes only the savepoint's writes when the savepoint throws, and the transaction commits the rest", async () => {
    await t.ctx.db.transaction(async (tx) => {
      await record(tx, 1)
      await expect(
        tx.transaction(async (sp) => {
          await record(sp, 2)
          throw new Error("refused")
        }),
      ).rejects.toThrow("refused")
      await record(tx, 3)
    })
    expect(await stored()).toEqual([1, 3])
  })

  it("undoes only the savepoint's writes when the server refuses a statement in it", async () => {
    await t.ctx.db.transaction(async (tx) => {
      await record(tx, 1)
      await expect(
        tx.transaction(async (sp) => {
          await record(sp, 2)
          await record(sp, 1)
        }),
      ).rejects.toMatchObject({ cause: { code: "23505" } })
      await record(tx, 3)
    })
    expect(await stored()).toEqual([1, 3])
  })

  it("undoes the savepoint's released writes when the transaction throws", async () => {
    await expect(
      t.ctx.db.transaction(async (tx) => {
        await record(tx, 1)
        await tx.transaction((sp) => record(sp, 2))
        throw new Error("refused")
      }),
    ).rejects.toThrow("refused")
    expect(await stored()).toEqual([])
  })
})
