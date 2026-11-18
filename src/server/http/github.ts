import type { Context, Hono } from "hono"
import { z } from "zod"
import { githubAppBody, githubInstallationBody } from "../../shared/api.ts"
import { DEFAULT_GITHUB_API_ORIGIN } from "../config.ts"
import { invalid, notFound } from "../errors.ts"
import { GitHubGate } from "../github/gate.ts"
import { GitHubRunner } from "../github/runner.ts"
import type { SettingsEnv } from "../services/admin.ts"
import type { Ctx } from "../services/context.ts"
import {
  addGitHubInstallation,
  type GitHubDeps,
  gitHubView,
  removeGitHubInstallation,
  saveGitHubApp,
} from "../services/github.ts"
import { byOf, type Env, requireOwnerAuth } from "./auth.ts"

/** The server's GitHub reading: the gate of its settings saves, the runner of its pulls and the API origin. */
export type GitHubHandle = { gate: GitHubGate; runner: GitHubRunner; origin: string }

/** Builds the handle; index.ts starts its runner after the server listens. */
export function createGitHubHandle(options: {
  ctx: Ctx
  env: SettingsEnv
  generation: number
  origin?: string
  beforeWrite?: () => Promise<void>
}): GitHubHandle {
  const origin = options.origin ?? DEFAULT_GITHUB_API_ORIGIN
  const gate = new GitHubGate(options.generation)
  const runner = new GitHubRunner({ ctx: options.ctx, env: options.env, gate, origin, beforeWrite: options.beforeWrite })
  return { gate, runner, origin }
}

async function json<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw invalid("The request body must be JSON.")
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success)
    throw invalid("The request body is not valid.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    })
  return parsed.data
}

const generationQuery = z.object({ generation: z.coerce.number().int().min(0) })

/**
 * The owner's GitHub routes under /api/v1/github (each closed to agents in agents/policy.ts). Every answer is
 * `Cache-Control: no-store`; none carries the private key.
 */
export function githubRoutes(api: Hono<Env>, deps: { ctx: Ctx; env: SettingsEnv; github: GitHubHandle }) {
  const { ctx, github } = deps
  const service: GitHubDeps = { env: deps.env, gate: github.gate, origin: github.origin }
  const view = () => gitHubView(ctx, service, github.runner)

  api.use("/github", async (c, next) => {
    await next()
    c.header("Cache-Control", "no-store")
  })
  api.use("/github/*", async (c, next) => {
    await next()
    c.header("Cache-Control", "no-store")
  })
  api.get("/github", requireOwnerAuth, async (c) => c.json({ data: await view() }))
  api.patch("/github/app", requireOwnerAuth, async (c) => {
    await saveGitHubApp(ctx, byOf(c), service, await json(c, githubAppBody))
    return c.json({ data: await view() })
  })
  api.post("/github/installations", requireOwnerAuth, async (c) => {
    await addGitHubInstallation(ctx, byOf(c), service, await json(c, githubInstallationBody))
    return c.json({ data: await view() }, 201)
  })
  api.delete("/github/installations/:id", requireOwnerAuth, async (c) => {
    const id = Number(c.req.param("id"))
    if (!Number.isSafeInteger(id) || id < 1) throw notFound("The installation")
    const parsed = generationQuery.safeParse({ generation: c.req.query("generation") })
    if (!parsed.success) throw invalid("generation is required.", { field: "generation" })
    await removeGitHubInstallation(ctx, byOf(c), service, { generation: parsed.data.generation, installationId: id })
    return c.json({ data: await view() })
  })
  api.post("/github/pull", requireOwnerAuth, async (c) => {
    const { joined } = await github.runner.readNow()
    return c.json({ data: { joined, view: await view() } }, 202)
  })
}
