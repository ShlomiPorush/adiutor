# Mikud HTTP API and MCP tools

Status: implemented in `src/server/http/`, `src/server/auth/` and `src/server/mcp/`; request bodies are the zod schemas in `src/shared/api.ts`. The UI, the Telegram bot and the sync tool build on this contract. Product rules are in [requirements.md](requirements.md); the sync rules in "Agent and sync rules" of [project-foundation.md](project-foundation.md).

## Conventions

- Base path `/api/v1`. JSON in and out (`Content-Type: application/json`). Bodies are limited to 512 KiB, sync snapshots to 16 MiB.
- Success: `{"data": ...}`. Paged lists: `{"data": [...], "nextCursor": "..." | null}`; pass `cursor=<nextCursor>` for the next page. `201` for a created resource, `204` (no body) for a delete.
- Error: `{"error": {"code": "<code>", "message": "<for people>", ...details}}`. Branch on `code`, never on `message`.
- Times are ISO 8601 strings in UTC. Ids are UUIDs, except T3 thread and project ids (opaque strings, up to 200 characters).
- Codes (stage, status, type, severity, actor kind) are the English codes of `src/shared/enums.ts`. Labels come from the locale files.
- Unknown body fields are ignored. A path id that is not a UUID answers `not_found`.

### Error codes

| Code | HTTP | Meaning | Details |
|---|---|---|---|
| `unauthorized` | 401 | No token or session, a wrong token, or a session that was signed out | |
| `session_ended` | 401 | The session clocks ended this browser's session | `reason`: `max` or `idle` |
| `forbidden` | 403 | Authenticated, but not allowed: an agent on an owner action, a token on a browser-only route, a browser request without the CSRF header or with the wrong `Origin` | |
| `totp_required` | 403 | A browser session that has not proved its TOTP code yet: it may only finish enrolment | |
| `not_found` | 404 | The item, project or other resource does not exist | |
| `validation_failed` | 400 (413 when the body is too large) | Bad JSON, a body or query that fails its schema, a rule such as "severity only on security items" | `issues: [{path, message}]` for schema failures |
| `version_conflict` | 409 | The item's `version` is not the one sent | `currentVersion` |
| `secret_suspected` | 422 | Agent text looks like a secret | `rule`, `field`. The matched text is never returned |
| `not_top_level` | 422 | A thread with a parent thread (subagent, review) | |
| `suppressed` | 409 | The owner deleted the item of this thread | |
| `conflict` | 409 | Another state conflict: a thread linked to another item, a project that still has items, a proposal decided already, a duplicate T3 project id | `itemId` or `projectId` when useful |
| `already_set_up` | 409 | `POST /api/setup/account` when the owner exists | |
| `wrong_password` | 400 | `POST /account/password`: the current password is not right | |
| `rate_limited` | 429 | 10 failed token attempts from this client within a minute; or 5 sign-ins, codes, setups or password changes within 5 minutes | |
| `busy` | 503 | A sign-in change waited more than 10 seconds for another one to finish | |
| `telegram_failed` | 502 | `POST /telegram/test-message`: Telegram did not take the message (it refused it, or the server could not reach Telegram at all) | |
| `telegram_uncertain` | 502 | `POST /telegram/test-message`: Telegram gave no clear answer (a timeout, a lost connection, a 5xx): the message may have been sent. Check the chat before sending again | |
| `internal_error` | 500 | Unexpected server error | |

## Authentication

Every route under `/api/v1` needs one of:

