import { useEffect, useRef, useState } from 'react';
import { dedupeActivelyPresentParticipants, isParticipantActivelyPresent } from '../../lib/broker/liveness';
import type { BrokerParticipant } from '../../lib/broker/types';
import { buildJumpTarget } from '../../lib/jump/targets';
import type { JumpTarget } from '../../lib/jump/types';
import { startWindowDragging } from '../../lib/platform/window-controls';
import { ALL_AGENTS_PROJECT } from '../../lib/settings/local-settings';
import type {
  AgentCardProjection,
  AttentionItemProjection,
  ProjectSnapshotProjection,
} from '../../lib/projections/types';

type MenuAgentItem = {
  participantId: string;
  alias: string;
  stateLabel: string;
  stateTone: 'working' | 'blocked' | 'idle';
  jumpTarget?: JumpTarget | null;
};

type MenuProjectGroup = {
  name: string;
  activeCount: number;
  agents: MenuAgentItem[];
};

type MenuGroups = {
  onlineGroups: MenuProjectGroup[];
  offlineAgents: MenuAgentItem[];
};

function toStateTone(workState?: string): MenuAgentItem['stateTone'] {
  if (workState === 'blocked') {
    return 'blocked';
  }

  if (workState === 'implementing' || workState === 'working') {
    return 'working';
  }

  return 'idle';
}

function toStateLabel(workState?: string): string {
  if (workState === 'implementing') {
    return 'working';
  }

  return workState ?? 'idle';
}

