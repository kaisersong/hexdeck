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
    <section className="panel-section panel-onboarding" aria-labelledby="broker-connection-title">
      <div className="panel-section-header">
        <div>
          <h2 id="broker-connection-title">Broker connection</h2>
          <p className="section-kicker">Waiting for live project data</p>
        </div>
        <span className="health-pill">Setup</span>
      </div>

      <div className="agent-status-section">
        <div className="compact-section-title">Connected agents</div>
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

      <dl className="status-grid">
        <div className="status-item">
          <dt>Broker URL</dt>
          <dd className="status-value url">{brokerUrl}</dd>
        </div>
        <div className="status-item">
          <dt>Shortcut</dt>
          <dd className="status-value">{globalShortcut}</dd>
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
