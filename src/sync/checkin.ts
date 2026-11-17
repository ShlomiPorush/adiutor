// The check-in (`checkin --json`): the tray's state report to Adiutor every minute, and the sync request Adiutor hands
// back (the sync tray plan, section 4, "Adiutor server and UI"). The tray gives the report as one JSON object on stdin;
// the engine checks it, sends it over the sync's connection, and writes a claim it receives to `request.json` in the
// data folder before it answers, so a tray that stopped finds it again in `status`. The claim is cleared only after a
// check-in that listed it in `finished` was answered. A check-in is a state report: one whose answer was lost is safe
// to send again, and the next one does. See docs/sync.md, "Requests from Adiutor".

import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { CheckinClaim, CheckinReport, PartResult } from "./contract.ts"
import { ClientError } from "./errors.ts"
import { asArray, asObject, asString, asTime, parseJson } from "./json.ts"
import { connectionLockOptions, fileLock, type LockDeps } from "./lock.ts"
import type { SyncClient } from "./oauth.ts"
import { writeAtomic } from "./state.ts"

export const CHECKIN_PATH = "/api/v1/sync/checkin"
export const CLAIM_FILE = "request.json"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VERSION = /^[0-9A-Za-z.+-]{1,50}$/
const PARTS: readonly PartResult[] = ["accepted", "partial", "failed", "outcome_unknown", "not_run"]
const MAX_FINISHED = 20

export const isRequestId = (value: unknown): value is string => typeof value === "string" && UUID.test(value)

const bad = (message: string) => new ClientError("invalid_report", `The check-in report is not valid: ${message}.`)

/** The tray's report, checked field by field; anything else is refused before anything is sent. */
export function parseReport(text: string): CheckinReport {
  let root: Record<string, unknown> | undefined
  try {
    root = asObject(parseJson(text, "the report"))
  } catch {
    root = undefined
  }
  if (!root) throw bad("send one JSON object on stdin")
  const time = (name: string): string | null => {
    const value = root?.[name]
    if (value === null) return null
    const parsed = asTime(value)
    if (!parsed) throw bad(`${name} must be a time or null`)
    return new Date(parsed).toISOString()
  }
  const version = asString(root.version)
  if (!version || !VERSION.test(version)) throw bad("version must be the tray's version")
  if (typeof root.paused !== "boolean") throw bad("paused must be true or false")
  const running = root.running === null ? null : asObject(root.running)
  let run: CheckinReport["running"] = null
  if (running) {
    if (running.kind === "request" && isRequestId(running.requestId))
      run = { kind: "request", requestId: running.requestId.toLowerCase() }
    else if (running.kind === "local" && asTime(running.startedAt))
      run = { kind: "local", startedAt: new Date(running.startedAt as string).toISOString() }
    else throw bad("running must be a request with its requestId, a local run with its startedAt, or null")
  } else if (root.running !== null) throw bad("running must be a request with its requestId, a local run or null")
  if (!Array.isArray(root.finished) || root.finished.length > MAX_FINISHED)
    throw bad(`finished must be a list of at most ${MAX_FINISHED} requests`)
  const finished = asArray(root.finished).map((entry) => {
    const data = asObject(entry)
    const result = asObject(data?.result)
    const part = (value: unknown) => PARTS.find((p) => p === value)
    const t3 = part(result?.t3)
    const security = part(result?.security)
    if (!data || !isRequestId(data.requestId) || !t3 || !security)
      throw bad("each finished request needs its requestId and the result of each part (t3, security)")
    return { requestId: data.requestId.toLowerCase(), result: { t3, security } }
  })
  return {
    version,
    paused: root.paused,
    pausedUntil: root.paused ? time("pausedUntil") : null,
    nextRunAt: time("nextRunAt"),
    running: run,
    finished,
  }
}

// --- The claim the engine keeps (request.json, no secret) ---

/**
 * The claim kept in the data folder for the connection `identity` (oauth.ts identity(): the address and the
 * connection), or null when there is none, it cannot be read, or another connection or address received it: such a
 * claim is never run (Adiutor gives its result to the connection that claimed it only).
 */
export function readClaim(dir: string, identity: string | null): CheckinClaim | null {
  try {
    const root = asObject(parseJson(readFileSync(join(dir, CLAIM_FILE), "utf8"), "the claim"))
    const receivedAt = asTime(root?.receivedAt)
    if (!root || !isRequestId(root.requestId) || !receivedAt) return null
    if (identity === null || root.connection !== identity) return null
    return { requestId: root.requestId, receivedAt }
  } catch {
    return null
  }
}