function buildProjectGroups(
  participants: BrokerParticipant[],
  currentProject: string,
  now: AgentCardProjection[]
): MenuGroups {
  const activeWorkStateParticipantIds = new Set(now.map((item) => item.participantId));
  const dedupedParticipants = dedupeActivelyPresentParticipants(participants, activeWorkStateParticipantIds);
  const agentParticipants = dedupedParticipants.filter(
    (participant) => participant.kind !== 'human' && participant.kind !== 'adapter'
  );
  const normalizedCurrentProject = currentProject.trim();
  const currentProjectKey =
    normalizedCurrentProject && normalizedCurrentProject !== ALL_AGENTS_PROJECT
      ? normalizedCurrentProject
      : 'Current Project';
  const pinnedProjectName = normalizedCurrentProject && normalizedCurrentProject !== ALL_AGENTS_PROJECT
    ? normalizedCurrentProject
    : null;
  const nowByParticipant = new Map(now.map((item) => [item.participantId, item]));
  const groups = new Map<string, MenuProjectGroup>();
  const offlineAgents: MenuAgentItem[] = [];

  const ensureGroup = (name: string) => {
    const normalized = name.trim() || currentProjectKey;
    let group = groups.get(normalized);
    if (!group) {
      group = { name: normalized, activeCount: 0, agents: [] };
      groups.set(normalized, group);
    }
    return group;
  };

  const deriveParticipantJumpTarget = (participant: BrokerParticipant): JumpTarget | null => {
    const metadata = (participant as { metadata?: Record<string, unknown> }).metadata;
    return buildJumpTarget({
      participantId: participant.participantId,
      alias: participant.alias,
      toolLabel: participant.tool ?? 'agent',
      terminalApp: typeof metadata?.terminalApp === 'string' ? metadata.terminalApp : 'unknown',
      sessionHint: typeof metadata?.sessionHint === 'string' ? metadata.sessionHint : null,
      terminalTTY: typeof metadata?.terminalTTY === 'string'
        ? metadata.terminalTTY
        : typeof metadata?.sessionHint === 'string' && metadata?.terminalApp === 'Terminal.app'
          ? metadata.sessionHint
          : null,
      terminalSessionID: typeof metadata?.terminalSessionID === 'string'
        ? metadata.terminalSessionID
        : null,
      projectPath: typeof metadata?.projectPath === 'string' ? metadata.projectPath : null,
    });
  };

  for (const participant of agentParticipants) {
    const groupName = participant.context?.projectName ?? currentProjectKey;
    const currentState = nowByParticipant.get(participant.participantId);
    const isOnline = isParticipantActivelyPresent(participant, activeWorkStateParticipantIds);
    const stateLabel = toStateLabel(currentState?.workState);
    const stateTone = toStateTone(currentState?.workState);
    const currentJumpTarget = currentState?.jumpTarget
      ? {
          ...currentState.jumpTarget,
          alias: currentState.jumpTarget.alias || participant.alias,
        }
      : null;
    const agent: MenuAgentItem = {
      participantId: participant.participantId,
      alias: participant.alias,
      stateLabel: isOnline ? stateLabel : 'offline',
      stateTone: isOnline ? stateTone : 'idle',
      jumpTarget:
        currentJumpTarget && currentJumpTarget.precision !== 'unsupported'
          ? currentJumpTarget
          : deriveParticipantJumpTarget(participant),
    };

    if (!isOnline) {
      offlineAgents.push(agent);
      continue;
    }

    const group = ensureGroup(groupName);
    group.agents.push(agent);

    if (stateTone !== 'idle') {
      group.activeCount += 1;
    }
  }

  for (const item of now) {
    if (agentParticipants.some((participant) => participant.participantId === item.participantId)) {
      continue;
    }

    const group = ensureGroup(currentProjectKey);
    group.agents.push({
      participantId: item.participantId,
      alias: item.alias,
      stateLabel: toStateLabel(item.workState),
      stateTone: toStateTone(item.workState),
      jumpTarget: item.jumpTarget,
    });

    if (toStateTone(item.workState) !== 'idle') {
      group.activeCount += 1;
    }
  }

  return {
    onlineGroups: Array.from(groups.values())
      .map((group) => ({
        ...group,
        agents: group.agents.sort((left, right) => left.alias.localeCompare(right.alias)),
      }))
      .sort((left, right) => {
        if (pinnedProjectName && left.name === pinnedProjectName) {
          return -1;
        }

        if (pinnedProjectName && right.name === pinnedProjectName) {
          return 1;
        }

        if (right.activeCount !== left.activeCount) {
          return right.activeCount - left.activeCount;
        }

        return left.name.localeCompare(right.name);
      }),
    offlineAgents: offlineAgents.sort((left, right) => left.alias.localeCompare(right.alias)),
  };
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d={expanded ? 'M5.47 12.03a.75.75 0 0 0 1.06 0L10 8.56l3.47 3.47a.75.75 0 0 0 1.06-1.06l-4-4a.75.75 0 0 0-1.06 0l-4 4a.75.75 0 0 0 0 1.06Z' : 'M7.97 5.47a.75.75 0 0 0 0 1.06L11.44 10l-3.47 3.47a.75.75 0 1 0 1.06 1.06l4-4a.75.75 0 0 0 0-1.06l-4-4a.75.75 0 0 0-1.06 0Z'}
        fill="currentColor"
      />
    </svg>
  );
}

