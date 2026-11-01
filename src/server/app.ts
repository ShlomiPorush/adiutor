import { Hono } from "hono"

export type AppDeps = {
  /** True when the database answers a trivial query. */
  checkDatabase(): Promise<boolean>
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  // Container health: the process serves and the database answers. No token: it reveals nothing.
  app.get("/healthz", async (c) => {
    const database = await deps.checkDatabase()
    return c.json({ status: database ? "ok" : "unavailable", database: database ? "ok" : "down" }, database ? 200 : 503)
  })

  return app
}
