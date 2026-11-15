// Settings, Agent access. Which panel shows depends on whether this Adiutor has agent access by approval mounted
// (createApp's `agentOAuth`): the section reads GET /api/v1/agents/settings, and only a 404 `not_found` (an Adiutor
// without it, as production is until the agent access release) shows today's panel of agent keys
// (AgentKeysPanel.tsx). Any other failure shows the error with Try again, never the old panel.
//
// The new panel, in three groups: Agents (the on/off switch and the idle days, each saved at once outside the page's
// save bar, after a question when it ends connections: turning agents off, or fewer idle days); How to connect (the
// MCP address, the Claude Code command and the sentence for the agent skill, or the locked reason when the public URL
// does not allow agents); Connected agents (name, how it connected, areas, approved, last used and when it ends, with
// Disconnect, and Disconnect all at the end of the head, always there: it also ends waiting codes and open approvals).

import { useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useId, useState } from "react"
import { AGENT_IDLE_DAYS_MAX, AGENT_IDLE_DAYS_MIN } from "../../../shared/settings.ts"
import { ApiError } from "../../api/client.ts"
import { api, qk } from "../../api/endpoints.ts"
import type { AgentConnection, AgentSettings } from "../../api/types.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { Copyable } from "../../ui/Copyable.tsx"
import { confirmDialog } from "../../ui/confirm.tsx"
import { EVERY, usePageQuery } from "../../ui/refresh.ts"
import { Banner, Empty, ErrorState, errorReason, Loading, Locked } from "../../ui/states.tsx"
import { Time } from "../../ui/Time.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tag } from "../../ui/tags.tsx"
import { AgentKeysSection, skillSentence } from "./AgentKeysPanel.tsx"
import { Group, Row, SwitchRow } from "./parts.tsx"

/** The owner's agent settings, or null where agent access by approval is not mounted (the server answers 404). */
async function readAgentSettings(): Promise<AgentSettings | null> {
  try {
    return await api.agentSettings()
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === "not_found") return null
    throw error
  }
}

/** The command that adds Adiutor to Claude Code over MCP; Claude Code then opens Adiutor to approve it. */
export function claudeCommand(mcpUrl: string): string {
  return `claude mcp add --transport http adiutor ${mcpUrl}`
}

/** A whole number of idle days within the limits, or null. */
export function idleDaysOf(typed: string): number | null {
  const text = typed.trim()
  if (!/^\d{1,3}$/.test(text)) return null
  const value = Number(text)
  return value >= AGENT_IDLE_DAYS_MIN && value <= AGENT_IDLE_DAYS_MAX ? value : null
}

/** The Agent access section: the new panel where agent access is mounted, today's panel of agent keys otherwise. */
export function AgentsSection() {
  const { t } = useI18n()
  const query = usePageQuery({ queryKey: qk.agentSettings, queryFn: readAgentSettings, every: EVERY.slow })
  if (query.isPending) return <Loading label={t("agentAccess.loading")} />
  if (query.isError && query.data === undefined)
    return <ErrorState title={t("agentAccess.failed")} error={query.error} onRetry={() => void query.refetch()} />
  if (query.data === null || query.data === undefined)
    return (
      <>
        <p className="ui-set-tabdesc">{t("settings.sections.agents.hint")}</p>
        <AgentKeysSection />
      </>
    )
  return (
    <>
      <p className="ui-set-tabdesc">{t("agentAccess.hint")}</p>
      <AgentAccessSection settings={query.data} />
    </>
  )
}

function AgentAccessSection({ settings }: { settings: AgentSettings }) {
  return (
    <>
      <SettingsGroup settings={settings} />
      <ConnectGroup settings={settings} />
      <ConnectionsGroup />
    </>
  )
}

