// One tone table for every code (v3 FB-14): the word is the status, colour only reinforces it.
// Colour means status only: waiting on you is a warning, in progress is information, done is ok,
// critical is a failure. Stages, types and actors are not statuses, so their tags stay neutral.

import type { ActorKind, ItemStatus, ItemType, Severity, Stage } from "../../shared/enums.ts"
import { useI18n } from "../i18n/i18n.tsx"

export type Tone = "ok" | "warn" | "fail" | "info" | "neutral"

export const STATUS_TONE: Record<ItemStatus, Tone> = {
  future: "neutral",
  todo: "neutral",
  in_progress: "info",
  waiting_on_you: "warn",
  done: "ok",
  not_relevant: "neutral",
}

export const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: "fail",
  high: "warn",
  medium: "neutral",
  low: "neutral",
}

export function Tag({ tone, children, line = false }: { tone: Tone; children: string; line?: boolean }) {
  const cls = tone === "neutral" ? "ui-tag" : `ui-tag ui-tag-${tone}`
  return <span className={line ? `${cls} ui-tag-line` : cls}>{children}</span>
}

export function StatusTag({ status }: { status: ItemStatus }) {
  const { t } = useI18n()
  return <Tag tone={STATUS_TONE[status]}>{t(`itemStatus.${status}`)}</Tag>
}

export function StageTag({ stage }: { stage: Stage | null }) {
  const { t } = useI18n()
  return (
    <Tag tone="neutral" line>
      {stage ? t(`stage.${stage}`) : t("common.stageUnset")}
    </Tag>
  )
}

export function TypeTag({ type }: { type: ItemType }) {
  const { t } = useI18n()
  return (
    <Tag tone="neutral" line>
      {t(`itemType.${type}`)}
    </Tag>
  )
}

export function SeverityTag({ severity }: { severity: Severity }) {
  const { t } = useI18n()
  return <Tag tone={SEVERITY_TONE[severity]}>{t(`severity.${severity}`)}</Tag>
}

export function ActorTag({ kind, label }: { kind: ActorKind; label: string }) {
  const { t } = useI18n()
  return (
    <span className="ui-actor" title={t(`actor.${kind}`)}>
      <bdi dir="auto">{label}</bdi>
    </span>
  )
}

/** Goal progress: done out of total with a 6px meter; no data is a muted dash, not 0% (FB-8). */
export function Progress({ done, total }: { done: number; total: number }) {
  const { t } = useI18n()
  if (total === 0) return <span className="ui-muted">-</span>
  const share = Math.round((done / total) * 100)
  return (
    <span className="ui-progress" title={t("projects.progressTitle", { done, total })}>
      <span className="ui-meter" aria-hidden="true">
        <i style={{ inlineSize: `${share}%` }} />
      </span>
      <span className="ui-num">{t("projects.progress", { done, total })}</span>
    </span>
  )
}
