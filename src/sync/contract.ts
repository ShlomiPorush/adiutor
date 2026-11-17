// The sync's machine-readable output (`--json`), the contract the tray reads: one JSON object per line on stdout,
// events first, then exactly one result object, and nothing else. Without --json the same commands print their human
// lines as before. No line ever holds a token. The sync names projects by id and puts no T3 title or path in a line;
// a failure's message can pass on the last error line the T3 CLI or the collector printed.
// Described in docs/sync.md, "Machine-readable output".

export const CONTRACT_VERSION = 1

export type Command =
  | "status"
  | "connect"
  | "disconnect"
  | "t3-connect"
  | "t3-disconnect"
  | "run"
  | "checkin"
  | "hold-run"

/** What one part of a run (T3 or security) came to. */
export type PartResult = "accepted" | "partial" | "failed" | "outcome_unknown" | "not_run"

/** A human line, and the approval link of `connect`. */
export type Event =
  | { type: "event"; event: "message"; text: string }
  | { type: "event"; event: "approval"; link: string; userCode: string }
  /** `hold-run` holds the run lock now, until its stdin ends. */
  | { type: "event"; event: "held" }

export type Failure = { code: string; message: string }

/**
 * Where a setting's value came from (docs/sync.md, "Settings"): a command-line option, the environment, an env file
 * (--env, or the default sync.env that `connect` writes), the settings file the tray writes, or the default.
 */
export type SettingSource = "option" | "environment" | "envFile" | "settingsFile" | "default"

/** A setting as the engine uses it: its value (null when none is set or it cannot be used) and its source. */
export type EffectiveSetting = { value: string | null; source: SettingSource }

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
  /**
   * Where the repositories came from: this run's T3 project list, or, when T3 was not read, the last good list
   * (projectsAt is then its time). Security reads nothing from T3; the list only maps projects to repositories.
   */
  projectsFrom: "t3" | "last_good" | null
  projectsAt: string | null
}

export type RunReport = {
  startedAt: string
  finishedAt: string
  dryRun: boolean
  /** The sync request from Adiutor this run served (`run --request <id>`), or null. */
  requestId: string | null
  t3: T3Part
  security: SecurityPart
  /** The last run in which both parts were accepted, this one included. */
  lastGoodSyncAt: string | null
}

export type Pause = { until: string | null }

/**
 * The check-in report the tray gives `checkin` on stdin, as Adiutor takes it (POST /api/v1/sync/checkin): the tray's
 * version, its pause, its next scheduled run, the run going and the requests finished since the last answered
 * check-in, each with what its parts came to. Times are ISO 8601.
 */
export type CheckinReport = {
  version: string
  paused: boolean
  /** Null while paused: until resumed. */
  pausedUntil: string | null
  nextRunAt: string | null
  running: { kind: "request"; requestId: string } | { kind: "local"; startedAt: string } | null
  finished: { requestId: string; result: { t3: PartResult; security: PartResult } }[]
}

/** A sync request Adiutor handed this computer, as the engine keeps it until a check-in reports it finished. */
export type CheckinClaim = { requestId: string; receivedAt: string }

/**
 * The one result of a command. `ok` is true when the command did what it was asked; when it is false, `error` says
 * why (a stable `code` and a message), with the command's own fields where it has them (`busy` for a run that did not
 * start, `revocationPending` for a disconnect whose revocation is still to be done). Bad arguments: `command` null.
 */
export type Result = { type: "result"; v: typeof CONTRACT_VERSION } & (
  | { command: Command | null; ok: false; error: Failure }
  | { command: null; ok: true }
  | ({ command: "status"; ok: true } & StatusBody)
  | ({ command: "connect"; ok: boolean } & ConnectBody)
  | ({ command: "disconnect"; ok: boolean } & DisconnectBody)
  | ({ command: "t3-connect"; ok: boolean } & T3ConnectBody)
  | ({ command: "t3-disconnect"; ok: boolean } & DisconnectBody)
  | ({ command: "run"; ok: boolean } & RunBody)
  | ({ command: "checkin"; ok: boolean } & CheckinBody)
  | ({ command: "hold-run"; ok: boolean } & RunBody)
)

export type StatusBody = {
  adiutor: AdiutorState
  t3: T3State
  lastRun: RunReport | null
  lastGoodSyncAt: string | null
  /** A run holds the run lock: when it started. */
  running: { startedAt: string } | null
  paused: Pause | null
  /** A sync request Adiutor handed this computer that no answered check-in reported finished yet. */
  claim: CheckinClaim | null
  settings: {
    problems: string[]
    /** Each setting as this engine uses it, by the settings file's key. */
    values: Record<"adiutorUrl" | "t3CliPath" | "t3Url" | "overviewDir", EffectiveSetting>
  }
}

export type CheckinBody = {
  /**
   * The request to run now: the one Adiutor answered (kept in the data folder before this answer), or null. With
   * `ok` false, the claim kept from an earlier check-in, if any.
   */
  claim: CheckinClaim | null
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

/** The events other than a human line, each with its own fields. */
type EventInput =
  Exclude<Event, { event: "message" }> extends infer E ? (E extends unknown ? Omit<E, "type"> : never) : never

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
    event(value: EventInput) {
      if (!done && json) write({ type: "event", ...value } as Event)
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
