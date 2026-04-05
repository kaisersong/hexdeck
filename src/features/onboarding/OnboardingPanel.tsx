import type { CapabilityStatus } from '../../lib/platform/capabilities';
import type { BrokerParticipant } from '../../lib/broker/types';

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
  return (
    <section className="panel-section panel-onboarding">
      {/* Header with small logo */}
      <div className="onboarding-header">
        <img src="/hexdeck.png" alt="HexDeck" className="onboarding-logo" />
        <div className="onboarding-title">
          <h1>HexDeck</h1>
          <p>Agent Desktop Companion</p>
        </div>
      </div>

      {/* Agent Status */}
      <div className="agent-status-section">
        <h2>Agents</h2>
        {participants.length > 0 ? (
          <div className="agent-list">
            {participants.map((agent) => (
              <div key={agent.participantId} className="agent-item">
                <span className="agent-status-dot"></span>
                <span className="agent-alias">{agent.alias}</span>
                {agent.context?.projectName && (
                  <span className="agent-project">· {agent.context.projectName}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="no-agents">No agents connected</p>
        )}
      </div>

      {/* Status Info */}
      <dl className="status-grid">
        <div className="status-item">
          <dt>Broker</dt>
          <dd className="status-value online">Connected</dd>
        </div>
        <div className="status-item">
          <dt>URL</dt>
          <dd className="status-value url">{brokerUrl}</dd>
        </div>
        <div className="status-item">
          <dt>Jump</dt>
          <dd className="status-value">{capabilities.jumpSupport}</dd>
        </div>
        <div className="status-item">
          <dt>Notifications</dt>
          <dd className="status-value">{capabilities.notifications}</dd>
        </div>
      </dl>
    </section>
  );
}
