import type { CapabilityStatus } from '../../lib/platform/capabilities';

export function OnboardingPanel({
  brokerUrl,
  globalShortcut,
  capabilities,
}: {
  brokerUrl: string;
  globalShortcut: string;
  capabilities: CapabilityStatus;
}) {
  return (
    <section className="panel-section panel-onboarding" aria-labelledby="onboarding-title">
      <div className="panel-section-header">
        <h2 id="onboarding-title">Broker connection</h2>
      </div>
      <p className="empty-state">Connect HexDeck to the broker before the panel can project live state.</p>
      <dl className="overview-grid">
        <div>
          <dt>Broker URL</dt>
          <dd>{brokerUrl}</dd>
        </div>
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
