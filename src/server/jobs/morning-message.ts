import type { Language } from "../../shared/enums.ts"
import { UI_ROUTES, uiUrl } from "../../shared/routes.ts"
import type { GitHubStatus } from "../github/status.ts"
import { fill, html, link, oneLine, TelegramHtml } from "../telegram/html.ts"
import { telegramTexts } from "../telegram/texts.ts"
import { formatLocal } from "./time.ts"

/** The part of the morning read model the message uses (see `morning` in services/reads.ts). */
export type MorningSummary = {
  waiting: (
    | { kind: "item"; item: { id: string; title: string } }
    | { kind: "stage_proposal"; proposal: { projectName: string | null } }
  )[]
  newCount: number
  security: { projectName: string; critical: number; high: number; asOf: Date | null; stale: boolean }[]
  sync: { connected: boolean; lastSuccessAt: Date | null; stale: boolean }
  /** Whether the security data really comes from GitHub and is current (github/status.ts). */
  github: GitHubStatus
}

export type MessageOptions = {
  language: Language
  publicUrl: URL | string
  dateFormat: string
  timeFormat: string
}

const MAX_TITLES = 2
const MAX_SECURITY_LINES = 2
const MAX_LINES = 6
const SEPARATOR = " · "

/**
 * The morning message: 3 to 6 lines of Telegram HTML, or one line when nothing needs the owner.
 * 1. waiting on you: count and up to two titles, each linked to its item;
 * 2. new since the last visit: count;
 * 3. up to two security lines (critical, or high in production), with the data's age when stale;
 * 4. that the sync is disconnected and must be connected again, with the last T3 sync time; else that time only when
 *    the sync is stale;
 * 5. the GitHub status when it is not fine: not set up, not read yet, or how many projects lack current data;
 * 6. a link to the board.
 * At most six lines: the security lines give way first.
 * Every value is escaped and stripped of control and bidirectional characters. Pure: no clock, no I/O.
 */
export function buildMorningMessage(summary: MorningSummary, options: MessageOptions): TelegramHtml {
  const t = telegramTexts(options.language).morning
  const url = (path: string) => uiUrl(options.publicUrl, path)
  const time = (at: Date) => formatLocal(at, options.dateFormat, options.timeFormat, options.language)
  const board = link(url(UI_ROUTES.home), t.openBoard)

  const syncLine = !summary.sync.connected || summary.sync.stale
  const githubLine = summary.github.state !== "fine"
  if (
    summary.waiting.length === 0 &&
    summary.newCount === 0 &&
    summary.security.length === 0 &&
    !syncLine &&
    !githubLine
  )
    return html`${fill(t.allClear)} ${board}`

  const lines: TelegramHtml[] = []

  if (summary.waiting.length === 0) lines.push(fill(t.nothingWaiting))
  else {
    const titles = summary.waiting
      .slice(0, MAX_TITLES)
      .map((entry) =>
        entry.kind === "item"
          ? link(url(UI_ROUTES.item(entry.item.id)), oneLine(entry.item.title, 60))
          : fill(t.proposal, { project: oneLine(entry.proposal.projectName ?? "", 40) }),
      )
    lines.push(
      TelegramHtml.join([html`<b>${fill(t.waiting, { count: summary.waiting.length })}</b>`, ...titles], SEPARATOR),
    )
  }

  lines.push(fill(t.new, { count: summary.newCount }))

  // Waiting, new, the board, and the sync and GitHub lines when shown: what is left of six goes to security.
  const fixed = 3 + (syncLine ? 1 : 0) + (githubLine ? 1 : 0)
  const security = summary.security.slice(0, Math.max(0, Math.min(MAX_SECURITY_LINES, MAX_LINES - fixed)))
  security.forEach((line, index) => {
    const counts: TelegramHtml[] = []
    if (line.critical > 0) counts.push(fill(t.critical, { count: line.critical }))
    if (line.high > 0) counts.push(fill(t.high, { count: line.high }))
    let text = fill(t.security, { project: oneLine(line.projectName, 40), counts: TelegramHtml.join(counts, ", ") })
    if (line.stale) {
      const age = line.asOf ? fill(t.dataFrom, { time: time(line.asOf) }) : fill(t.dataUnknown)
      text = html`${text} (${age})`
    }
    const rest = summary.security.length - security.length
    if (index === security.length - 1 && rest > 0) text = html`${text}${SEPARATOR}${fill(t.more, { count: rest })}`
    lines.push(text)
  })

  if (!summary.sync.connected) {
    const last = summary.sync.lastSuccessAt
    const disconnected = fill(t.syncDisconnected)
    lines.push(last ? html`${disconnected} ${fill(t.syncStale, { time: time(last) })}` : disconnected)
  } else if (summary.sync.stale)
    lines.push(
      summary.sync.lastSuccessAt ? fill(t.syncStale, { time: time(summary.sync.lastSuccessAt) }) : fill(t.syncNever),
    )

  if (summary.github.state === "off") lines.push(fill(t.githubOff))
  else if (summary.github.state === "not_read") lines.push(fill(t.githubNotRead))
  else if (summary.github.state === "not_covered") {
    const count = fill(t.githubNotCovered, { count: summary.github.notCovered })
    const last = summary.github.oldestGoodReadAt
    lines.push(last ? html`${count} (${fill(t.githubLastRead, { time: time(last) })})` : count)
  }

  lines.push(board)
  return TelegramHtml.join(lines)
}
