// For the sync's tests only: a stand-in T3 with both sides the sync uses. Its HTTP side, on 127.0.0.1, answers the
// environment descriptor and `GET /api/projects` for a bearer session; its CLI side is a runner that answers
// `t3 auth session issue|list|revoke` and `t3 thread list`. Sessions belong to the environment the CLI issued them
// in, so a CLI and an address of different environments do not accept each other's sessions, as in T3. Every session
// id, token and environment id is made with randomBytes or randomUUID per run.

import { randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { Runner } from "./exec.ts"

/** The placeholder environment id in the thread fixtures' links; the CLI answers with its own environment's id. */
export const FIXTURE_ENVIRONMENT = "fixture-env"

type FakeSession = {
  sessionId: string
  token: string
  label: string
  environmentId: string
  expiresAt: number
  revoked: boolean
}

export type CliCall = { args: string[]; env: NodeJS.ProcessEnv | undefined }

export async function startFakeT3(options: { cliPath: string; projects: unknown; threadsDir: string }) {
  let nextPid = 40_000
  const s = {
    origin: "",
    cliPath: options.cliPath,
    environmentId: randomUUID(),
    /** The environment the CLI issues sessions in and names in thread links; the HTTP side's by default. */
    cliEnvironmentId: "",
    /** The environment the HTTP side answers as and accepts sessions of; its own by default. */
    httpEnvironmentId: "",
    projects: options.projects,
    sessions: [] as FakeSession[],
    calls: [] as CliCall[],
    /** The next issues, in order: "fail" (exit 1), "crash" (the engine dies before the answer, after T3 issued it). */
    issue: [] as Array<"fail" | "crash">,
    /** The next revokes fail (exit 1) while this is above 0. */
    revokeFailures: 0,
    /** The next session lists fail while this is above 0. */
    listFailures: 0,
    /** What the next project lists answer, in order: "drop" (no answer) or a status. */
    projectsAnswer: [] as Array<"drop" | number>,
    /** What the next environment descriptors answer, in order: "drop" or a status. */
    descriptorAnswer: [] as Array<"drop" | number>,
    /** Process ids of issue children that are still running (for the pending record's recovery). */
    running: new Set<number>(),
    /** The creation time of each child process the CLI started. */
    created: new Map<number, string>(),
    /** Child process ids the CLI started, in order. */
    pids: [] as number[],
    counts: { projects: 0, descriptor: 0 },
    /** Sessions that are neither revoked nor expired. */
    live: () => s.sessions.filter((x) => !x.revoked && x.expiresAt > Date.now()),
    /** Every token it handed out, to check that none shows up in the output or in files. */
    tokens: () => s.sessions.map((x) => x.token),
    /** A process's creation time, as the sync's process-info would read it: null when it is gone. */
    processCreation: async (pid: number) => (s.running.has(pid) ? (s.created.get(pid) ?? null) : null),
    close: async () => {},
  }

  const runner: Runner = async (command, args, opts) => {
    if (command !== s.cliPath) return { code: 1, stdout: "", stderr: "", error: "not the T3 CLI" }
    s.calls.push({ args, env: opts.env })
    const env = s.cliEnvironmentId || s.environmentId
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" })
    const fail = (stderr: string) => ({ code: 1, stdout: "", stderr, error: "exit code 1" })
    const [a, b, c] = args
    if (a === "auth" && b === "session" && c === "issue") {
      const pid = nextPid++
      s.pids.push(pid)
      s.created.set(pid, `fake:${randomBytes(4).toString("hex")}`)
      s.running.add(pid)
      opts.onSpawn?.(pid)
      // Give the sync a moment to record the child, as a real child takes time to run.
      await new Promise((resolve) => setTimeout(resolve, 5))
      const next = s.issue.shift()
      if (next === "fail") {
        s.running.delete(pid)
        return fail("Error: could not issue\n")
      }
      const label = args[args.indexOf("--label") + 1] ?? ""
      const session: FakeSession = {
        sessionId: randomUUID(),
        token: randomBytes(32).toString("base64url"),
        label,
        environmentId: env,
        expiresAt: Date.now() + 30 * 86_400_000,
        revoked: false,
      }
      s.sessions.push(session)
      if (next === "crash") throw new Error("crash: the engine died while the issue was answering")
      s.running.delete(pid)
      return ok(
        `${JSON.stringify({
          sessionId: session.sessionId,
          token: session.token,
          method: "bearer-access-token",
          scopes: ["orchestration:read"],
          subject: "cli-issued-session",
          client: { label },
          expiresAt: new Date(session.expiresAt).toISOString(),
        })}\n`,
      )
    }
    if (a === "auth" && b === "session" && c === "list") {
      if (s.listFailures > 0) {
        s.listFailures--
        return fail("Error: cannot list\n")
      }
      return ok(
        JSON.stringify(
          s.live().map((x) => ({
            sessionId: x.sessionId,
            method: "bearer-access-token",
            scopes: ["orchestration:read"],
            subject: "cli-issued-session",
            client: { label: x.label },
            connected: false,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(x.expiresAt).toISOString(),
          })),
        ),
      )
    }
    if (a === "auth" && b === "session" && c === "revoke") {
      if (s.revokeFailures > 0) {
        s.revokeFailures--
        return fail("Error: cannot revoke\n")
      }
      const session = s.sessions.find((x) => x.sessionId === args[3] && !x.revoked)
      if (!session) return fail("Error: no such session\n")
      session.revoked = true
      return ok("")
    }
    if (a === "thread" && b === "list" && args[2] === "--project") {
      const id = args[3] ?? ""
      if (id === "p-notes") return fail(`No T3 Code project matches '${id}'.\n`)
      if (id === "p-missing") return ok("[]")
      return ok(
        readFileSync(`${options.threadsDir}/${id.replace(":", "_")}.json`, "utf8").replaceAll(FIXTURE_ENVIRONMENT, env),
      )
    }
    return fail("unknown command\n")
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", s.origin)
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    const httpEnv = s.httpEnvironmentId || s.environmentId
    if (req.method === "GET" && url.pathname === "/.well-known/t3/environment") {
      s.counts.descriptor++
      const next = s.descriptorAnswer.shift()
      if (next === "drop") return req.socket.destroy()
      if (typeof next === "number") return send(next, { error: "failed" })
      return send(200, { environmentId: httpEnv, label: "Fake T3", serverVersion: "0.1.9" })
    }
    if (req.method === "GET" && url.pathname === "/api/projects") {
      s.counts.projects++
      const next = s.projectsAnswer.shift()
      if (next === "drop") return req.socket.destroy()
      if (typeof next === "number") return send(next, { error: "failed" })
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "")
      const session = s.live().find((x) => x.token === bearer && x.environmentId === httpEnv)
      if (!session) return send(401, { _tag: "EnvironmentAuthInvalidError", code: "auth_invalid" })
      return send(200, s.projects)
    }
    send(404, { error: "not_found" })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  s.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  s.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return Object.assign(s, { runner })
}

export type FakeT3 = Awaited<ReturnType<typeof startFakeT3>>
