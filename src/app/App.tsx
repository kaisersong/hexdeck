import { useEffect, useState } from 'react';
import { ActivityCardHost } from '../features/activity-card/ActivityCardHost';
import { OnboardingPanel } from '../features/onboarding/OnboardingPanel';
import { BrokerClient } from '../lib/broker/client';
import type { JumpTarget } from '../lib/jump/types';
import type { ProjectSnapshotProjection } from '../lib/projections/types';
import { buildProjectSnapshot } from '../lib/projections/project-snapshot';
import { getCapabilityStatus } from '../lib/platform/capabilities';
import { jumpToTarget } from '../lib/platform/jump';
import { loadLocalSettings } from '../lib/settings/local-settings';
import { useAppStore } from '../lib/store/use-app-store';
import { PanelRoute } from './routes/panel';
import '../styles/tokens.css';
import '../styles/panel.css';

export function App() {
  const settings = loadLocalSettings();
  const store = useAppStore();
  const [snapshot, setSnapshot] = useState<ProjectSnapshotProjection | null>(null);
  const [pendingApprovalIds, setPendingApprovalIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let disposed = false;
    const client = new BrokerClient({ brokerUrl: settings.brokerUrl });

    const refreshSnapshot = async () => {
      try {
        const seed = await client.loadProjectSeed('intent-broker');

        if (!disposed) {
          const nextSnapshot = buildProjectSnapshot(seed);
          store.setSnapshot(nextSnapshot);
          setSnapshot(nextSnapshot);
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

  const handleJump = async (target: JumpTarget) => {
    await jumpToTarget(target);
  };

  const respondToApproval = async (
    approvalId: string,
    taskId: string | undefined,
    decision: 'approved' | 'denied'
  ) => {
    if (!taskId) {
      return;
    }

    const client = new BrokerClient({ brokerUrl: settings.brokerUrl });
    store.startApprovalAction(approvalId);
    setPendingApprovalIds(new Set(store.getState().pendingApprovalIds));

    try {
      await client.respondToApproval({
        approvalId,
        taskId,
        fromParticipantId: 'human.local',
        decision,
      });

      const seed = await client.loadProjectSeed('intent-broker');
      const nextSnapshot = buildProjectSnapshot(seed);
      store.setSnapshot(nextSnapshot);
      setSnapshot(nextSnapshot);
    } finally {
      store.finishApprovalAction(approvalId);
      setPendingApprovalIds(new Set(store.getState().pendingApprovalIds));
    }
  };

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
          <ActivityCardHost
            items={snapshot.attention}
            onJump={handleJump}
            pendingApprovalIds={pendingApprovalIds}
            onApprove={(approvalId, taskId) => void respondToApproval(approvalId, taskId, 'approved')}
            onDeny={(approvalId, taskId) => void respondToApproval(approvalId, taskId, 'denied')}
          />
          <PanelRoute
            snapshot={snapshot}
            onJump={handleJump}
            pendingApprovalIds={pendingApprovalIds}
            onApprove={(approvalId, taskId) => void respondToApproval(approvalId, taskId, 'approved')}
            onDeny={(approvalId, taskId) => void respondToApproval(approvalId, taskId, 'denied')}
          />
        </>
      )}
    </main>
  );
}
