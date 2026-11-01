import { describe, expect, it } from "vitest"
import he from "../../shared/locales/he.json"
import { buildMorningMessage, type MessageOptions, type MorningSummary } from "./morning-message.ts"

const URL_BASE = "https://mikud.example.com"
const options: MessageOptions = { language: "en", publicUrl: URL_BASE, dateFormat: "dd/MM/yyyy", timeFormat: "HH:mm" }
const fresh = { lastSuccessAt: new Date("2026-11-01T05:30:00Z"), stale: false }

// 2026-10-30 05:31 UTC is 07:31 in Asia/Jerusalem (winter time, UTC+2).
const full: MorningSummary = {
  waiting: [
    { kind: "item", item: { id: "i-1", title: "Approve the <beta> release & notes" } },
    { kind: "stage_proposal", proposal: { projectName: "Gizmo" } },
    { kind: "item", item: { id: "i-3", title: "Not shown: only two titles" } },
  ],
  newCount: 4,
  security: [
    { projectName: "Widget", critical: 2, high: 1, asOf: new Date("2026-10-30T05:31:00Z"), stale: true },
    { projectName: "Gadget", critical: 1, high: 0, asOf: new Date("2026-11-01T05:00:00Z"), stale: false },
    { projectName: "Gizmo", critical: 1, high: 0, asOf: null, stale: true },
  ],
  sync: { lastSuccessAt: new Date("2026-10-30T05:30:00Z"), stale: true },
}

const lines = (text: unknown) => String(text).split("\n")

