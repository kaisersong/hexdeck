import type { BrokerParticipant } from '../../lib/broker/types';
import type { JumpTarget } from '../../lib/jump/types';
import { startWindowDragging } from '../../lib/platform/window-controls';
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
): MenuProjectGroup[] {
  const currentProjectKey = currentProject.trim() || 'Current Project';
  const nowByParticipant = new Map(now.map((item) => [item.participantId, item]));
  const groups = new Map<string, MenuProjectGroup>();

  const ensureGroup = (name: string) => {
    const normalized = name.trim() || currentProjectKey;
    let group = groups.get(normalized);
    if (!group) {
      group = { name: normalized, activeCount: 0, agents: [] };
      groups.set(normalized, group);
    }
    return group;
  };

  for (const participant of participants) {
    const groupName = participant.context?.projectName ?? currentProjectKey;
    const currentState = nowByParticipant.get(participant.participantId);
    const stateLabel = toStateLabel(currentState?.workState);
    const stateTone = toStateTone(currentState?.workState);
    const group = ensureGroup(groupName);

    group.agents.push({
      participantId: participant.participantId,
      alias: participant.alias,
      stateLabel,
      stateTone,
      jumpTarget: currentState?.jumpTarget,
    });

    if (stateTone !== 'idle') {
      group.activeCount += 1;
    }
  }

  for (const item of now) {
    if (participants.some((participant) => participant.participantId === item.participantId)) {
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

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      agents: group.agents.sort((left, right) => left.alias.localeCompare(right.alias)),
    }))
    .sort((left, right) => {
      if (left.name === currentProjectKey) {
        return -1;
      }

      if (right.name === currentProjectKey) {
        return 1;
      }

      if (right.activeCount !== left.activeCount) {
        return right.activeCount - left.activeCount;
      }

      return left.name.localeCompare(right.name);
    });
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

function DashboardIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M3 4.5A1.5 1.5 0 0 1 4.5 3h4A1.5 1.5 0 0 1 10 4.5v4A1.5 1.5 0 0 1 8.5 10h-4A1.5 1.5 0 0 1 3 8.5v-4Zm7 0A1.5 1.5 0 0 1 11.5 3h4A1.5 1.5 0 0 1 17 4.5v4A1.5 1.5 0 0 1 15.5 10h-4A1.5 1.5 0 0 1 10 8.5v-4Zm-7 7A1.5 1.5 0 0 1 4.5 10h4A1.5 1.5 0 0 1 10 11.5v4A1.5 1.5 0 0 1 8.5 17h-4A1.5 1.5 0 0 1 3 15.5v-4Zm7 0A1.5 1.5 0 0 1 11.5 10h4A1.5 1.5 0 0 1 17 11.5v4A1.5 1.5 0 0 1 15.5 17h-4A1.5 1.5 0 0 1 10 15.5v-4Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M5.25 10a.75.75 0 0 1 .75-.75h6.19L9.97 7.03a.75.75 0 1 1 1.06-1.06l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 1 1-1.06-1.06l2.22-2.22H6a.75.75 0 0 1-.75-.75Z"
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
  onOpenExpanded,
  onOpenSettings,
  onMinimize,
  onClose,
}: {
  snapshot: ProjectSnapshotProjection;
  participants: BrokerParticipant[];
  currentProject: string;
  brokerLive?: boolean;
  onJump?: (target: JumpTarget) => void;
  onOpenExpanded?: () => void;
  onOpenSettings?: () => void;
  onMinimize?: () => void;
  onClose?: () => void;
}) {
  const groups = buildProjectGroups(participants, currentProject, snapshot.now);
  const attentionBadge = renderAttentionBadge(snapshot.attention);

  return (
    <div className="menu-dropdown">
      <header
        className="menu-dropdown__header panel-header--draggable"
        onMouseDown={(event) => void startWindowDragging(event.target, event.currentTarget)}
      >
        <div className="menu-dropdown__brand">
          <span className="menu-dropdown__title">HEXDECK PRO</span>
        </div>
        <div className="menu-dropdown__header-actions">
          <span className={`menu-live-pill ${brokerLive ? 'menu-live-pill--live' : ''}`}>
            <span className="menu-live-pill__dot" />
            {brokerLive ? 'LIVE' : 'SETUP'}
          </span>
          <button type="button" className="menu-icon-btn" onClick={onOpenSettings} aria-label="Settings" title="Settings">
            <SettingsIcon />
          </button>
          <button type="button" className="menu-icon-btn" onClick={onMinimize} aria-label="Minimize" title="Minimize">
            -
          </button>
          <button
            type="button"
            className="menu-icon-btn menu-icon-btn--close"
            onClick={onClose}
            aria-label="Close panel"
            title="Close panel"
          >
            x
          </button>
        </div>
      </header>

      <div className="menu-dropdown__groups" aria-label="Project groups">
        {groups.length === 0 ? (
          <div className="menu-project-group">
            <div className="menu-project-group__header">
              <span className="menu-project-group__title">Project: {currentProject}</span>
              <span className="menu-project-group__meta">0 Active</span>
            </div>
            <p className="menu-empty-state">No agents available yet.</p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.name} className="menu-project-group">
              <div className="menu-project-group__header">
                <span className="menu-project-group__title">Project: {group.name}</span>
                <span className="menu-project-group__meta">
                  {group.activeCount > 0 ? `${group.activeCount} Active` : `${group.agents.length} Agents`}
                </span>
              </div>
              <ul className="menu-agent-list">
                {group.agents.map((agent) => (
                  <li key={agent.participantId}>
                    <button
                      type="button"
                      className={`menu-agent-row menu-agent-row--${agent.stateTone}`}
                      onClick={() => {
                        if (agent.jumpTarget) {
                          onJump?.(agent.jumpTarget);
                        }
                      }}
                      disabled={!agent.jumpTarget}
                      aria-label={agent.jumpTarget ? `Jump to @${agent.alias}` : undefined}
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
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {attentionBadge ? <div className="menu-attention-banner">{attentionBadge}</div> : null}

      <div className="menu-dropdown__actions">
        <button type="button" className="menu-primary-action" onClick={onOpenExpanded}>
          <span className="menu-primary-action__content">
            <span className="menu-primary-action__icon">
              <DashboardIcon />
            </span>
            <span className="menu-primary-action__label">Open Main Panel</span>
          </span>
          <span className="menu-primary-action__arrow">
            <ArrowRightIcon />
          </span>
        </button>
      </div>

      <footer className="menu-dropdown__footer" aria-label="Panel summary">
        <div className="menu-footer-metrics">
          <div className="menu-footer-metric">
            <span>Agents</span>
            <strong>{snapshot.overview.onlineCount} Total</strong>
          </div>
          <div className="menu-footer-divider" />
          <div className="menu-footer-metric">
            <span>Broker</span>
            <strong>{snapshot.overview.brokerHealthy ? 'Healthy' : 'Degraded'}</strong>
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
