// A time on screen: a <time datetime> written by the format helpers, with the exact time in its
// tooltip (v3 FW-1, FW-9). The mode decides how much of it the place shows.

import { agoParts, formatClock, formatDay, formatListTime, formatTime, toDate } from "../format/datetime.ts"
import { useI18n } from "../i18n/i18n.tsx"

type Mode = "list" | "full" | "day" | "clock" | "ago"

export function useAgo(): (value: string | null) => string {
  const { t, tc } = useI18n()
  return (value) => {
    const ago = agoParts(value)
    if (!ago) return "-"
    if (ago.unit === "now") return t("time.justNow")
    return tc(`time.ago.${ago.unit}`, ago.count)
  }
}

export function Time({ value, mode = "list" }: { value: string | null; mode?: Mode }) {
  const ago = useAgo()
  const date = toDate(value)
  if (!date || !value) return <span className="ui-muted">-</span>
  const text =
    mode === "list"
      ? formatListTime(date)
      : mode === "full"
        ? formatTime(date, { seconds: false })
        : mode === "day"
          ? formatDay(date)
          : mode === "clock"
            ? formatClock(date)
            : ago(value)
  return (
    // Numbers keep their order inside a right-to-left sentence; "3 h ago" is a sentence of its own.
    <time
      className="ui-time"
      dir={mode === "ago" ? undefined : "ltr"}
      dateTime={date.toISOString()}
      title={formatTime(date)}
    >
      {text}
    </time>
  )
}
