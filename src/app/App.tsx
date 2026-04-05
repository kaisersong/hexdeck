import { useEffect, useState } from 'react';
import { ActivityCardHost } from '../features/activity-card/ActivityCardHost';
import { OnboardingPanel } from '../features/onboarding/OnboardingPanel';
import { BrokerClient } from '../lib/broker/client';
import type { ProjectSnapshotProjection } from '../lib/projections/types';
import { buildProjectSnapshot } from '../lib/projections/project-snapshot';
import { getCapabilityStatus } from '../lib/platform/capabilities';
import { loadLocalSettings } from '../lib/settings/local-settings';
import { PanelRoute } from './routes/panel';
import '../styles/tokens.css';
import '../styles/panel.css';

export function App() {
  const settings = loadLocalSettings();
  const [snapshot, setSnapshot] = useState<ProjectSnapshotProjection | null>(null);

  useEffect(() => {
    let disposed = false;
    const client = new BrokerClient({ brokerUrl: settings.brokerUrl });

    const refreshSnapshot = async () => {
      try {
        const seed = await client.loadProjectSeed('intent-broker');

        if (!disposed) {
          setSnapshot(buildProjectSnapshot(seed));
        }
      } catch {
        if (!disposed) {
          setSnapshot(null);
        }
      }
    };

    void refreshSnapshot();
    const unsubscribe = client.subscribe(() => {
      void refreshSnapshot();
    });
    const disconnect = client.connectRealtime();

    return () => {
      disposed = true;
      unsubscribe();
      disconnect();
    };
  }, [settings.brokerUrl]);

  return (
    <main className="panel-shell">
      <header className="panel-hero">
        <h1>HexDeck</h1>
        <p>Menu bar companion bootstrap complete.</p>
      </header>
      {snapshot === null ? (
        <OnboardingPanel
          brokerUrl={settings.brokerUrl}
          globalShortcut={settings.globalShortcut}
          capabilities={getCapabilityStatus()}
        />
      ) : (
        <>
          <ActivityCardHost items={snapshot.attention} />
          <PanelRoute snapshot={snapshot} />
        </>
      )}
    </main>
  );
}