/** The switch and the idle days, each saved at once; a change that ends connections asks first. */
function SettingsGroup({ settings }: { settings: AgentSettings }) {
  const { t, tc, language } = useI18n()
  const queryClient = useQueryClient()
  const daysId = useId()
  const errorId = useId()
  const [busy, setBusy] = useState(false)
  // What the owner typed, until it is saved; the stored value shows otherwise, so a refresh never replaces typing.
  const [typed, setTyped] = useState<string | null>(null)
  const shown = typed ?? String(settings.idleDays)
  const days = idleDaysOf(shown)
  const invalid = typed !== null && days === null

  const save = async (patch: { enabled?: boolean; idleDays?: number }, done: string) => {
    setBusy(true)
    try {
      await api.updateAgentSettings(patch)
      showToast(done, "success")
      if (patch.idleDays !== undefined) setTyped(null)
    } catch (error) {
      showToast(t("agentAccess.saveFailed", { reason: errorReason(language, error) }), "error")
    } finally {
      setBusy(false)
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.agentSettings }),
      queryClient.invalidateQueries({ queryKey: qk.agentConnections }),
    ])
  }

  const flip = async (enabled: boolean) => {
    if (!enabled) {
      const ok = await confirmDialog({
        title: t("agentAccess.offTitle"),
        message: t("agentAccess.offMessage"),
        confirmText: t("agentAccess.offConfirm"),
        danger: true,
      })
      if (!ok) return
    }
    await save({ enabled }, t(enabled ? "agentAccess.turnedOn" : "agentAccess.turnedOff"))
  }

  const saveDays = async () => {
    if (days === null || days === settings.idleDays) return
    if (days < settings.idleDays) {
      const ok = await confirmDialog({
        title: t("agentAccess.idleFewerTitle"),
        message: tc("agentAccess.idleFewerMessage", days),
        confirmText: t("agentAccess.idleFewerConfirm"),
        danger: true,
      })
      if (!ok) return
    }
    await save({ idleDays: days }, tc("agentAccess.idleSaved", days))
  }

  return (
    <Group id="settings-agents" title={t("agentAccess.settingsTitle")}>
      <SwitchRow
        label={t("agentAccess.switch")}
        hint={t("agentAccess.switchHint")}
        checked={settings.enabled}
        disabled={busy}
        onChange={(next) => void flip(next)}
      />
      <Row label={t("agentAccess.idleDays")} hint={t("agentAccess.idleHint")} htmlFor={daysId}>
        <form
          className="ui-set-pair"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void saveDays()
          }}
        >
          <input
            id={daysId}
            className="ui-input"
            type="number"
            inputMode="numeric"
            min={AGENT_IDLE_DAYS_MIN}
            max={AGENT_IDLE_DAYS_MAX}
            value={shown}
            disabled={busy}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(event) => setTyped(event.target.value)}
          />
          <button type="submit" className="ui-btn" disabled={busy || days === null || days === settings.idleDays}>
            {t("agentAccess.idleSave")}
          </button>
        </form>
        {invalid ? (
          <p id={errorId} className="ui-field-error" role="alert">
            {t("agentAccess.idleInvalid")}
          </p>
        ) : null}
      </Row>
    </Group>
  )
}

/** How to connect: the MCP address, the Claude Code command and the skill sentence, or why agents cannot connect. */
function ConnectGroup({ settings }: { settings: AgentSettings }) {
  const { t } = useI18n()
  const command = (value: string) => (
    <span className="ui-set-command" dir="ltr">
      <Copyable value={value} />
    </span>
  )
  let body: ReactNode
  if (settings.issuerProblem || !settings.mcpUrl || !settings.issuer)
    body = (
      <Locked title={t("agentAccess.issuerTitle")}>
        {t(`agentAccess.issuer.${settings.issuerProblem ?? "invalid"}`)} {t("agentAccess.issuerWhere")}
      </Locked>
    )
  else
    body = (
      <>
        {settings.enabled ? null : <Banner tone="warn" title={t("agentAccess.offNote")} />}
        <Row label={t("agentAccess.mcpUrl")} hint={t("agentAccess.mcpHint")}>
          {command(settings.mcpUrl)}
        </Row>
        <Row label={t("agentAccess.claude")} hint={t("agentAccess.claudeHint")}>
          {command(claudeCommand(settings.mcpUrl))}
        </Row>
        <Row label={t("agentAccess.skill")} hint={t("agentAccess.skillHint")}>
          {command(skillSentence(settings.issuer))}
        </Row>
      </>
    )
  return (
    <Group id="settings-connect" title={t("agentAccess.connectTitle")} intro={t("agentAccess.connectIntro")}>
      {body}
    </Group>
  )
}

