# Mikud HTTP API and MCP tools

Status: implemented in `src/server/http/` and `src/server/mcp/`; request bodies are the zod schemas in `src/shared/api.ts`. The UI, the Telegram bot and the sync tool build on this contract. Product rules are in [requirements.md](requirements.md); the sync rules in "Agent and sync rules" of [project-foundation.md](project-foundation.md).

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
| `unauthorized` | 401 | No token or cookie, a wrong token, or a revoked or unknown device | |
| `forbidden` | 403 | Authenticated, but not allowed: an agent on an owner action, a browser request without the CSRF header or with the wrong `Origin` | |
| `not_found` | 404 | The item, project or other resource does not exist | |
| `validation_failed` | 400 (413 when the body is too large) | Bad JSON, a body or query that fails its schema, a rule such as "severity only on security items" | `issues: [{path, message}]` for schema failures |
| `version_conflict` | 409 | The item's `version` is not the one sent | `currentVersion` |
| `secret_suspected` | 422 | Agent text looks like a secret | `rule`, `field`. The matched text is never returned |
| `not_top_level` | 422 | A thread with a parent thread (subagent, review) | |
| `suppressed` | 409 | The owner deleted the item of this thread | |
| `conflict` | 409 | Another state conflict: a thread linked to another item, a project that still has items, a proposal decided already, a duplicate T3 project id | `itemId` or `projectId` when useful |
| `rate_limited` | 429 | 10 failed token attempts from this client within a minute | |
| `telegram_failed` | 502 | `POST /telegram/test-message`: Telegram did not take the message (refused, unreachable, or no clear answer) | |
| `internal_error` | 500 | Unexpected server error | |

## Authentication

Every route except `POST /pair` needs one of:

- **Bearer token**: `Authorization: Bearer <MIKUD_OWNER_TOKEN or MIKUD_AGENT_TOKEN>`. Compared in constant time on SHA-256 digests. The owner token acts as the owner; the agent token as an agent. An agent may add `X-Mikud-Agent: <name>` (letters, digits, space, `._:-`, up to 60 characters); the audit log then shows `agent:<name>`.
- **Device cookie** of a paired browser (`mikud_device`), which acts as the owner. Every request that is not `GET`, `HEAD` or `OPTIONS` must also send `X-Mikud-Request: 1` and an `Origin` equal to the origin of `MIKUD_PUBLIC_URL`, or it is refused with `forbidden`.

When both are present the bearer token is used. Failed token and cookie attempts count per client address: after 10 within a minute, every authenticated request and pairing attempt from that address answers `rate_limited` until the minute is over. The address is the socket's; behind the proxy all clients share one.

Rights: the owner may do everything. The agent token may do everything else except delete, change a stage, decide proposals, create projects, rename or re-link a project, and read or change settings, devices and suppressions (`forbidden`). Text written with the agent token is checked for secrets (`secret_suspected`).

Writes record an audit row with the actor and a source: `ui` (cookie), `api` (bearer token), `mcp`, `sync` (the sync routes), `telegram` (the bot, in process).

### Pairing a browser

`POST /pair` with `{"token": "<owner token>", "label": "Phone"}` (`label` optional, up to 100 characters), sent from the Mikud page: `X-Mikud-Request: 1` and the public `Origin` are required here too.

