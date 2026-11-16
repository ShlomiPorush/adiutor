// The sync's read-only T3 session (plan, "T3 session lifecycle"): issued on this computer with
// `t3 auth session issue --scope orchestration:read`, kept like the Adiutor connection in the owner-only connection
// folder, checked against T3's environment before each use, renewed when less than a quarter of its 30 days is left,
// and revoked with `t3 auth session revoke`. Every step that can be cut off leaves a pending record first, so a crash
// never leaves a session nobody knows of (except while its issuing child may still be running) and never revokes the
// only saved one. A session T3 refuses (401) or that the T3 address no longer matches is never issued again on its own:
// the T3 part of every run stops until the owner connects T3 again.
//
// The token is read from the issue command's output and goes only into the owner-only file and the Authorization
// header of T3's own address. That command's output is never printed, logged or put into a message.

import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { ClientError } from "./errors.ts"
import { type Runner, t3Env } from "./exec.ts"
import type { FetchLike } from "./http.ts"
import { asArray, asObject, asString, asTime } from "./json.ts"
import { connectionLockOptions, fileLock } from "./lock.ts"
import { credentialsDir } from "./oauth.ts"
import { ownerOnlyFolder } from "./owner-folder.ts"
import { processCreation as osProcessCreation } from "./process-info.ts"
import { type Projects, parseProjectList } from "./t3.ts"

export const SESSION_FILE = "t3-session.json"
export const PENDING_FILE = "t3-pending.json"
export const T3_LOCK = "t3.lock"
/** The session's lifetime (owner's decision D-T4), and when it is renewed: under a quarter of it left. */
export const TTL_DAYS = 30
const TTL_MS = TTL_DAYS * 86_400_000
const RENEW_LEFT_MS = TTL_MS / 4
/** A pending issue without a child was never started; after this long nothing can still be issuing it. */
const NO_CHILD_MS = 2 * 60_000
const HTTP_TIMEOUT_MS = 15_000
const CLI_TIMEOUT_MS = 60_000

const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/
const TOKEN = /^[A-Za-z0-9._~+/=-]{16,4096}$/
const ENVIRONMENT_ID = /^[A-Za-z0-9._:-]{1,200}$/
const LABEL = /^Adiutor sync [0-9a-f]{16}$/

export type T3SessionDeps = {
  runner: Runner
  fetch: FetchLike
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** Milliseconds since the epoch. */
  now: () => number
  sleep: (ms: number) => Promise<void>
  systemCommand: (name: string) => Promise<string | undefined>
  /** The T3 CLI (on Windows usually t3.cmd). */
  cliPath: string
  /** T3's address, an origin. */
  origin: string
  /** A process's creation time (src/sync/process-info.ts); null when gone, undefined when it cannot be told. */
  processCreation?: (pid: number) => Promise<string | null | undefined>
  httpTimeoutMs?: number
  /** Test seam: runs at each step of the lifecycle; a test throws from it to stop the command there (a crash). */
  checkpoint?: (step: CheckpointStep) => void
}

export type CheckpointStep = "pending written" | "issued" | "saved" | "pending cleared" | "revoke entry" | "revoked"

export type EndReason = "rejected" | "other_environment"

/** The saved session. `ended` stops the T3 part until t3-connect. */
export type Session = {
  sessionId: string
  token: string
  expiresAt: string
  environmentId: string
  origin: string
  label: string
  ended?: EndReason
}

type PendingIssue = { label: string; startedAt: number; child?: { pid: number; created: string } }
/** An old session to revoke once the saved one is no longer it (a replacement was saved, or it was disconnected). */
type PendingRevoke = { sessionId: string; after: "replacement saved" | "disconnected" }
type Pending = { issues: PendingIssue[]; revokes: PendingRevoke[] }

/** What the projects read came to. */
export type ProjectsRead =
  | { kind: "ok"; projects: Projects; environmentId: string; renewal?: string }
  /** T3 cannot be reached or failed (connection refused, timeout, 5xx): the last good list may stand in. */
  | { kind: "unavailable"; environmentId: string; message: string }
  /** The T3 part stops: not connected, ended, refused, another environment, or an answer that cannot be read. */
  | { kind: "stop"; code: string; message: string; ended?: boolean }

const ENDED_MESSAGE: Record<EndReason, string> = {
  rejected: "T3 refused the sync's session; connect T3 again (t3-connect)",
  other_environment: "T3 address points to another environment; check T3's address and connect T3 again (t3-connect)",
}