/**
 * After an answered check-in: the kept claim is cleared when the report listed it as finished, and the claim Adiutor
 * answered is kept (written in one step), so it is on disk before the tray reads the answer.
 */
export async function keepClaim(
  dir: string,
  identity: string,
  sent: CheckinReport,
  answered: string | null,
  deps: Pick<LockDeps, "platform" | "now" | "sleep">,
): Promise<CheckinClaim | null> {
  const kept = readClaim(dir, identity)
  const reported = kept !== null && sent.finished.some((f) => f.requestId === kept.requestId)
  if (answered) {
    if (kept?.requestId === answered && !reported) return kept
    const claim = { requestId: answered, receivedAt: new Date(deps.now()).toISOString() }
    await writeAtomic(join(dir, CLAIM_FILE), `${JSON.stringify({ ...claim, connection: identity })}\n`, deps)
    return claim
  }
  // Reported finished, or a claim of another connection or address: dropped, never run.
  if (reported || kept === null) {
    rmSync(join(dir, CLAIM_FILE), { force: true })
    return null
  }
  return kept
}

export const CHECKIN_LOCK = "checkin.lock"

const CONNECTION_CHANGED: CheckinOutcome = {
  ok: false,
  code: "connection_changed",
  message: "The sync connected again while it checked in: that answer belonged to the old connection and was dropped.",
}

/**
 * One check-in round, from sending the report to keeping the claim, under the check-in lock (src/sync/lock.ts): two
 * check-ins at once take turns, so an answer that arrives late never writes back a claim another check-in already
 * reported finished. The second waits up to 20 seconds, then answers busy and sends nothing.
 */
export async function checkinRound(
  dir: string,
  client: SyncClient,
  report: CheckinReport,
  deps: LockDeps,
  /** Test seam: runs under the connection's lock, right before the claim is kept. */
  beforeSave?: () => Promise<void>,
): Promise<{ sent: CheckinOutcome; claim: CheckinClaim | null; identity: string | null }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, CHECKIN_LOCK)
  const lock = fileLock(file, deps)
  const options = connectionLockOptions(file, dir, deps, "Another check-in is going. Nothing was sent; run it again.")
  return lock.withLock(options, async () => {
    const identity = await client.identity()
    const sent = await sendCheckin(client, report)
    // From the identity check to the claim kept and answered, under the connection's lock, which connect --replace
    // and disconnect take to change the connection: an answer for a connection that is no longer the kept one is
    // dropped, and a claim is kept and answered only while its connection is the kept one.
    return client.whileConnected(async () => {
      const now = await client.identity()
      if (sent.ok && (identity === null || now !== identity))
        return { sent: CONNECTION_CHANGED, claim: readClaim(dir, now), identity: now }
      if (!sent.ok || identity === null) return { sent, claim: readClaim(dir, identity), identity }
      await beforeSave?.()
      return { sent, claim: await keepClaim(dir, identity, report, sent.claim, deps), identity }
    })
  })
}

// --- Sending ---

export type CheckinOutcome = { ok: true; claim: string | null } | { ok: false; code: string; message: string }

/**
 * Sends the report. An Adiutor whose endpoints listing has the sync's pushes but no check-in is older than this sync
 * (`server_older`): requests from Adiutor are not available there, and the tray says so.
 */
export async function sendCheckin(client: SyncClient, report: CheckinReport): Promise<CheckinOutcome> {
  const route = await client.route("POST", CHECKIN_PATH)
  if (route === "older")
    return {
      ok: false,
      code: "server_older",
      message: "This Adiutor is older than the sync and takes no check-in: requests from Adiutor are not available.",
    }
  if (route !== "listed") return { ok: false, code: route.code, message: route.message }
  const result = await client.push(CHECKIN_PATH, report)
  if (result.kind === "failed") return { ok: false, code: result.code, message: result.message }
  if (result.kind === "outcome_unknown")
    return {
      ok: false,
      code: "outcome_unknown",
      message: `The check-in's answer was lost${result.status ? ` (HTTP ${result.status})` : ""}; the next check-in sends the report again.`,
    }
  const body = asObject(result.body)
  if (result.status < 200 || result.status >= 300) {
    const code = asString(body?.error) ?? `http_${result.status}`
    return { ok: false, code, message: `Adiutor refused the check-in (HTTP ${result.status}).` }
  }
  const data = asObject(body?.data)
  const claim = data?.claim === null ? null : asObject(data?.claim)
  if (!data || (data.claim !== null && !isRequestId(claim?.requestId)))
    return { ok: false, code: "unexpected_answer", message: "Adiutor answered the check-in without a readable claim." }
  return { ok: true, claim: claim ? String(claim.requestId).toLowerCase() : null }
}