function renderAttentionBadge(items: AttentionItemProjection[]): string | null {
  if (items.length === 0) {
    return null;
  }

  const blockedCount = items.filter((item) => item.kind === 'blocked').length;
  const approvalCount = items.filter((item) => item.kind === 'approval').length;

  if (approvalCount > 0) {
    return `${approvalCount} approvals pending`;
  }

  if (blockedCount > 0) {
    return `${blockedCount} blocked`;
  }

  return `${items.length} attention items`;
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M11.15 2.19a1 1 0 0 0-2.3 0l-.2 1.16a6.9 6.9 0 0 0-1.38.57l-.98-.66a1 1 0 0 0-1.27.12L3.8 4.6a1 1 0 0 0-.12 1.27l.66.98c-.25.44-.45.9-.57 1.38l-1.16.2a1 1 0 0 0 0 2.3l1.16.2c.12.48.32.94.57 1.38l-.66.98a1 1 0 0 0 .12 1.27l1.22 1.22a1 1 0 0 0 1.27.12l.98-.66c.44.25.9.45 1.38.57l.2 1.16a1 1 0 0 0 2.3 0l.2-1.16c.48-.12.94-.32 1.38-.57l.98.66a1 1 0 0 0 1.27-.12l1.22-1.22a1 1 0 0 0 .12-1.27l-.66-.98c.25-.44.45-.9.57-1.38l1.16-.2a1 1 0 0 0 0-2.3l-1.16-.2a6.9 6.9 0 0 0-.57-1.38l.66-.98a1 1 0 0 0-.12-1.27L14.98 3.5a1 1 0 0 0-1.27-.12l-.98.66a6.9 6.9 0 0 0-1.38-.57l-.2-1.16ZM10 12.75A2.75 2.75 0 1 1 10 7.25a2.75 2.75 0 0 1 0 5.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M4 4.75A1.75 1.75 0 0 1 5.75 3h8.5A1.75 1.75 0 0 1 16 4.75v10.5A1.75 1.75 0 0 1 14.25 17h-8.5A1.75 1.75 0 0 1 4 15.25V4.75Zm2.22 2.22a.75.75 0 0 0-1.06 1.06L6.88 9.75 5.16 11.47a.75.75 0 1 0 1.06 1.06l2.25-2.25a.75.75 0 0 0 0-1.06L6.22 6.97Zm4.03 5.78a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function PanelRoute({
  snapshot,
  participants,
  currentProject,
  brokerLive,
  onJump,
  onOpenSettings,
  onMinimize,
  onClose,
}: {
  snapshot: ProjectSnapshotProjection;
  participants: BrokerParticipant[];
  currentProject: string;
  brokerLive?: boolean;
  onJump?: (target: JumpTarget) => void;
  onOpenSettings?: () => void;
  onMinimize?: () => void;
  onClose?: () => void;
}) {
  const [offlineExpanded, setOfflineExpanded] = useState(false);
  const firstOfflineRowRef = useRef<HTMLButtonElement | null>(null);
  const { onlineGroups, offlineAgents } = buildProjectGroups(participants, currentProject, snapshot.now);
  const attentionBadge = renderAttentionBadge(snapshot.attention);
  const brokerStatusLive = brokerLive ?? snapshot.overview.brokerHealthy;
  const brokerChipLabel = brokerStatusLive ? 'Live' : 'Degraded';
  const brokerFooterLabel = brokerStatusLive ? 'Healthy' : 'Degraded';
  const currentProjectLabel = currentProject.trim() || 'Current Project';

  useEffect(() => {
    if (!offlineExpanded) {
      return;
    }

    if (typeof firstOfflineRowRef.current?.scrollIntoView === 'function') {
      firstOfflineRowRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [offlineExpanded]);

  return (
    <div className="menu-dropdown">
      <div className="menu-dropdown__chrome" aria-hidden="true" />
      <header
        className="menu-dropdown__header panel-header--draggable"
        onMouseDown={(event) => void startWindowDragging(event.target, event.currentTarget)}
      >
        <div className="menu-dropdown__brand">
          <span className="menu-dropdown__title">HEXDECK PRO</span>
        </div>
        <div className="menu-dropdown__header-actions">
          <span className={`menu-live-chip menu-live-chip--${brokerStatusLive ? 'live' : 'degraded'}`}>
            <span className="menu-live-chip__dot" aria-hidden="true" />
            <span>{brokerChipLabel}</span>
          </span>
          <button type="button" className="menu-icon-btn" onClick={onOpenSettings} aria-label="Settings" title="Settings">
            <SettingsIcon />
          </button>
        </div>
      </header>

      <div className="menu-dropdown__body">
        <div className="menu-dropdown__groups" aria-label="Project groups">
          {onlineGroups.length === 0 ? (
            <section className="menu-project-group menu-project-group--empty">
              <div className="menu-project-group__header">
                <span className="menu-project-group__title">Project: {currentProjectLabel}</span>
                <span className="menu-project-group__meta">0 Active</span>
              </div>
              <p className="menu-empty-state">No agents available yet.</p>
            </section>
          ) : (
            onlineGroups.map((group) => (
              <section key={group.name} className="menu-project-group">
                <div className="menu-project-group__header">
                  <span className="menu-project-group__title">Project: {group.name}</span>
                  <span className="menu-project-group__meta">
                    {group.activeCount > 0 ? `${group.activeCount} Active` : `${group.agents.length} Agents`}
                  </span>
                </div>
                <ul className="menu-agent-list">
                  {group.agents.map((agent) => {
                    const canJump = Boolean(agent.jumpTarget && agent.jumpTarget.precision !== 'unsupported');

                    return (
                      <li key={agent.participantId}>
                        <button
                          type="button"
                          className={`menu-agent-row menu-agent-row--${agent.stateTone}`}
                          onClick={() => {
                            if (agent.jumpTarget) {
                              onJump?.(agent.jumpTarget);
                            }
                          }}
                          disabled={!canJump}
                          aria-label={canJump ? `Jump to @${agent.alias}` : `${agent.alias} unavailable`}
                        >
                          <span className="menu-agent-row__identity">
                            <span className={`menu-agent-dot menu-agent-dot--${agent.stateTone}`} />
                            <span className="menu-agent-name">{agent.alias}</span>
                          </span>
                          <span className={`menu-agent-pill menu-agent-pill--${agent.stateTone}`}>
                            {agent.stateLabel}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}

          {offlineAgents.length > 0 ? (
            <section className="menu-project-group menu-project-group--offline">
              <button
                type="button"
                className="menu-project-group__toggle"
                onClick={() => setOfflineExpanded((expanded) => !expanded)}
                aria-expanded={offlineExpanded}
                aria-label={offlineExpanded ? 'Hide offline agents' : 'Show offline agents'}
              >
                <span className="menu-project-group__header">
                  <span className="menu-project-group__title">Offline</span>
                  <span className="menu-project-group__meta">{offlineAgents.length} Agents</span>
                </span>
                <span className="menu-project-group__toggle-icon">
                  <ChevronIcon expanded={offlineExpanded} />
                </span>
              </button>

              {offlineExpanded ? (
                <ul className="menu-agent-list">
                  {offlineAgents.map((agent, index) => (
                    <li key={agent.participantId}>
                      <button
                        ref={index === 0 ? firstOfflineRowRef : undefined}
                        type="button"
                        className="menu-agent-row menu-agent-row--idle"
                        disabled
                        aria-label={`${agent.alias} unavailable`}
                        data-scroll-target={`offline-agent-${agent.participantId}`}
                      >
                        <span className="menu-agent-row__identity">
                          <span className="menu-agent-dot menu-agent-dot--idle" />
                          <span className="menu-agent-name">{agent.alias}</span>
                        </span>
                        <span className="menu-agent-pill menu-agent-pill--idle">{agent.stateLabel}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>

        {attentionBadge ? <div className="menu-attention-banner">{attentionBadge}</div> : null}
      </div>

      <footer className="menu-dropdown__footer" aria-label="Panel summary">
        <div className="menu-footer-metrics">
        <div className="menu-footer-metric">
          <span>Agents</span>
          <strong>{snapshot.overview.onlineCount} Online</strong>
        </div>
          <div className="menu-footer-divider" />
          <div className="menu-footer-metric">
            <span>Broker</span>
            <strong>{brokerFooterLabel}</strong>
          </div>
        </div>
        <button type="button" className="menu-footer-link" onClick={onOpenSettings}>
          <span className="menu-footer-link__icon">
            <TerminalIcon />
          </span>
          Logs
        </button>
      </footer>
    </div>
  );
}
