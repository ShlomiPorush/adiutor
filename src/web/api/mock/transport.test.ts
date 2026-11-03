// The mock's activity log filters and counts as the server does (docs/api.md, Audit filters), so the UI on the
// mock shows what it shows against the server: each count is what choosing its value lists, page by page.

import { describe, expect, it } from "vitest"
import { ACTOR_KINDS } from "../../../shared/enums.ts"
import en from "../../../shared/locales/en.json"
import type { AuditCounts, AuditEntry } from "../types.ts"
import { mockTransport } from "./transport.ts"

type Answer = { data: AuditEntry[]; nextCursor: string | null; total?: number; counts?: AuditCounts }

async function get(query: Record<string, string>): Promise<Answer> {
  const answer = await mockTransport({ method: "GET", path: `/audit?${new URLSearchParams(query)}` })
  expect(answer.status).toBe(200)
  return answer.body as Answer
}

async function pageAll(query: Record<string, string>): Promise<AuditEntry[]> {
  const rows: AuditEntry[] = []
  let cursor: string | null = null
  do {
    const answer: Answer = await get({ ...query, limit: "10", ...(cursor ? { cursor } : {}) })
    rows.push(...answer.data)
    cursor = answer.nextCursor
  } while (cursor)
  return rows
}

describe("the mock's activity log", () => {
  it("counts what each choice lists, the kinds without the agent", { timeout: 60_000 }, async () => {
    const first = await get({ agent: "agent:claude" })
    const counts = first.counts
    if (!counts) throw new Error("no counts")
    expect(first.total).toBe((await pageAll({ agent: "agent:claude" })).length)
    for (const kind of ACTOR_KINDS)
      expect((await pageAll({ actorKind: kind })).length, kind).toBe(counts.actorKind[kind])
    for (const { label, count } of counts.agents) expect((await pageAll({ agent: label })).length, label).toBe(count)
    for (const { action, count } of counts.actions)
      expect((await pageAll({ agent: "agent:claude", action })).length, action).toBe(count)
    for (const { projectId, count } of counts.projects)
      expect((await pageAll({ agent: "agent:claude", projectId })).length, projectId).toBe(count)
  })

  it("searches the labels of the language it is given", { timeout: 30_000 }, async () => {
    const words = await pageAll({ q: en.audit.action.item_update, lang: "en" })
    expect(words.length).toBeGreaterThan(0)
    expect(words.every((row) => row.action === "item.update")).toBe(true)
    expect(await pageAll({ q: en.audit.action.item_update })).toHaveLength(0)
  })
})
