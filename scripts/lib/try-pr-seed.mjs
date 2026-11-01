// Seeds a pull request stack (scripts/try-pr.sh) with invented fixtures through the HTTP API, using
// the agent token only, so the board has something to show: projects from a T3 snapshot, items in
// every status, goals, a stage proposal, security sources, comments and an inbox item.
// Reads MIKUD_URL and MIKUD_AGENT_TOKEN from the environment. Never prints the token.

const base = process.env.MIKUD_URL
const token = process.env.MIKUD_AGENT_TOKEN
if (!base || !token) {
  console.error("MIKUD_URL and MIKUD_AGENT_TOKEN are required")
  process.exit(2)
}

const now = Date.now()
const ago = (hours) => new Date(now - hours * 3_600_000).toISOString()

async function call(method, path, body) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-mikud-agent": "try-pr seed",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    const code = json?.error?.code ?? "unknown"
    throw new Error(`${method} ${path} answered ${res.status} ${code}`)
  }
  return json?.data
}

const projects = [
  { t3ProjectId: "demo-harbor", title: "Harbor Notes", repo: "example-owner/harbor-notes" },
  { t3ProjectId: "demo-lantern", title: "Lantern Garden", repo: "example-owner/lantern-garden" },
  { t3ProjectId: "demo-ledger", title: "Quiet Ledger", repo: "example-owner/quiet-ledger" },
]

const thread = (threadId, t3ProjectId, title, status, settled, hours, extra = {}) => ({
  threadId,
  t3ProjectId,
  title,
  status,
  settled,
  settledAt: settled ? ago(hours) : null,
  parentThreadId: null,
  updatedAt: ago(hours),
  ...extra,
})

const t3 = await call("POST", "/sync/t3", {
  collectedAt: ago(0),
  projects,
  threads: [
    thread("demo-thread-harbor-1", "demo-harbor", "Add offline export", "running", false, 1),
    thread("demo-thread-harbor-1a", "demo-harbor", "Review offline export", "completed", true, 1, {
      parentThreadId: "demo-thread-harbor-1",
    }),
    thread("demo-thread-harbor-2", "demo-harbor", "Choose the sync format", "waiting", false, 3),
    thread("demo-thread-harbor-3", "demo-harbor", "Fix the date picker", "completed", true, 20),
    thread("demo-thread-lantern-1", "demo-lantern", "Plan the watering schedule view", "waiting", false, 5),
    thread("demo-thread-lantern-2", "demo-lantern", "Sketch the plant card", "completed", false, 30),
  ],
})

const byT3 = new Map((await call("GET", "/projects")).map((p) => [p.t3ProjectId, p]))
const id = (t3ProjectId) => {
  const project = byT3.get(t3ProjectId)
  if (!project) throw new Error(`project ${t3ProjectId} was not created by the snapshot`)
  return project.id
}
const harbor = id("demo-harbor")
const lantern = id("demo-lantern")
const ledger = id("demo-ledger")

await call("PATCH", `/projects/${harbor}`, {
  whereWeAre: "Export works on desktop; the phone layout is next.",
  goal: "Ship offline export",
})
await call("PATCH", `/projects/${lantern}`, { whereWeAre: "First screens sketched.", goal: "A usable first screen" })
await call("PATCH", `/projects/${ledger}`, { whereWeAre: "Paused until the import format is settled." })
const harborGoal = (await call("GET", `/projects/${harbor}`)).goal?.id ?? null

const items = [
  { projectId: harbor, type: "task", status: "todo", title: "Export to CSV", goalId: harborGoal },
  { projectId: harbor, type: "task", status: "done", title: "Export to JSON", goalId: harborGoal },
  { projectId: harbor, type: "bug", status: "in_progress", title: "Export skips empty notes", goalId: harborGoal },
  {
    projectId: harbor,
    type: "security",
    status: "todo",
    severity: "high",
    title: "Update the vulnerable markdown parser",
  },
  { projectId: harbor, type: "idea", status: "future", title: "Share a note as a link" },
  { projectId: lantern, type: "decision", status: "waiting_on_you", title: "Metric or imperial units by default?" },
  { projectId: lantern, type: "task", status: "not_relevant", title: "Port the old calendar widget" },
  { projectId: ledger, type: "task", status: "todo", title: "Write the import format notes" },
  { projectId: ledger, type: "bug", status: "waiting_on_you", title: "Totals differ after rounding", body: "Which rounding rule?" },
  {
    projectId: ledger,
    type: "security",
    status: "in_progress",
    severity: "critical",
    title: "Rotate the demo signing key",
  },
]
const created = []
for (const item of items) created.push(await call("POST", "/items", item))

await call("POST", `/items/${created[2].id}/comments`, { text: "Reproduced with a note that has only a title." })
await call("POST", `/items/${created[5].id}/comments`, { text: "Both work; metric matches the plant data source." })
await call("POST", `/projects/${harbor}/stage-proposals`, {
  stage: "development",
  reason: "Most of the export is built and used daily.",
})
await call("POST", `/projects/${ledger}/stage-proposals`, { stage: "frozen", reason: "No work for three weeks." })
await call("POST", "/capture", { text: "Try a weekly summary view\nSeen in another tool; maybe for the phone." })
await call("POST", "/threads/start", {
  threadId: "demo-thread-ledger-1",
  parentThreadId: null,
  title: "Investigate the rounding difference",
  t3ProjectId: "demo-ledger",
})

const counts = (critical, high, medium, low) => ({ critical, high, medium, low })
const security = await call("POST", "/sync/security", {
  collectedAt: ago(0),
  repos: [
    {
      repo: "example-owner/harbor-notes",
      openIssues: 4,
      issuesAsOf: ago(1),
      families: [
        { family: "dependabot", coverage: "enabled", counts: counts(1, 2, 0, 1), asOf: ago(1) },
        { family: "code_scanning", coverage: "enabled", counts: counts(0, 0, 1, 2), asOf: ago(1) },
        { family: "secret_scanning", coverage: "not_enabled", counts: counts(0, 0, 0, 0), asOf: null },
      ],
    },
    {
      repo: "example-owner/lantern-garden",
      openIssues: 0,
      issuesAsOf: ago(1),
      families: [{ family: "dependabot", coverage: "no_access", counts: counts(0, 0, 0, 0), asOf: null }],
    },
    {
      repo: "example-owner/quiet-ledger",
      openIssues: 2,
      issuesAsOf: ago(50),
      families: [{ family: "dependabot", coverage: "enabled", counts: counts(0, 1, 0, 0), asOf: ago(50) }],
    },
  ],
})

console.log(
  `    seeded ${byT3.size} projects, ${created.length + 2} items besides the synced ones, 2 stage proposals;` +
    ` T3 sync ${t3.outcome}, security sync ${security.outcome}`,
)
