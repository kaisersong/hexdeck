import { useEffect, useState } from 'react';
import { BrokerClient } from '../lib/broker/client';
import {
  INTERNAL_BROKER_URL,
  ensureBrokerRunning,
  getBrokerRuntimeStatus,
  restartBrokerRuntime,
  type BrokerRuntimeStatus,
} from '../lib/broker/runtime';
import type { BrokerParticipant } from '../lib/broker/types';
import type { JumpTarget } from '../lib/jump/types';
import type { ProjectSnapshotProjection } from '../lib/projections/types';
import { buildProjectSnapshot } from '../lib/projections/project-snapshot';
import { getCapabilityStatus } from '../lib/platform/capabilities';
import { jumpToTarget } from '../lib/platform/jump';
import { registerShortcut } from '../lib/platform/shortcut';
import { loadLocalSettings, saveLocalSettings } from '../lib/settings/local-settings';
import { useAppStore } from '../lib/store/use-app-store';
import { DragDemoRoute } from './routes/drag-demo';
import { ExpandedRoute, type ExpandedSection } from './routes/expanded';
import { PanelRoute } from './routes/panel';
import '../styles/tokens.css';
import '../styles/panel.css';

function getWindowMode(): 'panel' | 'expanded' | 'drag-demo' {
  if (typeof window === 'undefined') {
    return 'panel';
  }

  const mode = new URLSearchParams(window.location.search).get('view');
  if (mode === 'expanded') {
    return 'expanded';
  }

  if (mode === 'drag-demo') {
    return 'drag-demo';
  }

  return 'panel';
}

function getExpandedSection(): ExpandedSection {
  if (typeof window === 'undefined') {
    return 'overview';
  }

  return new URLSearchParams(window.location.search).get('section') === 'settings' ? 'settings' : 'overview';
}

function buildEmptySnapshot(participants: BrokerParticipant[], brokerHealthy = false): ProjectSnapshotProjection {
  return {
    overview: {
      brokerHealthy,
      onlineCount: participants.length,
      busyCount: 0,
      blockedCount: 0,
      pendingApprovalCount: 0,
    },
    now: [],
    attention: [],
    recent: [],
  };
}

function derivePreferredProject(participants: BrokerParticipant[], fallback: string): string {
  const firstProject = participants.find((participant) => participant.context?.projectName)?.context?.projectName?.trim();
  return firstProject || fallback;
}

