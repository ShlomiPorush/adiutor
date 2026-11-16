// Settings, Agent access: the section reads GET /api/v1/agents/settings. A failure shows the error with Try again; a
// refresh that fails keeps what is shown and says so, with Try again.
//
// Its groups: Agents (the on/off switch and the idle days, part of the page's one draft and its save bar, SV-1; the
// save asks first when it ends connections: agents turned off, or fewer idle days); How to connect (the agent-access
// standard's two ways, distribution-and-versioning.md: the MCP address with the Claude Code command, and the sentence
// that installs the agent skill from /agents/skill/; or the locked reason when the public URL does not allow agents);
// the sync bundle's commands on the computer that runs the sync (connect, and setup-mcp for Claude Code and Codex);
// Connected agents (name, how it connected, areas, approved, last used and when it ends, with Disconnect, and
// Disconnect all at the end of the head, always there: it also ends waiting codes and open approvals); and, while any
// is left, the old agent keys (AgentKeysPanel.tsx). The commands and the sentence are written for agents and
// terminals, so they are English, outside the locales; every address in them is quoted.

import { useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useState } from "react"
import { AGENT_IDLE_DAYS_MAX, AGENT_IDLE_DAYS_MIN } from "../../../shared/settings.ts"
import { api, qk } from "../../api/endpoints.ts"
import type { AgentConnection, AgentSettings } from "../../api/types.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { Copyable } from "../../ui/Copyable.tsx"
import { type ConfirmOptions, confirmDialog } from "../../ui/confirm.tsx"
import { EVERY, usePageQuery } from "../../ui/refresh.ts"
import { Banner, Empty, ErrorState, errorReason, Loading, Locked } from "../../ui/states.tsx"
import { Time } from "../../ui/Time.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tag } from "../../ui/tags.tsx"
import { OldAgentKeys } from "./AgentKeysPanel.tsx"
import { Group, Row, SwitchRow } from "./parts.tsx"

/** The agent settings as Settings reads them: the page's draft and this section share the one read. */
export function useAgentSettings() {
  return usePageQuery({ queryKey: qk.agentSettings, queryFn: api.agentSettings, every: EVERY.slow })
}

/** The command that adds Adiutor to Claude Code over MCP; Claude Code then opens Adiutor to approve it. */
export function claudeCommand(mcpUrl: string): string {
  return `claude mcp add --transport http adiutor "${mcpUrl}"`
}

/** What the owner tells a coding agent that runs commands: install the skill from Adiutor, then connect. */
export function skillSentence(issuer: string): string {
  return `Install the adiutor skill into your personal skills folder as described at ${issuer}/agents/skill/, then connect to Adiutor.`
}

/** The sync bundle, run in the Adiutor folder on the computer that runs the sync. */
const BUNDLE = "node dist/sync/adiutor-sync.js"

/** The sync's own connection (the sync area), approved in this browser. */
export function syncConnectCommand(issuer: string): string {
  return `${BUNDLE} connect --name "sync" --url "${issuer}"`
}

/** Sets Claude Code or Codex up for Adiutor's MCP with OAuth, replacing a setup that used an agent key. */
export function setupMcpCommand(issuer: string, client: "claude" | "codex"): string {
  return `${BUNDLE} setup-mcp --for ${client} --url "${issuer}"`
}

/** A whole number of idle days within the limits, or null. */
export function idleDaysOf(typed: string): number | null {
  const text = typed.trim()
  if (!/^\d{1,3}$/.test(text)) return null
  const value = Number(text)
  return value >= AGENT_IDLE_DAYS_MIN && value <= AGENT_IDLE_DAYS_MAX ? value : null
}

/** The agent fields of the Settings draft, as typed. */
export type AgentDraft = { agentsEnabled?: boolean; agentIdleDays?: string }

/** What a save of the agent fields sends: only what differs from the stored settings (SV-2). */
export function agentChanges(
  saved: AgentSettings | undefined,
  draft: AgentDraft,
): { enabled?: boolean; idleDays?: number } {
  if (!saved) return {}
  const patch: { enabled?: boolean; idleDays?: number } = {}
  if (draft.agentsEnabled !== undefined && draft.agentsEnabled !== saved.enabled) patch.enabled = draft.agentsEnabled
  if (draft.agentIdleDays !== undefined) {
    const text = draft.agentIdleDays.trim()
    const value = text === "" ? Number.NaN : Number(text)
    if (value !== saved.idleDays) patch.idleDays = value
  }
  return patch
}

/** The question a save asks first when it ends connections: agents turned off, or fewer idle days. */
export function endingQuestion(
  saved: AgentSettings,
  patch: { enabled?: boolean; idleDays?: number },
  t: (key: string) => string,
  tc: (key: string, count: number) => string,
): ConfirmOptions | null {
  if (patch.enabled === false)
    return {
      title: t("agentAccess.offTitle"),
      message: t("agentAccess.offMessage"),
      confirmText: t("agentAccess.offConfirm"),
      danger: true,
    }
  const on = patch.enabled ?? saved.enabled
  if (on && patch.idleDays !== undefined && patch.idleDays < saved.idleDays)
    return {
      title: t("agentAccess.idleFewerTitle"),
      message: tc("agentAccess.idleFewerMessage", patch.idleDays),
      confirmText: t("agentAccess.idleFewerConfirm"),
      danger: true,
    }
  return null
}

