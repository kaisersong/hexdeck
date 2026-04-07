import { useEffect, useState } from 'react';
import { ActivityCardHost } from '../features/activity-card/ActivityCardHost';
import { SettingsPanel } from '../features/settings/SettingsPanel';
import { BrokerClient } from '../lib/broker/client';
import type { JumpTarget } from '../lib/jump/types';
import type { ProjectSnapshotProjection } from '../lib/projections/types';
import { buildProjectSnapshot } from '../lib/projections/project-snapshot';
import { jumpToTarget } from '../lib/platform/jump';
import { DEFAULT_BROKER_URL, loadLocalSettings } from '../lib/settings/local-settings';
import { useAppStore } from '../lib/store/use-app-store';
import { ensureBrokerReady } from '../lib/update/broker-updater';
import { PanelRoute } from './routes/panel';
import '../styles/tokens.css';
import '../styles/panel.css';

function createEmptySnapshot(): ProjectSnapshotProjection {
  return {
    overview: {
      brokerHealthy: false,
      onlineCount: 0,
      busyCount: 0,
      blockedCount: 0,
      pendingApprovalCount: 0,
    },
    now: [],
    attention: [],
    recent: [],
  };
}

export function App() {
  const settings = loadLocalSettings();
  const store = useAppStore();
  const [snapshot, setSnapshot] = useState<ProjectSnapshotProjection>(createEmptySnapshot);
  const [pendingApprovalIds, setPendingApprovalIds] = useState<Set<string>>(new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [bootstrapLogPath, setBootstrapLogPath] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const client = new BrokerClient({ brokerUrl: settings.brokerUrl });

    const refreshSnapshot = async () => {
      let bootstrapCompleted = settings.brokerUrl !== DEFAULT_BROKER_URL;

      try {
        if (settings.brokerUrl === DEFAULT_BROKER_URL) {
          const brokerStart = await ensureBrokerReady(settings.brokerUrl);

          if (!disposed) {
            setBootstrapLogPath(brokerStart.log_path);
          }

          if (!brokerStart.ready) {
            throw new Error(brokerStart.last_error ?? 'broker_not_ready');
          }

          bootstrapCompleted = true;

          if (!disposed) {
            setBootstrapError(null);
          }
        }

        const seed = await client.loadServiceSeed();

        if (!disposed) {
          const nextSnapshot = buildProjectSnapshot(seed);
          store.setSnapshot(nextSnapshot);
          setSnapshot(nextSnapshot);
          setDataError(null);
        }
      } catch (error) {
        if (!disposed) {
          const fallbackSnapshot = createEmptySnapshot();
          store.setSnapshot(fallbackSnapshot);
          setSnapshot(fallbackSnapshot);
          const message = error instanceof Error ? error.message : String(error);

          if (!bootstrapCompleted) {
            setBootstrapError(message);
          } else {
            setDataError(message);
          }
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

      const seed = await client.loadServiceSeed();
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
      <header className="panel-toolbar">
        <button
          className="settings-btn"
          onClick={() => setShowSettings(!showSettings)}
          title="Settings"
          aria-label={showSettings ? 'Back to dashboard' : 'Open settings'}
        >
          {showSettings ? '←' : '⚙'}
        </button>
      </header>
      {showSettings ? (
        <SettingsPanel />
      ) : (
        <>
          {bootstrapError && (
            <section className="panel-banner panel-banner--error" aria-live="polite">
              <strong>Broker bootstrap failed.</strong>
              <span>{bootstrapError}</span>
              {bootstrapLogPath && <span>Log: {bootstrapLogPath}</span>}
            </section>
          )}
          {dataError && (
            <section className="panel-banner panel-banner--error" aria-live="polite">
              <strong>Broker data load failed.</strong>
              <span>{dataError}</span>
              {bootstrapLogPath && <span>Bootstrap log: {bootstrapLogPath}</span>}
            </section>
          )}
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