export function App() {
  const windowMode = getWindowMode();
  const isExpandedWindow = windowMode === 'expanded';
  const isDragDemoWindow = windowMode === 'drag-demo';
  const store = useAppStore();
  const capabilities = getCapabilityStatus();
  const [settings, setSettings] = useState(() => loadLocalSettings());
  const [snapshot, setSnapshot] = useState<ProjectSnapshotProjection | null>(null);
  const [pendingApprovalIds, setPendingApprovalIds] = useState<Set<string>>(new Set());
  const [participants, setParticipants] = useState<BrokerParticipant[]>([]);
  const [expandedSection, setExpandedSection] = useState<ExpandedSection>(getExpandedSection());
  const [connectionState, setConnectionState] = useState<'idle' | 'checking' | 'connected' | 'error'>('idle');
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<BrokerRuntimeStatus | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let disposed = false;
    const client = new BrokerClient({ brokerUrl: INTERNAL_BROKER_URL });
    let refreshInFlight = false;

    const refreshSnapshot = async () => {
      if (disposed || refreshInFlight) {
        return;
      }

      refreshInFlight = true;

      if (!disposed) {
        setConnectionState('checking');
        setConnectionMessage('Starting local broker runtime...');
      }

      try {
        const runtime = await ensureBrokerRunning();
        if (disposed) {
          return;
        }

        setRuntimeStatus(runtime);

        const seed = await client.loadProjectSeed();
        if (disposed) {
          return;
        }

        const nextSnapshot = buildProjectSnapshot(seed);
        const projectCount = new Set(
          seed.participants
            .map((participant) => participant.context?.projectName?.trim())
            .filter((value): value is string => Boolean(value))
        ).size;

        store.setSnapshot(nextSnapshot);
        setSnapshot(nextSnapshot);
        setParticipants(seed.participants);
        setConnectionState('connected');
        setConnectionMessage(
          `Local broker ready · ${seed.participants.length} agents · ${projectCount || 1} projects · ${INTERNAL_BROKER_URL}`
        );
      } catch (error) {
        if (disposed) {
          return;
        }

        setSnapshot(null);
        setParticipants([]);
        setConnectionState('error');
        setConnectionMessage(`Local broker unavailable: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        refreshInFlight = false;
      }
    };

    void refreshSnapshot();
    const unsubscribe = client.subscribe(() => {
      void refreshSnapshot();
    });
    const disconnect = client.connectRealtime();
    const intervalId = window.setInterval(() => {
      void refreshSnapshot();
    }, 5000);
    const handleFocus = () => {
      void refreshSnapshot();
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);

    return () => {
      disposed = true;
      unsubscribe();
      disconnect();
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
    };
  }, [reloadKey, store]);

  useEffect(() => {
    if (isExpandedWindow || isDragDemoWindow) {
      return;
    }

    let cleanup: (() => void) | undefined;
    void registerShortcut(settings.globalShortcut, () => {
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('toggle_panel_command'))
        .catch(() => undefined);
    }).then((dispose) => {
      cleanup = dispose;
    });

    return () => {
      cleanup?.();
    };
  }, [isDragDemoWindow, isExpandedWindow, settings.globalShortcut]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => {
          const currentWindow = getCurrentWindow();
          return isExpandedWindow ? currentWindow.close() : currentWindow.hide();
        })
        .catch(() => undefined);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isExpandedWindow]);

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

    const client = new BrokerClient({ brokerUrl: INTERNAL_BROKER_URL });
    store.startApprovalAction(approvalId);
    setPendingApprovalIds(new Set(store.getState().pendingApprovalIds));

    try {
      await client.respondToApproval({
        approvalId,
        taskId,
        fromParticipantId: 'human.local',
        decision,
      });

      const seed = await client.loadProjectSeed();
      const nextSnapshot = buildProjectSnapshot(seed);
      store.setSnapshot(nextSnapshot);
      setSnapshot(nextSnapshot);
      setParticipants(seed.participants);
    } finally {
      store.finishApprovalAction(approvalId);
      setPendingApprovalIds(new Set(store.getState().pendingApprovalIds));
    }
  };

  const updateExpandedHistory = (section: ExpandedSection) => {
    if (typeof window === 'undefined' || !isExpandedWindow) {
      return;
    }

    const next = new URLSearchParams(window.location.search);
    next.set('view', 'expanded');
    next.set('section', section);
    window.history.replaceState({}, '', `${window.location.pathname}?${next.toString()}`);
  };

  const handleExpandedSectionChange = (section: ExpandedSection) => {
    setExpandedSection(section);
    updateExpandedHistory(section);
  };

  const openExpandedWindow = async (section: ExpandedSection) => {
    setExpandedSection(section);

    if (isExpandedWindow) {
      updateExpandedHistory(section);
      return;
    }

    try {
      const [{ invoke }, { getCurrentWindow }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/api/window'),
      ]);
      await invoke('open_expanded_window', { section });
      await getCurrentWindow().hide();
    } catch {
      // Ignore when not running in Tauri.
    }
  };

  const closeCurrentWindow = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch {
      // Ignore when not running in Tauri.
    }
  };

  const hidePanelWindow = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().hide();
    } catch {
      // Ignore when not running in Tauri.
    }
  };

  const minimizeCurrentWindow = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().minimize();
    } catch {
      // Ignore when not running in Tauri.
    }
  };

  const handleSaveSettings = (next: { globalShortcut: string }) => {
    const saved = saveLocalSettings({
      globalShortcut: next.globalShortcut,
      currentProject: settings.currentProject,
    });
    setSettings(saved);
    setConnectionMessage(`Saved shortcut ${saved.globalShortcut}`);
  };

  const handleRefreshBroker = async () => {
    setConnectionState('checking');
    setConnectionMessage('Refreshing local broker runtime...');

    try {
      const runtime = await getBrokerRuntimeStatus();
      setRuntimeStatus(runtime);
      setReloadKey((value) => value + 1);
    } catch (error) {
      setConnectionState('error');
      setConnectionMessage(`Runtime refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleRestartBroker = async () => {
    setConnectionState('checking');
    setConnectionMessage('Restarting local broker runtime...');

    try {
      const runtime = await restartBrokerRuntime();
      setRuntimeStatus(runtime);
      setReloadKey((value) => value + 1);
    } catch (error) {
      setConnectionState('error');
      setConnectionMessage(`Broker restart failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const currentProject = derivePreferredProject(participants, settings.currentProject);
  const brokerLive = runtimeStatus?.healthy ?? snapshot?.overview.brokerHealthy ?? false;
  const panelSnapshot = snapshot ?? buildEmptySnapshot(participants, brokerLive);

  if (isExpandedWindow) {
    return (
      <ExpandedRoute
        section={expandedSection}
        onSectionChange={handleExpandedSectionChange}
        snapshot={snapshot}
        participants={participants}
        currentProject={currentProject}
        globalShortcut={settings.globalShortcut}
        connectionState={connectionState}
        connectionMessage={connectionMessage}
        runtimeStatus={runtimeStatus}
        onSaveSettings={handleSaveSettings}
        onRefreshBroker={handleRefreshBroker}
        onRestartBroker={handleRestartBroker}
        capabilities={capabilities}
        pendingApprovalIds={pendingApprovalIds}
        onJump={handleJump}
        onApprove={(approvalId, taskId) => void respondToApproval(approvalId, taskId, 'approved')}
        onDeny={(approvalId, taskId) => void respondToApproval(approvalId, taskId, 'denied')}
        onMinimize={() => void minimizeCurrentWindow()}
        onClose={() => void closeCurrentWindow()}
      />
    );
  }

  if (isDragDemoWindow) {
    return <DragDemoRoute onClose={() => void closeCurrentWindow()} />;
  }

  return (
    <main className="panel-shell panel-shell--dropdown">
      <PanelRoute
        snapshot={panelSnapshot}
        participants={participants}
        currentProject={currentProject}
        brokerLive={brokerLive}
        onJump={handleJump}
        onOpenExpanded={() => void openExpandedWindow('overview')}
        onOpenSettings={() => void openExpandedWindow('settings')}
        onMinimize={() => void minimizeCurrentWindow()}
        onClose={() => void hidePanelWindow()}
      />
    </main>
  );
}