export function t3Session(deps: T3SessionDeps) {
  const dir = credentialsDir(deps.platform, deps.env)
  const folder = ownerOnlyFolder(dir, deps)
  const lock = fileLock(join(dir, T3_LOCK), deps)
  const lockOptions = connectionLockOptions(
    lock.file,
    dir,
    deps,
    "Another sync command is using the T3 session. Run it again.",
  )
  const creation = deps.processCreation ?? ((pid: number) => osProcessCreation(pid, deps))

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    await folder.secure()
    return lock.withLock(lockOptions, fn)
  }

  // --- The files: the session and the pending records, both in the owner-only folder ---

  async function readSession(): Promise<Session | null> {
    const text = await folder.read(SESSION_FILE)
    if (text === null) return null
    let data: Record<string, unknown> | undefined
    try {
      data = asObject(JSON.parse(text))
    } catch {
      data = undefined
    }
    const ended: EndReason | undefined =
      data?.ended === "rejected" || data?.ended === "other_environment" ? data.ended : undefined
    const session: Session | undefined = data && {
      sessionId: asString(data.sessionId) ?? "",
      token: asString(data.token) ?? "",
      expiresAt: asTime(data.expiresAt) ?? "",
      environmentId: asString(data.environmentId) ?? "",
      origin: asString(data.origin) ?? "",
      label: asString(data.label) ?? "",
      ...(ended ? { ended } : {}),
    }
    if (
      !session ||
      !SESSION_ID.test(session.sessionId) ||
      !TOKEN.test(session.token) ||
      !session.expiresAt ||
      !ENVIRONMENT_ID.test(session.environmentId)
    )
      throw new ClientError(
        "insecure_credentials",
        `${join(dir, SESSION_FILE)} is damaged. Delete it and connect T3 again.`,
      )
    return session
  }

  const writeSession = (session: Session) => folder.write(SESSION_FILE, `${JSON.stringify(session)}\n`)

  async function readPending(): Promise<Pending> {
    const text = await folder.read(PENDING_FILE)
    const data =
      text === null
        ? undefined
        : (() => {
            try {
              return asObject(JSON.parse(text))
            } catch {
              return undefined
            }
          })()
    const issues: PendingIssue[] = []
    for (const item of asArray(data?.issues)) {
      const issue = asObject(item)
      const label = asString(issue?.label)
      const startedAt = Number(issue?.startedAt)
      if (!issue || !label || !LABEL.test(label) || !Number.isFinite(startedAt)) continue
      const child = asObject(issue.child)
      const pid = Number(child?.pid)
      const created = asString(child?.created)
      issues.push({ label, startedAt, ...(child && pid > 0 && created ? { child: { pid, created } } : {}) })
    }
    const revokes: PendingRevoke[] = []
    for (const item of asArray(data?.revokes)) {
      const revoke = asObject(item)
      const sessionId = asString(revoke?.sessionId)
      if (!sessionId || !SESSION_ID.test(sessionId)) continue
      revokes.push({ sessionId, after: revoke?.after === "disconnected" ? "disconnected" : "replacement saved" })
    }
    return { issues, revokes }
  }

  async function writePending(pending: Pending): Promise<void> {
    if (pending.issues.length === 0 && pending.revokes.length === 0) folder.remove(PENDING_FILE)
    else await folder.write(PENDING_FILE, `${JSON.stringify({ v: 1, ...pending })}\n`)
  }

  /** Changes the pending records: read, change, written in one step (always under the T3 lock). */
  async function changePending(change: (pending: Pending) => void): Promise<void> {
    const pending = await readPending()
    change(pending)
    await writePending(pending)
  }

  // --- T3's HTTP side: its environment descriptor and its project list ---

  async function get(path: string, token?: string): Promise<{ status: number; json: unknown } | "unavailable"> {
    let response: Response
    try {
      response = await deps.fetch(`${deps.origin}${path}`, {
        method: "GET",
        headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        // A token never follows a redirect to another address.
        redirect: "manual",
        signal: AbortSignal.timeout(deps.httpTimeoutMs ?? HTTP_TIMEOUT_MS),
      })
    } catch {
      return "unavailable"
    }
    let json: unknown = null
    try {
      json = JSON.parse(await response.text())
    } catch {
      json = null
    }
    return { status: response.status, json }
  }

  /** The environment id T3's address answers with; "unavailable" when it cannot be reached or fails. */
  async function environment(): Promise<string | "unavailable" | undefined> {
    const answer = await get("/.well-known/t3/environment")
    if (answer === "unavailable" || answer.status >= 500) return "unavailable"
    const id = answer.status === 200 ? asString(asObject(answer.json)?.environmentId) : undefined
    return id && ENVIRONMENT_ID.test(id) ? id : undefined
  }

  async function projects(
    token: string,
  ): Promise<
    | { kind: "ok"; projects: Projects }
    | { kind: "rejected" }
    | { kind: "unavailable" }
    | { kind: "unreadable"; status: number }
  > {
    const answer = await get("/api/projects", token)
    if (answer === "unavailable" || answer.status >= 500) return { kind: "unavailable" }
    if (answer.status === 401) return { kind: "rejected" }
    if (answer.status !== 200) return { kind: "unreadable", status: answer.status }
    try {
      return { kind: "ok", projects: parseProjectList(answer.json) }
    } catch {
      return { kind: "unreadable", status: answer.status }
    }
  }

  // --- T3's CLI: issue, list and revoke, from T3's default data folder ---

  const cli = (args: string[], onSpawn?: (pid: number) => void) =>
    deps.runner(deps.cliPath, args, {
      timeoutMs: CLI_TIMEOUT_MS,
      env: t3Env(deps.env),
      ...(onSpawn ? { onSpawn } : {}),
    })

  /** The sessions T3 lists, by id and label; undefined when the list cannot be read. */
  async function listSessions(): Promise<Array<{ sessionId: string; label: string }> | undefined> {
    const result = await cli(["auth", "session", "list", "--json"])
    if (result.code !== 0) return undefined
    let list: unknown
    try {
      list = JSON.parse(result.stdout)
    } catch {
      return undefined
    }
    if (!Array.isArray(list)) return undefined
    return list.flatMap((item) => {
      const data = asObject(item)
      const sessionId = asString(data?.sessionId)
      return sessionId ? [{ sessionId, label: asString(asObject(data?.client)?.label) ?? "" }] : []
    })
  }

  /** Revokes a session by id; true when it is gone (revoked now, or no longer listed). */
  async function revoke(sessionId: string): Promise<boolean> {
    if (!SESSION_ID.test(sessionId)) return false
    const result = await cli(["auth", "session", "revoke", sessionId])
    if (result.code === 0) return true
    const list = await listSessions()
    return list !== undefined && !list.some((s) => s.sessionId === sessionId)
  }

  /**
   * Issues a session under a pending record: written before the child starts, completed with the child's process id
   * and creation time once it runs, and cleared only by the caller once the session is saved.
   */
  async function issue(label: string): Promise<{ sessionId: string; token: string; expiresAt: string }> {
    await changePending((p) => {
      p.issues.push({ label, startedAt: deps.now() })
    })
    deps.checkpoint?.("pending written")
    let recorded: Promise<void> | undefined
    // The record is complete before anything else happens, the child failing or not.
    const result = await cli(
      [
        "auth",
        "session",
        "issue",
        "--scope",
        "orchestration:read",
        "--ttl",
        `${TTL_DAYS}d`,
        "--label",
        label,
        "--json",
      ],
      (pid) => {
        recorded = (async () => {
          const created = await creation(pid)
          // A child already gone needs no record: the pending issue is then looked up after two minutes.
          if (typeof created !== "string") return
          await changePending((p) => {
            const record = p.issues.find((i) => i.label === label)
            if (record) record.child = { pid, created }
          })
        })().catch(() => {})
      },
    ).finally(() => recorded)
    // Its output holds the token: never shown. Only the exit code is.
    if (result.code !== 0)
      throw new ClientError("t3_cli_failed", `The T3 CLI did not issue a session (${result.error ?? "no answer"}).`)
    let data: Record<string, unknown> | undefined
    try {
      const text = result.stdout.trim()
      data = asObject(JSON.parse(text.startsWith("{") ? text : (text.split(/\r?\n/).at(-1) ?? "")))
    } catch {
      data = undefined
    }
    const sessionId = asString(data?.sessionId)
    const token = asString(data?.token)
    const expiresAt = asTime(data?.expiresAt)
    if (!sessionId || !SESSION_ID.test(sessionId) || !token || !TOKEN.test(token) || !expiresAt)
      throw new ClientError("t3_unexpected_answer", "The T3 CLI answered without a usable session.")
    return { sessionId, token, expiresAt }
  }

  // --- Recovery of what a cut-off command left ---

  /**
   * Pending revokes: the old session is revoked only when the saved session is no longer it; otherwise it is kept and
   * the entry dropped. Pending issues: once the issuing child is certainly gone (or, without a child, after two
   * minutes), the label is looked up in T3's list; the saved session is kept, any other with that label revoked.
   */
  async function recover(): Promise<void> {
    const pending = await readPending()
    if (pending.issues.length === 0 && pending.revokes.length === 0) return
    const current = (await readSession())?.sessionId
    const revokes: PendingRevoke[] = []
    for (const entry of pending.revokes) {
      if (entry.sessionId === current) continue
      if (!(await revoke(entry.sessionId))) revokes.push(entry)
    }
    const issues: PendingIssue[] = []
    let list: Awaited<ReturnType<typeof listSessions>> | null = null
    for (const record of pending.issues) {
      if (record.child) {
        const created = await creation(record.child.pid)
        // Still running, or it cannot be told: wait.
        if (created === undefined || created === record.child.created) {
          issues.push(record)
          continue
        }
      } else if (deps.now() - record.startedAt < NO_CHILD_MS) {
        issues.push(record)
        continue
      }
      list ??= await listSessions()
      if (!list) {
        issues.push(record)
        continue
      }
      let left = false
      for (const s of list.filter((s) => s.label === record.label && s.sessionId !== current))
        if (!(await revoke(s.sessionId))) left = true
      if (left) issues.push(record)
    }
    // Records written meanwhile are kept: this runs under the T3 lock, so none are.
    await writePending({ issues, revokes })
  }

  /**
   * Replaces the saved session (or makes the first): the old one goes on the pending revoke list, the new one is issued
   * under its pending record, checked against T3's address (its project list must answer), saved, and only then is
   * the old one revoked.
   */
  async function replace(environmentId: string): Promise<{ session: Session; projects: Projects }> {
    const old = await readSession()
    if (old) await changePending((p) => p.revokes.push({ sessionId: old.sessionId, after: "replacement saved" }))
    const label = `Adiutor sync ${randomBytes(8).toString("hex")}`
    const issued = await issue(label)
    deps.checkpoint?.("issued")
    const check = await projects(issued.token)
    if (check.kind !== "ok") {
      // The CLI issued it in another T3 than the address answers for, or T3 could not confirm it: not kept.
      if (await revoke(issued.sessionId))
        await changePending((p) => {
          p.issues = p.issues.filter((i) => i.label !== label)
        })
      if (old)
        await changePending((p) => {
          p.revokes = p.revokes.filter((r) => r.sessionId !== old.sessionId)
        })
      if (check.kind === "rejected")
        throw new ClientError(
          "t3_other_environment",
          "The T3 CLI and T3's address belong to different T3 environments. Check T3's address and the CLI path.",
        )
      if (check.kind === "unavailable")
        throw new ClientError("t3_unavailable", `T3 at ${deps.origin} did not answer. Is T3 running?`)
      throw new ClientError(
        "t3_unexpected_answer",
        `T3 at ${deps.origin} answered its project list with ${check.status}.`,
      )
    }
    const session: Session = { ...issued, environmentId, origin: deps.origin, label }
    await writeSession(session)
    deps.checkpoint?.("saved")
    await changePending((p) => {
      p.issues = p.issues.filter((i) => i.label !== label)
    })
    deps.checkpoint?.("pending cleared")
    if (old && (await revoke(old.sessionId)))
      await changePending((p) => {
        p.revokes = p.revokes.filter((r) => r.sessionId !== old.sessionId)
      })
    return { session, projects: check.projects }
  }

  async function environmentOrFail(): Promise<string> {
    const id = await environment()
    if (id === "unavailable")
      throw new ClientError("t3_unavailable", `T3 at ${deps.origin} did not answer. Is T3 running?`)
    if (!id) throw new ClientError("t3_other_environment", `${deps.origin} does not answer as T3.`)
    return id
  }

  /** Marks the saved session ended: the T3 part stops until t3-connect. Never issues a new one. */
  async function markEnded(reason: EndReason, sessionId: string): Promise<void> {
    await withLock(async () => {
      const session = await readSession()
      if (session && session.sessionId === sessionId && !session.ended)
        await writeSession({ ...session, ended: reason })
    })
  }

  return {
    dir,

    /** The session's state, from the files alone (no T3 call). */
    async status() {
      const session = await readSession()
      const pending = await readPending()
      return {
        state: !session ? ("not_connected" as const) : session.ended ? ("ended" as const) : ("connected" as const),
        ...(session?.ended ? { reason: session.ended } : {}),
        ...(session ? { environmentId: session.environmentId, expiresAt: session.expiresAt } : {}),
        revocationPending: pending.revokes.length > 0,
      }
    },

    /** t3-connect: a new session for the environment T3's address answers as; an old one is replaced. */
    async connect(): Promise<Session> {
      return withLock(async () => {
        await recover()
        return (await replace(await environmentOrFail())).session
      })
    },

    /** t3-disconnect: revoke, then delete; a revoke that failed stays pending and is retried by later commands. */
    async disconnect(): Promise<{ wasConnected: boolean; revocationPending: boolean }> {
      return withLock(async () => {
        await recover()
        const session = await readSession()
        if (!session) return { wasConnected: false, revocationPending: (await readPending()).revokes.length > 0 }
        await changePending((p) => p.revokes.push({ sessionId: session.sessionId, after: "disconnected" }))
        deps.checkpoint?.("revoke entry")
        const revoked = await revoke(session.sessionId)
        deps.checkpoint?.("revoked")
        folder.remove(SESSION_FILE)
        if (revoked)
          await changePending((p) => {
            p.revokes = p.revokes.filter((r) => r.sessionId !== session.sessionId)
          })
        return { wasConnected: true, revocationPending: (await readPending()).revokes.length > 0 }
      })
    },

    /**
     * For a run: recovery, the environment check, the project list with the session, and the renewal when it is due.
     * Refused (401) or another environment ends the session; an availability failure lets the caller use the last
     * good list.
     */
    async readProjects(): Promise<ProjectsRead> {
      return withLock(async (): Promise<ProjectsRead> => {
        await recover()
        const session = await readSession()
        if (!session) return { kind: "stop", code: "t3_not_connected", message: "T3 is not connected (run t3-connect)" }
        if (session.ended)
          return { kind: "stop", code: `t3_${session.ended}`, message: ENDED_MESSAGE[session.ended], ended: true }
        const id = await environment()
        if (id === "unavailable")
          return {
            kind: "unavailable",
            environmentId: session.environmentId,
            message: `T3 at ${deps.origin} did not answer`,
          }
        if (id !== session.environmentId) {
          await writeSession({ ...session, ended: "other_environment" })
          return { kind: "stop", code: "t3_other_environment", message: ENDED_MESSAGE.other_environment, ended: true }
        }
        const read = await projects(session.token)
        if (read.kind === "unavailable")
          return {
            kind: "unavailable",
            environmentId: session.environmentId,
            message: `T3 at ${deps.origin} did not answer`,
          }
        if (read.kind === "rejected") {
          await writeSession({ ...session, ended: "rejected" })
          return { kind: "stop", code: "t3_rejected", message: ENDED_MESSAGE.rejected, ended: true }
        }
        if (read.kind === "unreadable")
          return {
            kind: "stop",
            code: "t3_projects_unreadable",
            message: `T3 answered its project list with ${read.status}, which the sync cannot read`,
          }
        let renewal: string | undefined
        if (Date.parse(session.expiresAt) - deps.now() < RENEW_LEFT_MS) {
          try {
            const renewed = await replace(session.environmentId)
            renewal = `the T3 session was renewed until ${renewed.session.expiresAt}`
          } catch (error) {
            renewal = `the T3 session could not be renewed (${error instanceof ClientError ? error.message : "unexpected error"}); it stays until ${session.expiresAt}`
          }
        }
        return {
          kind: "ok",
          projects: read.projects,
          environmentId: session.environmentId,
          ...(renewal ? { renewal } : {}),
        }
      })
    },

    /** The CLI's threads named another environment: the session ends (src/sync/run.ts checks the links). */
    markEnded,
    /** The saved session's id, to mark exactly that one ended. */
    async currentId(): Promise<string | undefined> {
      return (await readSession())?.sessionId
    },
  }
}

export type T3Session = ReturnType<typeof t3Session>