describe("buildMorningMessage", () => {
  it("builds six lines: waiting, new, two security lines, the stale sync and the board link", () => {
    expect(lines(buildMorningMessage(full, options))).toEqual([
      `<b>Waiting on you: 3</b> · <a href="${URL_BASE}/items/i-1">Approve the &lt;beta&gt; release &amp; notes</a> · Gizmo: stage proposal`,
      "New since your last visit: 4",
      "Security, Widget: 2 critical, 1 high (data from 30/10/2026 07:31)",
      "Security, Gadget: 1 critical · +1 more",
      "Last T3 sync: 30/10/2026 07:30",
      `<a href="${URL_BASE}/">Open the board</a>`,
    ])
  })

  it("sends one line when nothing needs the owner", () => {
    const empty: MorningSummary = { waiting: [], newCount: 0, security: [], sync: fresh }
    expect(String(buildMorningMessage(empty, options))).toBe(
      `Nothing is waiting on you today. <a href="${URL_BASE}/">Open the board</a>`,
    )
  })

  it("keeps three lines when only new items changed", () => {
    const summary: MorningSummary = { waiting: [], newCount: 2, security: [], sync: fresh }
    expect(lines(buildMorningMessage(summary, options))).toEqual([
      "Nothing is waiting on you.",
      "New since your last visit: 2",
      `<a href="${URL_BASE}/">Open the board</a>`,
    ])
  })

  it("says when there was never a T3 sync, and marks security data of unknown age", () => {
    const summary: MorningSummary = {
      waiting: [],
      newCount: 0,
      security: [{ projectName: "Gizmo", critical: 0, high: 3, asOf: null, stale: true }],
      sync: { lastSuccessAt: null, stale: true },
    }
    expect(lines(buildMorningMessage(summary, options))).toEqual([
      "Nothing is waiting on you.",
      "New since your last visit: 0",
      "Security, Gizmo: 3 high (data age unknown)",
      "No T3 sync yet",
      `<a href="${URL_BASE}/">Open the board</a>`,
    ])
  })

  it("escapes hostile titles and names and strips control and bidirectional characters", () => {
    const summary: MorningSummary = {
      waiting: [
        { kind: "item", item: { id: "i-1", title: `\u202Eevil\u202C <a href="x">click</a> & "quotes"\nsecond line` } },
        { kind: "stage_proposal", proposal: { projectName: "<b>Bold</b>\u2066 &amp;" } },
      ],
      newCount: 0,
      security: [{ projectName: "</a><script>\u200F", critical: 1, high: 0, asOf: null, stale: false }],
      sync: fresh,
    }
    const text = String(buildMorningMessage(summary, options))
    expect(lines(text)[0]).toBe(
      `<b>Waiting on you: 2</b> · <a href="${URL_BASE}/items/i-1">evil &lt;a href=&quot;x&quot;&gt;click&lt;/a&gt; &amp; &quot;quotes&quot; second line</a> · &lt;b&gt;Bold&lt;/b&gt; &amp;amp;: stage proposal`,
    )
    expect(lines(text)[2]).toBe("Security, &lt;/a&gt;&lt;script&gt;: 1 critical")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for control characters
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/)
    // The only tags are the message's own.
    expect(text.replace(/<\/?b>|<a href="[^"<>]*">|<\/a>/g, "")).not.toMatch(/[<>]/)
  })

  it("shortens long titles and encodes the item id in its link", () => {
    const summary: MorningSummary = {
      waiting: [{ kind: "item", item: { id: "a/b?c", title: "x".repeat(200) } }],
      newCount: 0,
      security: [],
      sync: fresh,
    }
    const first = lines(buildMorningMessage(summary, options))[0] ?? ""
    expect(first).toContain(`${URL_BASE}/items/a%2Fb%3Fc`)
    expect(first).toContain(`${"x".repeat(59)}…</a>`)
  })

  it("keeps a path prefix of the public URL in every link", () => {
    const empty: MorningSummary = { waiting: [], newCount: 0, security: [], sync: fresh }
    expect(String(buildMorningMessage(empty, { ...options, publicUrl: "https://example.com/mikud" }))).toContain(
      '<a href="https://example.com/mikud/">',
    )
  })

  it("writes Hebrew from the Hebrew locale file", () => {
    const m = he.telegram.morning
    const text = String(buildMorningMessage(full, { ...options, language: "he" }))
    expect(lines(text)).toEqual([
      `<b>${m.waiting.replace("{count}", "3")}</b> · <a href="${URL_BASE}/items/i-1">Approve the &lt;beta&gt; release &amp; notes</a> · ${m.proposal.replace("{project}", "Gizmo")}`,
      m.new.replace("{count}", "4"),
      `${m.security.replace("{project}", "Widget").replace("{counts}", `${m.critical.replace("{count}", "2")}, ${m.high.replace("{count}", "1")}`)} (${m.dataFrom.replace("{time}", "30/10/2026 07:31")})`,
      `${m.security.replace("{project}", "Gadget").replace("{counts}", m.critical.replace("{count}", "1"))} · ${m.more.replace("{count}", "1")}`,
      m.syncStale.replace("{time}", "30/10/2026 07:30"),
      `<a href="${URL_BASE}/">${m.openBoard}</a>`,
    ])
    const empty: MorningSummary = { waiting: [], newCount: 0, security: [], sync: fresh }
    expect(String(buildMorningMessage(empty, { ...options, language: "he" }))).toBe(
      `${m.allClear} <a href="${URL_BASE}/">${m.openBoard}</a>`,
    )
  })

  it("formats times in Asia/Jerusalem by the owner's formats, summer time included", () => {
    const summary: MorningSummary = {
      waiting: [],
      newCount: 0,
      security: [],
      // 2026-07-04 21:05 UTC is 00:05 on 5 July in Asia/Jerusalem (summer time, UTC+3).
      sync: { lastSuccessAt: new Date("2026-07-04T21:05:00Z"), stale: true },
    }
    expect(lines(buildMorningMessage(summary, options))[2]).toBe("Last T3 sync: 05/07/2026 00:05")
    const twelve = buildMorningMessage(summary, { ...options, dateFormat: "yyyy-MM-dd", timeFormat: "h:mm a" })
    expect(lines(twelve)[2]).toMatch(/^Last T3 sync: 2026-07-05 12:05\sAM$/u)
    const browser = buildMorningMessage(summary, { ...options, dateFormat: "browser", timeFormat: "browser" })
    expect(lines(browser)[2]).toBe("Last T3 sync: 05/07/2026 00:05")
  })
})