- **Bearer token**: `Authorization: Bearer <MIKUD_OWNER_TOKEN or MIKUD_AGENT_TOKEN>`. Compared in constant time on SHA-256 digests. The owner token acts as the owner (for scripts and tests; a browser never uses it); the agent token as an agent. An agent may add `X-Mikud-Agent: <name>` (letters, digits, space, `._:-`, up to 60 characters); the audit log then shows `agent:<name>`.
- **The owner's browser session** (Better Auth, below), which acts as the owner. The session must be live under the session clocks (else `401 session_ended` with `reason`) and must have proved its TOTP code (else `403 totp_required`). Every request that is not `GET`, `HEAD` or `OPTIONS` must also send `X-Mikud-Request: 1` and an `Origin` equal to the origin of `MIKUD_PUBLIC_URL`, or it is refused with `forbidden`. A session never stands in for a token where a token is required: the sync routes answer it `forbidden`, and `/mcp` accepts bearer tokens only.

When both are present the bearer token is used. Failed token attempts count per client address: after 10 within a minute, every bearer request from that address answers `rate_limited` until the minute is over. The address is always the socket's, never a forwarding header; behind the proxy all clients share one.

Rights: the owner may do everything. The agent token may do everything else except delete, change a stage, decide proposals, create projects, rename or re-link a project, read or change settings and suppressions, and the account and session routes (`forbidden`). Text written with the agent token is checked for secrets (`secret_suspected`).

Writes record an audit row with the actor and a source: `ui` (browser session), `api` (bearer token), `mcp`, `sync` (the sync routes), `telegram` (the bot, in process), `cli` (the recovery command on the server).

### Browser sign-in

One account, the owner's: a username, a password and a TOTP code from an authenticator app, through Better Auth (`better-auth` 1.7.10) under `/api/auth`. Sessions are cookies (`better-auth.session_token`, with the `__Secure-` prefix when `MIKUD_PUBLIC_URL` is `https`), `HttpOnly`, `SameSite=Lax`, host-only. Answers under `/api/auth` have Better Auth's flat error shape, `{"code", "message", ...}`, which its client reads.

Mikud's guard in front of Better Auth admits only these routes; every other path or method under `/api/auth` answers `404 not_found` (sign-up, `/sign-in/email`, `/change-password`, `/list-sessions`, `/revoke-*`, `/two-factor/disable`, backup codes, `/is-username-available` and the rest):

| Method and path | Body | Notes |
|---|---|---|
| `POST /api/auth/sign-in/username` | `{username, password}` | `rememberMe: false` is refused (`400 remember_me_unsupported`). An owner with TOTP gets `{twoFactorRedirect: true}` and a short-lived challenge cookie, no session. An owner without TOTP (new, or after the recovery command) gets a session that may only enrol |
| `POST /api/auth/two-factor/verify-totp` | `{code}` | With the challenge cookie (sign-in) or a session that has not proved TOTP (enrolment). A session that has proved it gets `400 totp_already_proved`; `trustDevice: true` is `400 trust_device_unsupported`. A wrong code is `401` and changes nothing |
| `POST /api/auth/two-factor/enable` | `{password}` | Enrolment only (a session that has not proved TOTP; else `403 forbidden`). Answers `{totpURI}`; backup codes are never returned |
| `POST /api/auth/sign-out` | | Ends this session and clears its cookie |
| `GET /api/auth/get-session` | | A plain read. A session the clocks ended answers `null` |

- **CSRF:** every `POST` above, and `POST /api/setup/account`, must send `X-Mikud-Request: 1` and the public `Origin`, checked before the body is read (`403 forbidden`). `GET` routes are plain same-origin reads.
- **Rate limits:** sign-in and TOTP codes 5 per 5 minutes each, per client address (`429 rate_limited`); setup and the password change likewise. Better Auth's own limiter is off. Behind the proxy all clients share one address, which fails safe for one owner.
- **One at a time:** every `POST` above holds the auth lock for the whole request (a session-level PostgreSQL advisory lock on a connection of its own); the setup, the password change, the session routes, the clock sweep and the recovery command take the same lock. A request that waits more than 10 seconds answers `503 busy`.
- **What a success records,** in one transaction with the lock held, read from the final response: a sign-in completed by its code, or an enrolment, marks the session's TOTP proof (`two_factor_at`, on the new session found by the token in `Set-Cookie`, else on the current one); enrolment ends every other session of the owner; a session that replaces another keeps its clocks; the audit row (`session.sign_in`, `account.totp_enable`). When that transaction fails, the new session and the challenge rows the request created are deleted and the answer is `500 internal_error` with the session cookie cleared: a sign-in never succeeds without its audit row. A sign-out whose audit row cannot be written still succeeds (the session is gone).

