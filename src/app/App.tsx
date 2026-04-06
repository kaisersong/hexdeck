import { useEffect, useState } from 'react';
import { ActivityCardHost } from '../features/activity-card/ActivityCardHost';
import { OnboardingPanel } from '../features/onboarding/OnboardingPanel';
import { ProjectSelector } from '../features/project-selector/ProjectSelector';
import { BrokerClient } from '../lib/broker/client';
import type { BrokerParticipant } from '../lib/broker/types';
import type { JumpTarget } from '../lib/jump/types';
import type { ProjectSnapshotProjection } from '../lib/projections/types';
import { buildProjectSnapshot } from '../lib/projections/project-snapshot';
import { getCapabilityStatus } from '../lib/platform/capabilities';
import { jumpToTarget } from '../lib/platform/jump';
import { registerShortcut } from '../lib/platform/shortcut';
import { startWindowDragging } from '../lib/platform/window-controls';
import { loadLocalSettings, saveCurrentProject } from '../lib/settings/local-settings';
import { useAppStore } from '../lib/store/use-app-store';
import { ExpandedRoute, type ExpandedSection } from './routes/expanded';
import { PanelRoute } from './routes/panel';
import '../styles/tokens.css';
import '../styles/panel.css';

function getWindowMode(): 'panel' | 'expanded' {
  if (typeof window === 'undefined') {
    return 'panel';
  }

  const mode = new URLSearchParams(window.location.search).get('view');
  return mode === 'expanded' ? 'expanded' : 'panel';
}

function getExpandedSection(): ExpandedSection {
  if (typeof window === 'undefined') {
    return 'overview';
  }

  const section = new URLSearchParams(window.location.search).get('section');
  return section === 'settings' ? 'settings' : 'overview';
}

export function App() {
  const windowMode = getWindowMode();
  const isExpandedWindow = windowMode === 'expanded';
  const settings = loadLocalSettings();
  const store = useAppStore();
  const [snapshot, setSnapshot] = useState<ProjectSnapshotProjection | null>(null);
  const [pendingApprovalIds, setPendingApprovalIds] = useState<Set<string>>(new Set());
  const [currentProject, setCurrentProject] = useState<string>(settings.currentProject);
  const [participants, setParticipants] = useState<BrokerParticipant[]>([]);
  const [expandedSection, setExpandedSection] = useState<ExpandedSection>(getExpandedSection());
  const capabilities = getCapabilityStatus();

  useEffect(() => {
    let disposed = false;
    const client = new BrokerClient({ brokerUrl: settings.brokerUrl });

    const refreshSnapshot = async () => {
      try {
        const seed = await client.loadProjectSeed(currentProject);

        if (!disposed) {
          const nextSnapshot = buildProjectSnapshot(seed);
          store.setSnapshot(nextSnapshot);
          setSnapshot(nextSnapshot);
          setParticipants(seed.participants);
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
  }, [settings.brokerUrl, currentProject]);

  useEffect(() => {
    if (isExpandedWindow) {
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
  }, [isExpandedWindow, settings.globalShortcut]);

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

  const handleProjectChange = (project: string) => {
    setCurrentProject(project);
    saveCurrentProject(project);
  };

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

      const seed = await client.loadProjectSeed(currentProject);
      const nextSnapshot = buildProjectSnapshot(seed);
      store.setSnapshot(nextSnapshot);
      setSnapshot(nextSnapshot);
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

  const handleQuit = async () => {
    try {
      const { exit } = await import('@tauri-apps/plugin-process');
      await exit(0);
    } catch {
      // Ignore when not running in Tauri.
    }
  };

  if (isExpandedWindow) {
    return (
      <ExpandedRoute
        section={expandedSection}
        onSectionChange={handleExpandedSectionChange}
        snapshot={snapshot}
        participants={participants}
        brokerUrl={settings.brokerUrl}
        globalShortcut={settings.globalShortcut}
        capabilities={capabilities}
        pendingApprovalIds={pendingApprovalIds}
        onJump={handleJump}
        onApprove={(approvalId, taskId) => void respondToApproval(approvalId, taskId, 'approved')}
        onDeny={(approvalId, taskId) => void respondToApproval(approvalId, taskId, 'denied')}
        onClose={() => void closeCurrentWindow()}
      />
    );
  }

  const brokerLive = snapshot?.overview.brokerHealthy ?? false;
  const shellStatusLabel = brokerLive ? 'LIVE' : 'SETUP';

  return (
    <main className="panel-shell">
      <header
        className="panel-header panel-header--draggable"
        onMouseDown={(event) => void startWindowDragging(event.target)}
      >
        <div className="panel-branding">
          <div>
            <h1>HexDeck</h1>
            <p>{currentProject}</p>
          </div>
          <span className={`panel-status-pill ${brokerLive ? 'panel-status-pill--live' : ''}`}>
            {shellStatusLabel}
          </span>
        </div>
        <div className="panel-toolbar">
          <ProjectSelector
            currentProject={currentProject}
            recentProjects={settings.recentProjects}
            onProjectChange={handleProjectChange}
          />
          <button className="settings-btn" onClick={() => void openExpandedWindow('settings')} title="Settings">
            Settings
          </button>
        </div>
      </header>
      <div className="panel-body">
        {snapshot === null ? (
          <OnboardingPanel
            brokerUrl={settings.brokerUrl}
            globalShortcut={settings.globalShortcut}
            capabilities={capabilities}
            participants={participants}
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
              onOpenExpanded={() => void openExpandedWindow('overview')}
              onOpenSettings={() => void openExpandedWindow('settings')}
              onQuit={() => void handleQuit()}
            />
          </>
        )}
      </div>
    </main>
  );
}
