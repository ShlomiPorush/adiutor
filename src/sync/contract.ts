// The sync's machine-readable output (`--json`), the contract the tray reads: one JSON object per line on stdout,
// events first, then exactly one result object, and nothing else. Without --json the same commands print their human
// lines as before. No line ever holds a token, and T3 titles and paths never appear in it: projects are named by id.
// Described in docs/sync.md, "Machine-readable output".

export const CONTRACT_VERSION = 1

export type Command = "status" | "connect" | "disconnect" | "t3-connect" | "t3-disconnect" | "run"

/** What one part of a run (T3 or security) came to. */
export type PartResult = "accepted" | "partial" | "failed" | "outcome_unknown" | "not_run"

/** A human line, and the approval link of `connect`. */
export type Event =
  | { type: "event"; event: "message"; text: string }
  | { type: "event"; event: "approval"; link: string; userCode: string }

export type Failure = { code: string; message: string }

export type AdiutorState = {
  /** `ended`: Adiutor ended the connection (disconnected there, idle, or a token used twice); connect again. */
  state: "connected" | "not_connected" | "ended"
  url: string | null
  label?: string
  scope?: string
  /** A revocation whose outcome was unknown is kept and retried by the next command. */
  revocationPending: boolean
}

export type T3State = {
  /** `ended`: T3 refused the session (401) or answers as another environment; it stays so until t3-connect. */
  state: "connected" | "not_connected" | "ended"
  reason?: "rejected" | "other_environment"
  environmentId?: string
  expiresAt?: string
  revocationPending: boolean
}

export type T3Part = {
  result: PartResult
  /** Why it is not `accepted`, a stable code. */
  reason?: string
  message?: string
  httpStatus?: number
  /** Where the project list came from: T3 now, or the last good list (projectsAt is then its time). */
  projectsFrom: "t3" | "last_good" | null
  projectsAt: string | null
  projects: number
  threads: number
  /** Projects whose threads could not be fully read, sent so that the server does not decide their items. */
  failedProjects: number
}

export type SecurityPart = {
  result: PartResult
  reason?: string
  message?: string
  httpStatus?: number
  /** The overview snapshot that was sent, and when its collection finished. */
  snapshotRunId: string | null
  snapshotAt: string | null
  repos: number
}

export type RunReport = {
  startedAt: string
  finishedAt: string
  dryRun: boolean
  t3: T3Part
  security: SecurityPart
  /** The last run in which both parts were accepted, this one included. */
  lastGoodSyncAt: string | null
}

export type Pause = { until: string | null }

export type Result = { type: "result"; v: typeof CONTRACT_VERSION; command: Command | null; ok: boolean } & (
  | { command: null; error?: Failure }
  | ({ command: "status" } & StatusBody)
  | ({ command: "connect" } & ConnectBody)
  | ({ command: "disconnect" } & DisconnectBody)
  | ({ command: "t3-connect" } & T3ConnectBody)
  | ({ command: "t3-disconnect" } & DisconnectBody)
  | ({ command: "run" } & RunBody)
)

export type StatusBody = {
  adiutor: AdiutorState
  t3: T3State
  lastRun: RunReport | null
  lastGoodSyncAt: string | null
  /** A run holds the run lock: when it started. */
  running: { startedAt: string } | null
  paused: Pause | null
  settings: { problems: string[] }
  error?: Failure
}

export type ConnectBody = {
  state: "connected" | "already_connected" | "not_connected"
  scope?: string
  error?: Failure
}

export type DisconnectBody = {
  /** Whether a connection or session was kept before. */
  wasConnected: boolean
  /** Whether the revocation is still to be retried (the outcome was unknown or it failed). */
  revocationPending: boolean
  error?: Failure
}

export type T3ConnectBody = {
  environmentId?: string
  expiresAt?: string
  error?: Failure
}

export type RunBody = {
  /** Another run holds the run lock: nothing ran. */
  busy?: { startedAt: string | null }
  report?: RunReport
  error?: Failure
}

/** Distributes Omit over a union, so each result keeps its own fields. */
type ResultInput = Result extends infer R ? (R extends unknown ? Omit<R, "type" | "v"> : never) : never

/** The output of one command: human lines, or JSON lines ending in one result. */
export function output(json: boolean, out: (line: string) => void) {
  let done = false
  const write = (value: unknown) => out(JSON.stringify(value))
  return {
    json,
    say(text: string) {
      if (done) return
      if (json) write({ type: "event", event: "message", text } satisfies Event)
      else out(text)
    },
    event(value: Omit<Extract<Event, { event: "approval" }>, "type">) {
      if (!done && json) write({ type: "event", ...value } satisfies Event)
    },
    /** The one result; human output has printed its lines already. Later calls are ignored. */
    result(value: ResultInput) {
      if (done) return
      done = true
      if (json) write({ type: "result", v: CONTRACT_VERSION, ...value })
    },
    get finished() {
      return done
    },
  }
}

export type Output = ReturnType<typeof output>