/** The parts of the Settings draft this section edits (SettingsPage's form). */
export type AgentForm = {
  draft: AgentDraft
  set(change: AgentDraft): void
  ids: { agentsEnabled: string; agentIdleDays: string }
  fieldError(field: "agentIdleDays"): ReactNode
  invalid(field: "agentIdleDays"): Record<string, unknown>
}

/** A refresh that failed: what is shown stays, and the notice offers Try again. */
function RefreshFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n()
  return (
    <Banner
      tone="warn"
      title={t("agentAccess.refreshFailed")}
      action={
        <button type="button" className="ui-btn ui-btn-sm" onClick={onRetry}>
          {t("common.tryAgain")}
        </button>
      }
    />
  )
}

/** The Agent access section. */
export function AgentsSection({ form }: { form: AgentForm }) {
  const { t } = useI18n()
  const query = useAgentSettings()
  const retry = () => void query.refetch()
  if (query.isPending) return <Loading label={t("agentAccess.loading")} />
  if (!query.data) return <ErrorState title={t("agentAccess.failed")} error={query.error} onRetry={retry} />
  return (
    <>
      <p className="ui-set-tabdesc">{t("agentAccess.hint")}</p>
      {query.isError ? <RefreshFailed onRetry={retry} /> : null}
      <SettingsGroup settings={query.data} form={form} />
      <ConnectGroup settings={query.data} />
      <ConnectionsGroup />
      <OldAgentKeys />
    </>
  )
}

/** A command or sentence to copy, left to right in every language. */
function Command({ value }: { value: string }) {
  return (
    <span className="ui-set-command" dir="ltr">
      <Copyable value={value} />
    </span>
  )
}

/** The switch and the idle days: fields of the page's one draft, saved with the save bar. */
function SettingsGroup({ settings, form }: { settings: AgentSettings; form: AgentForm }) {
  const { t } = useI18n()
  const { draft, set, ids, fieldError, invalid } = form
  return (
    <Group id="settings-agents" title={t("agentAccess.settingsTitle")}>
      <SwitchRow
        id={ids.agentsEnabled}
        label={t("agentAccess.switch")}
        hint={t("agentAccess.switchHint")}
        checked={draft.agentsEnabled ?? settings.enabled}
        onChange={(next) => set({ agentsEnabled: next })}
      />
      <Row label={t("agentAccess.idleDays")} hint={t("agentAccess.idleHint")} htmlFor={ids.agentIdleDays}>
        <input
          id={ids.agentIdleDays}
          className="ui-input"
          type="number"
          inputMode="numeric"
          min={AGENT_IDLE_DAYS_MIN}
          max={AGENT_IDLE_DAYS_MAX}
          value={draft.agentIdleDays ?? String(settings.idleDays)}
          {...invalid("agentIdleDays")}
          onChange={(event) => set({ agentIdleDays: event.target.value })}
        />
        {fieldError("agentIdleDays")}
      </Row>
    </Group>
  )
}

/**
 * How to connect: the MCP address with the Claude Code command, the skill sentence, and the sync bundle's commands; or
 * why agents cannot connect.
 */
function ConnectGroup({ settings }: { settings: AgentSettings }) {
  const { t } = useI18n()
  if (settings.issuerProblem || !settings.mcpUrl || !settings.issuer)
    return (
      <Group id="settings-connect" title={t("agentAccess.connectTitle")} intro={t("agentAccess.connectIntro")}>
        <Locked title={t("agentAccess.issuerTitle")}>
          {t(`agentAccess.issuer.${settings.issuerProblem ?? "invalid"}`)} {t("agentAccess.issuerWhere")}
        </Locked>
      </Group>
    )
  const issuer = settings.issuer
  return (
    <>
      <Group id="settings-connect" title={t("agentAccess.connectTitle")} intro={t("agentAccess.connectIntro")}>
        {settings.enabled ? null : <Banner tone="warn" title={t("agentAccess.offNote")} />}
        <Row label={t("agentAccess.mcpUrl")} hint={t("agentAccess.mcpHint")}>
          <Command value={settings.mcpUrl} />
        </Row>
        <Row label={t("agentAccess.claude")} hint={t("agentAccess.claudeHint")}>
          <Command value={claudeCommand(settings.mcpUrl)} />
        </Row>
        <Row label={t("agentAccess.skill")} hint={t("agentAccess.skillHint")}>
          <Command value={skillSentence(issuer)} />
        </Row>
      </Group>
      <Group id="settings-connect-sync" title={t("agentAccess.syncTitle")} intro={t("agentAccess.syncIntro")}>
        <Row label={t("agentAccess.syncConnect")} hint={t("agentAccess.syncConnectHint", { replace: "--replace" })}>
          <Command value={syncConnectCommand(issuer)} />
        </Row>
        <Row label={t("agentAccess.setupClaude")} hint={t("agentAccess.setupHint")}>
          <Command value={setupMcpCommand(issuer, "claude")} />
        </Row>
        <Row label={t("agentAccess.setupCodex")} hint={t("agentAccess.setupHint")}>
          <Command value={setupMcpCommand(issuer, "codex")} />
        </Row>
      </Group>
    </>
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
      {query.isError && query.data ? <RefreshFailed onRetry={() => void query.refetch()} /> : null}
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