/** The live connections, newest first, with Disconnect each and Disconnect all. */
function ConnectionsGroup() {
  const { t, tc, language } = useI18n()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const query = usePageQuery({ queryKey: qk.agentConnections, queryFn: api.agentConnections, every: EVERY.live })
  const connections = query.data ?? []
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.agentConnections })

  const disconnect = async (connection: AgentConnection) => {
    const name = connection.name
    const ok = await confirmDialog({
      title: t("agentAccess.disconnectTitle", { name }),
      message: t("agentAccess.disconnectMessage"),
      confirmText: t("agentAccess.disconnect"),
      danger: true,
    })
    if (!ok) return
    try {
      await api.disconnectAgent(connection.id)
      showToast(t("agentAccess.disconnected", { name }), "success")
    } catch (error) {
      showToast(t("agentAccess.disconnectFailed", { name, reason: errorReason(language, error) }), "error")
    }
    await refresh()
  }

  const disconnectAll = async () => {
    const count = connections.length
    const ok = await confirmDialog({
      title: t("agentAccess.disconnectAllTitle"),
      message: count === 0 ? t("agentAccess.disconnectAllNone") : tc("agentAccess.disconnectAllMessage", count),
      confirmText: t("agentAccess.disconnectAll"),
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      const { ended } = await api.disconnectAllAgents()
      showToast(
        ended === 0 ? t("agentAccess.disconnectedAllNone") : tc("agentAccess.disconnectedAll", ended),
        "success",
      )
    } catch (error) {
      showToast(t("agentAccess.disconnectAllFailed", { reason: errorReason(language, error) }), "error")
    } finally {
      setBusy(false)
    }
    await refresh()
  }

  return (
    <Group
      id="settings-agent-connections"
      title={t("agentAccess.listTitle")}
      count={query.data ? connections.length : undefined}
      extra={
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-danger"
          disabled={busy}
          onClick={() => void disconnectAll()}
        >
          {t("agentAccess.disconnectAll")}
        </button>
      }
    >
      {query.isPending ? <Loading label={t("agentAccess.loading")} /> : null}
      {query.isError && !query.data ? (
        <ErrorState title={t("agentAccess.failed")} error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.data && connections.length === 0 ? (
        <Empty title={t("agentAccess.empty")} hint={t("agentAccess.emptyHint")} />
      ) : null}
      {connections.map((connection) => (
        <div key={connection.id} className="ui-item" data-testid="agent-connection">
          <div className="ui-item-main">
            <span className="ui-item-title">
              <bdi dir="auto">{connection.name}</bdi> <Tag tone="neutral">{t(`agentAccess.via.${connection.via}`)}</Tag>{" "}
              <Tag tone="neutral">{t(`agentAccess.resource.${connection.resource}`)}</Tag>
            </span>
            <span className="ui-item-meta">
              {connection.areas.map((area) => t(`consent.areas.${area}.name`)).join(t("common.listSeparator"))} ·{" "}
              {t("agentAccess.approved")} <Time value={connection.approvedAt} mode="full" /> ·{" "}
              {t("agentAccess.lastUsed")}{" "}
              {connection.lastUsedAt ? <Time value={connection.lastUsedAt} mode="ago" /> : t("agentAccess.never")} ·{" "}
              {t("agentAccess.ends")} <Time value={connection.endsAt} mode="full" />
            </span>
          </div>
          <div className="ui-item-end">
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-btn-danger"
              onClick={() => void disconnect(connection)}
            >
              {t("agentAccess.disconnect")}
            </button>
          </div>
        </div>
      ))}
    </Group>
  )
}