- `201 {"data": {"device": Device}}` and `Set-Cookie: mikud_device=<secret>; Max-Age=34560000; Path=/; HttpOnly; SameSite=Lax`, plus `Secure` unless `MIKUD_PUBLIC_URL` is `http://127.0.0.1`, `http://localhost` or `http://[::1]` (any port). No `Domain` attribute: the cookie is host-only. Only the secret's SHA-256 is stored.
- A wrong token: `401 unauthorized` (counts toward the rate limit). The agent token: `403 forbidden`.

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
- **Device**: `id, label, createdAt, lastSeenAt, revokedAt`. Never its hash.
- **Suppression**: `id, kind (thread, project), externalId, label (what was deleted), createdAt`.
- **Settings**: `id, closedItemDays (1 to 365, default 7), dateFormat, timeFormat, language (he, en), updatedAt`. The formats the UI offers are in `src/shared/datetime-formats.ts`: `dateFormat` is `dd/MM/yyyy` (default), `MM/dd/yyyy`, `dd.MM.yyyy`, `yyyy-MM-dd` or `browser`; `timeFormat` is `HH:mm` (default), `h:mm a` or `browser`. The morning message writes `browser`, and any value not offered, as the default numeric date and the 24-hour clock.
- **AuditEntry**: `id (number), at, actorKind, actorLabel, action, entityType, entityId, before, after, source`. Actions: `item.create|update|delete`, `comment.create`, `thread.link|update|move|unlink`, `project.create|update|delete`, `goal.create|close`, `proposal.create|update|accept|reject`, `security.update`, `suppression.create|delete`, `settings.update`, `device.pair|revoke|revoke_all`. Comment, thread, goal and proposal entries carry the entity of their item (`item`) or project (`project`), so an item's history includes them.

## Routes

"Owner" routes answer `forbidden` to the agent token.

### Session and the morning view

| Method and path | Who | Body or query | Answer |
|---|---|---|---|
| `GET /session` | any | | `{actor: {kind, label}, via: "token"\|"cookie", deviceId}` |
| `DELETE /session` | browser | | `204`; revokes this device and clears the cookie. `forbidden` with a token |
| `GET /morning` | any | `since?` (time) | Morning (below). `since` is this device's previous visit unless the query gives one |
| `POST /visits` | browser | `{at?}` (time) | `201 {at, previous}`. Call after the morning view was shown, with that read's `now`; recorded at `at`, or now when `at` is missing or later than the server's clock. `forbidden` with a token |

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

- `now`: the server's time when this read started. A visit recorded with it marks nothing newer than what this read showed as seen.
- `since`: the `since` query when given; else the device's latest recorded visit; 24 hours before now on a device's first visit, and always for token callers. Each device keeps its own. The UI keeps the `since` of the page's first read and passes it on every refresh, so "new since your last visit" stays stable while the page is open.
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

**Sync routes** accept a bearer token only (a browser cookie is `forbidden`). Changes are recorded with actor kind `sync`. Per-record failures are collected in `errors` (`record` is `project:<t3ProjectId>`, `thread:<threadId>`, `item:<id>`, `repo:<owner/name>` or `threads:<t3ProjectId>`; `code` is an error code) and never stop the run; `outcome` is `partial` when some failed or the snapshot lists `failedProjects`, `failed` when all failed.

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
| `PATCH /settings` | owner | `{closedItemDays?, dateFormat?, timeFormat?, language?}` | `Settings` |
| `GET /suppressions` | owner | | `Suppression[]`, newest first |
| `DELETE /suppressions/:id` | owner | | `204`. The sync may then recreate the item or project |
| `GET /devices` | owner | | `Device[]`, newest first |
| `DELETE /devices/:id` | owner | | `204`; the device's cookie stops working |
| `POST /devices/end-all` | owner | | `{ended}`: every device is revoked, the caller's too (its cookie is cleared) |
| `GET /telegram/status` | owner | | `TelegramStatus` (below) |
| `POST /telegram/test-message` | owner | | `{sent: true}`. Sends today's morning message (below) to the owner's chat now. `conflict` when Telegram is not configured, `telegram_failed` when Telegram did not take it |

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
- **Test message**: `POST /telegram/test-message` (Settings, "Send a test morning message") builds the same message the job would send now and sends it to the owner's chat at once. It never reads or writes `job_runs`, so the 08:00 message still goes out, and it records an audit row (action `telegram.test_message`, `after: {outcome}`: `sent` or the failure code). Not retried.

## MCP

Streamable HTTP at `/mcp`, stateless (no session id), JSON responses. Requires `Authorization: Bearer <owner or agent token>`; a browser cookie is not accepted. The server's `instructions` summarize the rules. Every tool answers one text content holding JSON: `{"data": ...}` on success, or `{"error": {code, message, ...details}}` with `isError: true`, using the codes above. Changes are audited with source `mcp`.

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

There is no tool to delete, to set a stage, or to touch settings, devices or suppressions.