**Session clocks** (Settings): a session ends `sessionMaxDays` (1 to 90, default 30) after sign-in, and, when `sessionIdle` is on (default off), `sessionIdleMinutes` (5 to 1440, default 30) after the last real input the page reported. Polling and refreshes never count as input. An ended session answers `401 session_ended` with `reason` (`max`, `idle`) on `/api/v1` and on Better Auth's routes until it is removed by the hourly sweep a day later. Better Auth keeps every session 91 days and never extends it, so the clocks always decide first.

### First run

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/setup/status` | | `{hasUser, session: "none" \| "enrol" \| "active"}`: whether the owner exists, and whether this browser's session may only enrol or has proved TOTP |
| `POST /api/setup/account` | `{username, password}` | `201 {username, signedIn}`. Only while there is no owner (`409 already_set_up` after; two setups racing create one owner). `username`: 3 to 30 of `a-z A-Z 0-9 _ .`, stored lowercased; `password`: 12 to 128 characters. The owner is created and audited (`account.setup`), then signed in after the commit (the session cookie is set); `signedIn: false` means the account exists and the browser should sign in |

### Recovery

`node dist/server/cli.js reset-password`, run in the container on the server, sets a new random password and prints it once, removes TOTP, ends every session and pending sign-in, and writes the audit row `account.password_reset` (actor `system`, label `cli`, source `cli`), in one transaction under the auth lock. There is no recovery route over HTTP.

## Shapes

Fields are always present; `null` when unset.

- **Item**: `id, projectId (null: inbox), type, status, title, body, severity (security only), goalId, version, statusSetBy, statusSetAt, createdBy, imported, createdAt, updatedAt, closedAt (set exactly when status is done or not_relevant)`.
- **ItemSummary**: `id, projectId, projectName, type, status, title, severity, goalId, version, statusSetBy, createdAt, updatedAt, closedAt`.
- **Project**: `id, name, slug, t3ProjectId, githubRepo ("owner/name"), stage (null until the owner sets one), whereWeAre, openIssuesCount, openIssuesAsOf, createdAt, updatedAt`.
- **GoalProgress**: `id, text, createdAt, done, total`: `done` items linked to the current goal out of `total` items linked to it.
- **Goal**: `id, projectId, text, createdAt, closedAt`.
- **ThreadLink**: `id, itemId, threadId, t3ProjectId, title, lastStatus (T3's status), settled, lastActivityAt, linkedAt`.
- **Comment**: `id, itemId, authorKind, authorLabel, text, threadId, createdAt`.
- **StageProposal**: `id, projectId, proposedStage, reason, authorKind, authorLabel, state (open, accepted, rejected), createdAt, decidedAt`.
- **SecuritySource**: `id, projectId, family (dependabot, code_scanning, secret_scanning, overview), coverage (enabled, not_enabled, no_access, error, unknown), critical, high, medium, low, asOf, updatedAt`.
- **SyncRun**: `id, kind (t3, security), startedAt, finishedAt, outcome (succeeded, partial, failed; null while running), counts {name: number}, errors [{record, code}]`.
- **SyncResult**: `runId, outcome, counts, errors`.
- **AccountSession**: `id, current (this browser), signedInAt, activeAt (last real input), userAgent`. Only sessions that proved TOTP and have not ended. Never a token.
- **Suppression**: `id, kind (thread, project), externalId, label (what was deleted), createdAt`.
- **Settings**: `id, closedItemDays (1 to 365, default 7), dateFormat, timeFormat, language (he, en), sessionMaxDays (1 to 90, default 30), sessionIdle (default false), sessionIdleMinutes (5 to 1440, default 30), updatedAt`. The formats the UI offers are in `src/shared/datetime-formats.ts`: `dateFormat` is `dd/MM/yyyy` (default), `MM/dd/yyyy`, `dd.MM.yyyy`, `yyyy-MM-dd` or `browser`; `timeFormat` is `HH:mm` (default), `h:mm a` or `browser`. The morning message writes `browser`, and any value not offered, as the default numeric date and the 24-hour clock.
- **AuditEntry**: `id (number), at, actorKind, actorLabel, action, entityType, entityId, before, after, source`. Actions: `item.create|update|delete`, `comment.create`, `thread.link|update|move|unlink`, `project.create|update|delete`, `goal.create|close`, `proposal.create|update|accept|reject`, `security.update`, `suppression.create|delete`, `settings.update`, `account.setup|totp_enable|password_change|password_reset`, `session.sign_in|sign_out|end|end_others|end_all|sweep`, `telegram.test_message`. Rows from before sign-in may also hold `device.pair|revoke|revoke_all`. Comment, thread, goal and proposal entries carry the entity of their item (`item`) or project (`project`), so an item's history includes them.

## Routes

"Owner" routes answer `forbidden` to the agent token.

### Session and the morning view

| Method and path | Who | Body or query | Answer |
|---|---|---|---|
| `GET /session` | any | | `{actor: {kind, label}, via: "token"\|"session", browserId, clocks}`. `clocks` (a session only): `{max: {remainingSec}, idle: {timeoutSec, remainingSec} \| null}` |
| `POST /session/activity` | browser | | `{clocks}`. Real input on the page (keys, pointer, wheel, touch), sent at most every 30 seconds: restarts the idle clock. Polling never calls it |
| `GET /account/sessions` | browser | | `{username, sessions: AccountSession[]}`, this browser first |
| `POST /account/password` | browser | `{currentPassword, newPassword}` (12 to 128 characters) | `{endedSessions}`. Every other session ends; this one keeps its TOTP proof and clocks. `wrong_password`; rate limited |
| `POST /account/sessions/end-others` | browser | | `{ended}`: every other session of the owner ends |
| `POST /account/sessions/end-all` | browser | | `{ended}`: every session ends, this one too, and its cookie is cleared ("Sign out everywhere") |
| `GET /morning` | any | `since?` (time) | Morning (below). `since` is this browser's previous visit unless the query gives one |
| `POST /visits` | browser | `{at?}` (time) | `201 {at, previous}`. Call after the morning view was shown, with that read's `now`; recorded one minute before `at`, or before now when `at` is missing or later than the server's clock (see below). `forbidden` with a token |

"browser" routes need the owner's browser session (`forbidden` with a token). The account and session routes each run in one transaction under the auth lock with their audit row (`account.password_change`, `session.end_others`, `session.end_all`).

**Browser identity:** the first signed-in request of a browser sets `mikud_browser` (a random id, `HttpOnly`, `SameSite=Lax`, for 400 days). It names the browser for "new since your last visit" only and never authenticates; a request with only this cookie is `unauthorized`.

**Morning**:

```text
{
  now, since,
  waiting: [ {kind: "item", at, item: ItemSummary}            // status waiting_on_you
           | {kind: "stage_proposal", at, proposal: {id, projectId, projectName, currentStage,
                                                      proposedStage, reason, authorKind, authorLabel, createdAt}} ],
  new: [ {change: "created" | "updated", item: ItemSummary} ],
  security: [ {projectId, projectName, stage, critical, high, alerts: {critical, high},
               items: {critical, high}, asOf, stale} ],
  agentUpdates: [ {projectId, projectName, updates: [
      {kind: "comment", at, itemId, itemTitle, actorKind, actorLabel, text}
    | {kind: "status",  at, itemId, itemTitle, actorKind, actorLabel, from, to} ]} ],
  projects: [ {id, name, slug, stage, goal: GoalProgress | null, whereWeAre, openItems,
               openIssues, openIssuesAsOf, repo} ],
  inboxCount,
  sync: {lastSuccessAt, stale, lastPartialAt, securityLastSuccessAt}
}
```

- `now`: the server's time when this read started. A visit recorded with it marks nothing newer than what this read showed as seen. The visit is stored one minute before `now`: a write whose transaction was still open during the read has a time before `now` but at most 30 seconds before it (PostgreSQL ends any transaction of the server after 30 seconds), so it still counts as new on the next visit. Items written in that minute may show as new twice; none is hidden.
- `since`: the `since` query when given; else the browser's latest recorded visit; 24 hours before now on a browser's first visit, and always for token callers. Each browser keeps its own. The UI keeps the `since` of the page's first read and passes it on every refresh, so "new since your last visit" stays stable while the page is open.
- Items shown anywhere in the view: open items, and closed ones closed within `closedItemDays`. Older closed items are only in the archive.
- `new`: created after `since` (`change: "created"`, except items imported by the first sync run) or changed after `since` and after their creation (`"updated"`). Newest first.
- `security`: one line per project with something to say. `critical` counts in every project, `high` only at stage `production` (0 elsewhere). Counts come from enabled `dependabot`, `code_scanning` and `secret_scanning` sources plus open `security` items of the project. `asOf` is the oldest as-of time of the project's enabled sources (null when it has none); `stale` is true when that time is unknown or older than 26 hours.
- `agentUpdates`: comments and status changes by agents and the sync after `since`, grouped by project (`projectId: null` for the inbox), groups and updates newest first, at most 300 of each kind.
- `projects`: projects with at least one open item, by name.
- `sync.lastSuccessAt`: when the last complete T3 run (`succeeded`) finished; a `partial` run may have missed whole projects, so it never counts as fresh. `sync.lastPartialAt`: when the latest `partial` T3 run finished, only when it is later than `lastSuccessAt` (else null). `sync.securityLastSuccessAt`: the latest security run that was `succeeded` or `partial`.
- `sync.stale`: no complete T3 sync, or the last one finished more than 26 hours ago.

### Projects

| Method and path | Who | Body or query | Answer |
|---|---|---|---|
| `GET /projects` | any | | `[Project & {goal: GoalProgress\|null, openItems, openProposals}]` by name |
| `POST /projects` | owner | `{name, slug?, t3ProjectId?, githubRepo?, stage?}` | `201 Project`. `conflict` on a taken `t3ProjectId` |
| `GET /projects/:id` | any | | `{project, goal, pastGoals: Goal[], items: ItemSummary[], proposals: StageProposal[], securitySources, security}` |
| `PATCH /projects/:id` | any | `{name?, slug?, githubRepo?, stage?, whereWeAre?, goal?}` | `Project`. Agents may send only `whereWeAre` and `goal`; `stage` or another field is `forbidden` |
| `DELETE /projects/:id` | owner | | `204`. `conflict` while it has items. Suppresses its T3 project id |
| `POST /projects/:id/stage-proposals` | any | `{stage, reason?}` | `201 StageProposal`. An open proposal of the same stage is updated and returned instead |
| `POST /stage-proposals/:id/decision` | owner | `{decision: "accept"\|"reject"}` | `{proposal, project}`. Accepting sets the stage. `conflict` when decided already |

`goal`: a text sets a new current goal and closes the previous one; `null` closes it; the same text changes nothing. Items keep the goal they were linked to.

### Items

| Method and path | Who | Body or query | Answer |
|---|---|---|---|
| `GET /items` | any | `q`, `projectId`, `inbox=true`, `status` (repeat or comma-separated), `type`, `threadId`, `includeClosed=true`, `limit` (1 to 200, default 50) | `ItemSummary[]`, newest change first. Open items only unless `status` or `includeClosed` is given |
| `POST /items` | any | `{type, title, projectId?, status? (default todo), body?, severity?, goalId?}` | `201 Item` |
| `GET /items/:id` | any | | `{item, project: {id, name, slug, stage}\|null, goal, threads: ThreadLink[], comments: Comment[] (oldest first), audit: AuditEntry[] (newest first, up to 100)}` |
| `PATCH /items/:id` | any | `{version, title?, body?, type?, status?, severity?, projectId?, goalId?}` | `Item` with `version + 1`; the same item when nothing changed. `version_conflict` when stale |
| `DELETE /items/:id` | owner | `version` (optional query) | `204`. Deletes links and comments; suppresses the linked T3 threads |
| `POST /items/:id/comments` | any | `{text, threadId?}` | `201 Comment` |
| `POST /items/:id/threads` | any | `{threadId, parentThreadId?, t3ProjectId?, title?}` | `{link, created}`: `201` when linked now, `200` when it was linked to this item already. `not_top_level`, `conflict` (linked to another item, `itemId`), `suppressed` (agents; the owner linking it removes the suppression) |
| `POST /capture` | any | `{text, projectId?}` | `201 Item`: type `idea`, status `future`, in the inbox unless `projectId`. The first line is the title; the whole text is the body when longer |
| `GET /inbox` | any | | Open items without a project, newest first |
| `GET /archive` | any | `projectId?`, `cursor?`, `limit?` | Page of closed items (`ItemSummary`), most recently closed first |
| `GET /audit` | any | `entityType?`, `entityId?`, `cursor?`, `limit?` | Page of `AuditEntry`, newest first |

Item rules: entering `done` or `not_relevant` sets `closedAt`; any other status clears it. A status change records `statusSetBy` (the actor kind) and `statusSetAt`. Changing the type away from `security` clears the severity. Moving an item to another project clears its goal unless a goal of the new project is given. Titles are trimmed to one line of at most 300 characters.

### T3 threads and sync

| Method and path | Who | Body | Answer |
|---|---|---|---|
| `POST /threads/start` | any | `{threadId, parentThreadId (required, null for a top-level thread), title, projectId?, t3ProjectId?, itemId?}` | `{item: Item, created, linked}`: `201` when an item was created, else `200` |
| `POST /sync/t3` | token | T3 snapshot (below) | `SyncResult` |
| `POST /sync/security` | token | Security snapshot (below) | `SyncResult` |
| `GET /sync/runs` | any | `limit?` (default 20) | `SyncRun[]`, newest first |

**Start of thread**, in one transaction: refuses `not_top_level` when `parentThreadId` is set; returns the item already linked to `threadId` (also on a retry or a race); otherwise links `itemId`, or creates a `task` in `projectId`, or in the project whose `t3ProjectId` matches, or in the inbox. The item is set `in_progress` (a closed item reopens). `suppressed` when the owner deleted this thread's item; `conflict` when `itemId` differs from the item the thread is linked to.

**Sync routes** accept a bearer token only (a browser session is `forbidden`). Changes are recorded with actor kind `sync`. Per-record failures are collected in `errors` (`record` is `project:<t3ProjectId>`, `thread:<threadId>`, `item:<id>`, `repo:<owner/name>` or `threads:<t3ProjectId>`; `code` is an error code) and never stop the run; `outcome` is `partial` when some failed or the snapshot lists `failedProjects`, `failed` when all failed.

T3 snapshot, a full read of every top-level and child thread of every T3 project, never a delta:

```text
{
  collectedAt,
  projects: [ {t3ProjectId, title, repo?: "owner/name" | null} ],
  threads:  [ {threadId, t3ProjectId | null, title, status, settled, settledAt?: time | null,
               parentThreadId?: id | null, updatedAt} ],
  failedProjects?: [ t3ProjectId ]
}
```

- `failedProjects`: T3 projects whose threads the sync tool could not read in this run, or read only in part (invalid thread records). Each is recorded in `errors` as `{record: "threads:<t3ProjectId>", code: "threads_not_read"}`, the run is `partial`, and no item of those projects (by its project or by a link's `t3ProjectId`) is decided in this run (`counts.itemsNotDecided`).

- Projects: created by `t3ProjectId` with the redacted title as name, `stage: null` and the repository; an existing project keeps its name and only gets a repository when it has none; a suppressed project id is skipped.
- A thread with a `parentThreadId` never gets an item. When it is linked, the link moves to its top-level thread (the parent's parent, as far as the snapshot knows): deleted when that thread has its own link, re-pointed otherwise.
- A top-level thread without an item and without a suppression (of the thread or its project) gets a `task` titled from the redacted thread title, in the mapped project or the inbox: when unsettled, whatever its age (`waiting` → `waiting_on_you`, otherwise `in_progress`); when settled, only if it settled (`settledAt`, else `updatedAt`) at most 7 days before `collectedAt` (status `done`). Items created by the first successful run are `imported`.
- Every link is refreshed (title, status, settled, `updatedAt` as last activity) when the record's `updatedAt` is newer than the stored last activity (an older or equal record is ignored, so snapshots applied out of order never roll back), then every item with a link is decided over all its links: any `running`, `starting`, `queued` or `preparing` → `in_progress`; otherwise any `waiting` → `waiting_on_you`; otherwise all settled → `done`; otherwise no change. The sync never moves an item out of `done` or `not_relevant`, never sets `done` on `future` or `todo`, and leaves a status the owner set at or after the threads' latest activity. Each change is a compare-and-set on the version read in that run; a changed or deleted item is skipped (`counts.itemsSkipped`) and decided again next run.
- Counts: `projectsCreated`, `projectsUpdated`, `projectsSuppressed`, `childLinksFolded`, `threadsUpdated`, `threadsSuppressed`, `threadsTooOld`, `itemsCreated`, `itemsUpdated`, `itemsSkipped`, `itemsNotDecided` (only the non-zero ones are present).

Security snapshot, from the `overview` collector:

```text
{
  collectedAt,
  repos: [ {repo: "owner/name", openIssues: n | null, issuesAsOf: time | null,
            families: [ {family, coverage, counts: {critical, high, medium, low}, asOf: time | null} ]} ]
}
```

Each repository is matched to every project whose `githubRepo` equals it, ignoring case (`counts.reposUnmatched` otherwise). The project's open Issues count and its time are replaced; each listed family is upserted; families not listed keep their last values. A family, or the open Issues count, whose as-of time is older than the stored one is ignored. `asOf` is the source's last success, not the sync time. An unchanged project writes nothing.

### Owner settings

| Method and path | Who | Body | Answer |
|---|---|---|---|
| `GET /settings` | owner | | `Settings` |
| `PATCH /settings` | owner | `{closedItemDays?, dateFormat?, timeFormat?, language?, sessionMaxDays?, sessionIdle?, sessionIdleMinutes?}` | `Settings` |
| `GET /suppressions` | owner | | `Suppression[]`, newest first |
| `DELETE /suppressions/:id` | owner | | `204`. The sync may then recreate the item or project |
| `GET /telegram/status` | owner | | `TelegramStatus` (below) |
| `POST /telegram/test-message` | owner | | `{sent: true, warning?}`. Sends today's morning message (below) to the owner's chat now. `warning: "outcome_not_recorded"` when it was sent but the outcome's audit row could not be written. `conflict` when Telegram is not configured, `telegram_failed` when Telegram did not take it, `telegram_uncertain` when it may have been sent |

### Telegram

The bot and the morning message run inside the server, never through this API. They are on only when `MIKUD_TELEGRAM_BOT_TOKEN` and `MIKUD_TELEGRAM_CHAT_ID` are both set; the server refuses to start with only one of them.

**TelegramStatus**:

```text
{
  configured,          // both Telegram values are set
  polling,             // the bot's latest getUpdates call succeeded (false when not configured)
  lastUpdateAt,        // when the bot last recorded an update from any chat, or null
  lastMorning: {localDate: "YYYY-MM-DD", state, at} | null   // the latest morning run
}
```

- `lastMorning.state`: `sending` (in progress), `sent`, `failed` (Telegram refused it with a 4xx answer, or there was no connection; retried every 30 seconds until 11:00), `unknown` (it may have gone out: a timeout, a dropped connection, a 5xx or an answer that is not Telegram's, or a restart during the send; never resent) or `skipped` (11:00 passed without a send). `at` is the time of the latest state change.
- **Quick add**: plain text from the owner's chat becomes an inbox item exactly like `POST /capture` (type `idea`, status `future`), created by actor kind `bot` with audit source `telegram`. The bot answers with a link to `<MIKUD_PUBLIC_URL>/items/<id>`. Text that looks like a secret is refused as agent text is, and the bot answers that nothing was saved without repeating the text. `/start`, `/help` and other commands answer with a help text; photos and other non-text messages with a short note. Other chats get no answer.
- **Morning message**: 08:00 Asia/Jerusalem, Sunday to Friday, in the language of the settings, built from the morning view (above) with `since` set to the owner's last visit on any device or the last morning message, whichever is later. Deep links: `<MIKUD_PUBLIC_URL>/` and `<MIKUD_PUBLIC_URL>/items/<id>`.
- **Test message**: `POST /telegram/test-message` (Settings, "Send a test morning message") builds the same message the job would send now and sends it to the owner's chat at once. It never reads or writes `job_runs`, so the 08:00 message still goes out, and it records two audit rows (action `telegram.test_message`): `after: {state: "sending"}`, committed before the send, then `after: {state, code?}` with `sent`, `failed` or `uncertain` and the failure code. Not retried.

## MCP

Streamable HTTP at `/mcp`, stateless (no session id), JSON responses. Requires `Authorization: Bearer <owner or agent token>`; a browser session is not accepted. The server's `instructions` summarize the rules. Every tool answers one text content holding JSON: `{"data": ...}` on success, or `{"error": {code, message, ...details}}` with `isError: true`, using the codes above. Changes are audited with source `mcp`.

| Tool | Arguments | Same as |
|---|---|---|
| `mikud_start_thread` | `threadId, parentThreadId (null or id), title, projectId?, t3ProjectId?, itemId?` | `POST /threads/start` |
| `mikud_find_items` | `query?, projectId?, inbox?, status?[], type?, threadId?, includeClosed?, limit?` | `GET /items` |
| `mikud_get_item` | `itemId` | `GET /items/:id` |
| `mikud_create_item` | `type, title, body?, status?, severity?, projectId?, goalId?` | `POST /items` |
| `mikud_update_item` | `itemId, version, title?, body?, status?, type?, severity?, projectId?, goalId?` | `PATCH /items/:id` |
| `mikud_comment` | `itemId, text, threadId?` | `POST /items/:id/comments` |
| `mikud_capture` | `text, projectId?` | `POST /capture` |
| `mikud_link_thread` | `itemId, threadId, parentThreadId, t3ProjectId?, title?` | `POST /items/:id/threads` |
| `mikud_list_projects` | | `GET /projects` |
| `mikud_update_project` | `projectId, whereWeAre?, goal?` | `PATCH /projects/:id` (those two fields only) |
| `mikud_propose_stage` | `projectId, stage, reason` | `POST /projects/:id/stage-proposals` |

There is no tool to delete, to set a stage, or to touch settings, the account, sessions or suppressions.
