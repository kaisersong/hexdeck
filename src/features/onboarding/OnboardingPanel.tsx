import type { CapabilityStatus } from '../../lib/platform/capabilities';
import type { BrokerParticipant } from '../../lib/broker/types';

interface AgentStatus extends BrokerParticipant {
  isOnline: boolean;
  lastSeen?: string;
}

export function OnboardingPanel({
  brokerUrl,
  globalShortcut,
  capabilities,
  participants = [],
}: {
  brokerUrl: string;
  globalShortcut: string;
  capabilities: CapabilityStatus;
  participants?: BrokerParticipant[];
}) {
  // 模拟 agent 状态（实际应从 broker 获取）
  const agentStatuses: AgentStatus[] = participants.map((p, i) => ({
    ...p,
    isOnline: i < 2, // 模拟在线状态
    lastSeen: i < 2 ? 'now' : '5m ago',
  }));

  return (
    <section className="panel-section panel-onboarding">
      {/* HexDeck Logo */}
      <div className="hexdeck-logo">
        <img src="/hexdeck.png" alt="HexDeck" className="hexdeck-logo-img" />
        <h1 className="hexdeck-title">HexDeck</h1>
        <p className="hexdeck-subtitle">Agent Desktop Companion</p>
      </div>

      {/* Broker Connection Status */}
      <div className="connection-status">
        <div className="status-indicator">
          <span className="status-dot online"></span>
          <span>Broker Connected</span>
        </div>
        <code className="broker-url">{brokerUrl}</code>
      </div>

      {/* Agent Status Grid */}
      <div className="agent-status-section">
        <h2>Agent Status</h2>
        <div className="agent-grid">
          {agentStatuses.length > 0 ? (
            agentStatuses.map((agent) => (
              <div key={agent.participantId} className="agent-card">
                <div className="agent-header">
                  <span className={`agent-dot ${agent.isOnline ? 'online' : 'offline'}`}></span>
                  <span className="agent-name">{agent.alias}</span>
                </div>
                <div className="agent-info">
                  <span className="agent-kind">{agent.kind || 'agent'}</span>
                  {agent.context?.projectName && (
                    <span className="agent-project">{agent.context.projectName}</span>
                  )}
                </div>
                <span className="agent-last-seen">{agent.lastSeen}</span>
              </div>
            ))
          ) : (
            <div className="agent-card placeholder">
              <p>No agents connected yet</p>
              <p className="agent-hint">Start Claude Code, Codex, or other broker-enabled agents</p>
            </div>
          )}
        </div>
      </div>

      {/* Capabilities Grid */}
      <dl className="overview-grid">
        <div>
          <dt>Global shortcut</dt>
          <dd>{globalShortcut}</dd>
        </div>
        <div>
          <dt>Notifications</dt>
          <dd>{capabilities.notifications}</dd>
        </div>
        <div>
          <dt>Shortcut status</dt>
          <dd>{capabilities.globalShortcut}</dd>
        </div>
        <div>
          <dt>Jump support</dt>
          <dd>{capabilities.jumpSupport}</dd>
        </div>
      </dl>
    </section>
  );
}
