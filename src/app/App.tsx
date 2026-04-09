import { useEffect, useState } from 'react';
import { BrokerClient } from '../lib/broker/client';
import type { ActivityCardProjection } from '../lib/activity-card/types';
import {
  getBrokerRuntimeStatus,
  restartBrokerRuntime,
  type BrokerRuntimeStatus,
} from '../lib/broker/runtime';
import type {
  BrokerApprovalDecisionMode,
  BrokerApprovalResponseInput,
  BrokerClarificationAnswerInput,
  BrokerParticipant,
} from '../lib/broker/types';
import type { JumpTarget } from '../lib/jump/types';
import { buildActivityCardsFromSeed } from '../lib/activity-card/projections';
import type { ProjectSnapshotProjection } from '../lib/projections/types';
import { buildProjectSnapshot } from '../lib/projections/project-snapshot';
import { getCapabilityStatus } from '../lib/platform/capabilities';
import { jumpToTarget } from '../lib/platform/jump';
import { registerShortcut } from '../lib/platform/shortcut';
import {
  ALL_AGENTS_PROJECT,
  DEFAULT_BROKER_URL,
  loadLocalSettings,
  saveLocalSettings,
} from '../lib/settings/local-settings';
import { useAppStore } from '../lib/store/use-app-store';
import { ensureBrokerReady } from '../lib/update/broker-updater';
import { DragDemoRoute } from './routes/drag-demo';
import { ActivityCardRoute } from './routes/activity-card';
import { ExpandedRoute, type ExpandedSection } from './routes/expanded';
import { PanelRoute } from './routes/panel';
import '../styles/tokens.css';
import '../styles/panel.css';

function isAgentParticipant(participant: BrokerParticipant): boolean {
  return participant.kind !== 'human' && participant.kind !== 'adapter';
}

function getWindowMode(): 'panel' | 'expanded' | 'drag-demo' | 'activity-card' {
  if (typeof window === 'undefined') {
    return 'panel';
  }

  const mode = new URLSearchParams(window.location.search).get('view');
  if (mode === 'activity-card') {
    return 'activity-card';
  }

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
      onlineCount: participants.filter(
        (participant) => participant.presence === 'online' && isAgentParticipant(participant)
      ).length,
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
  const normalizedFallback = fallback.trim();
  if (normalizedFallback && normalizedFallback !== ALL_AGENTS_PROJECT) {
    return normalizedFallback;
  }

  return participants
    .find((participant) => isAgentParticipant(participant) && participant.context?.projectName?.trim())
    ?.context?.projectName?.trim() ?? '';
}

export type AppActivityApprovalAction = {
  kind: 'approval';
  approvalId: string;
  taskId?: string;
  decisionMode: BrokerApprovalDecisionMode;
};

export type AppActivityQuestionAction = {
  kind: 'question';
  questionId: string;
  participantId: string;
  taskId?: string;
  threadId?: string;
  answer: string;
};

export type AppActivityAction = AppActivityApprovalAction | AppActivityQuestionAction;

export interface AppActivityTransportClient {
  respondToApproval(input: BrokerApprovalResponseInput): Promise<void>;
  answerClarification(input: BrokerClarificationAnswerInput): Promise<void>;
}

async function syncActivityCardWindowVisibility(card: ActivityCardProjection | null): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke(card ? 'show_activity_card_window' : 'hide_activity_card_window');
  } catch {
    // Ignore when not running in Tauri.
  }
}

function createClarificationIntentId(questionId: string): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return `clarification:${questionId}:${globalThis.crypto.randomUUID()}`;
  }

  return `clarification:${questionId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

export async function dispatchActivityCardAction(
  client: AppActivityTransportClient,
  action: AppActivityAction,
  fromParticipantId = 'human.local'
): Promise<void> {
  if (action.kind === 'approval') {
    if (!action.taskId) {
      return;
    }

    await client.respondToApproval({
      approvalId: action.approvalId,
      taskId: action.taskId,
      fromParticipantId,
      decision: action.decisionMode === 'no' ? 'denied' : 'approved',
      decisionMode: action.decisionMode,
    });
    return;
  }

  await client.answerClarification({
    intentId: createClarificationIntentId(action.questionId),
    fromParticipantId,
    toParticipantId: action.participantId,
    taskId: action.taskId,
    threadId: action.threadId,
    summary: action.answer,
  });
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
  const [, setActivityCardRenderKey] = useState(0);

  const syncActivityCards = async (cards: ActivityCardProjection[], nowMs: number) => {
    const previousActiveCardId = store.getState().activityCards.activeCard?.cardId ?? null;

    store.replaceActivityCards(cards, nowMs);

    const nextActiveCard = store.getState().activityCards.activeCard;
    if ((nextActiveCard?.cardId ?? null) !== previousActiveCardId) {
      setActivityCardRenderKey((value) => value + 1);
    }

    await syncActivityCardWindowVisibility(nextActiveCard);
  };

  useEffect(() => {
    let disposed = false;
    const client = new BrokerClient({ brokerUrl: settings.brokerUrl });
    let refreshInFlight = false;
    let refreshQueued = false;

    const refreshSnapshot = async () => {
      if (disposed) {
        return;
      }

      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }

      refreshInFlight = true;
      try {
        do {
          refreshQueued = false;

          if (!disposed) {
            setConnectionState('checking');
            setConnectionMessage(
              settings.brokerUrl === DEFAULT_BROKER_URL
                ? 'Starting local broker runtime...'
                : `Connecting to broker at ${settings.brokerUrl}...`
            );
          }

          try {
            if (settings.brokerUrl === DEFAULT_BROKER_URL) {
              const bootstrap = await ensureBrokerReady(settings.brokerUrl);
              if (disposed) {
                return;
              }

              if (!bootstrap.ready) {
                throw new Error(bootstrap.last_error ?? 'broker_not_ready');
              }

              const runtime = await getBrokerRuntimeStatus().catch(() => null);
              if (!disposed) {
                setRuntimeStatus(runtime);
              }
            } else if (!disposed) {
              setRuntimeStatus(null);
            }

            const seed = await client.loadServiceSeed();
            if (disposed) {
              return;
            }

            const nowMs = Date.now();
            const nextSnapshot = buildProjectSnapshot(seed);
            await syncActivityCards(buildActivityCardsFromSeed(seed), nowMs);
            const agentParticipants = seed.participants.filter(isAgentParticipant);
            const projectCount = new Set(
              agentParticipants
                .map((participant) => participant.context?.projectName?.trim())
                .filter((value): value is string => Boolean(value))
            ).size;

            store.setSnapshot(nextSnapshot);
            setSnapshot(nextSnapshot);
            setParticipants(seed.participants);
            setConnectionState('connected');
            setConnectionMessage(
              `${settings.brokerUrl === DEFAULT_BROKER_URL ? 'Local broker ready' : 'Broker ready'} · ${agentParticipants.length} agents · ${
                projectCount || 1
              } projects · ${settings.brokerUrl}`
            );
          } catch (error) {
            if (disposed) {
              return;
            }

            setSnapshot(null);
            setParticipants([]);
            setConnectionState('error');
            setConnectionMessage(
              `${settings.brokerUrl === DEFAULT_BROKER_URL ? 'Local broker unavailable' : 'Broker unavailable'}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        } while (!disposed && refreshQueued);
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
  }, [reloadKey, settings.brokerUrl, store]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const previousActiveCardId = store.getState().activityCards.activeCard?.cardId ?? null;
      store.tickActivityCards(Date.now());

      const nextActiveCard = store.getState().activityCards.activeCard;
      if ((nextActiveCard?.cardId ?? null) === previousActiveCardId) {
        return;
      }

      setActivityCardRenderKey((value) => value + 1);
      void syncActivityCardWindowVisibility(nextActiveCard);
    }, 250);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [store]);

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

  const handleActivityCardAction = async (action: AppActivityAction) => {
    if (action.kind === 'approval' && !action.taskId) {
      return;
    }

    const client = new BrokerClient({ brokerUrl: settings.brokerUrl });
    if (action.kind === 'approval') {
      store.startApprovalAction(action.approvalId);
      setPendingApprovalIds(new Set(store.getState().pendingApprovalIds));
    }

    try {
      await dispatchActivityCardAction(client, action);

      const seed = await client.loadServiceSeed();
      await syncActivityCards(buildActivityCardsFromSeed(seed), Date.now());
      const nextSnapshot = buildProjectSnapshot(seed);
      store.setSnapshot(nextSnapshot);
      setSnapshot(nextSnapshot);
      setParticipants(seed.participants);
    } finally {
      if (action.kind === 'approval') {
        store.finishApprovalAction(action.approvalId);
        setPendingApprovalIds(new Set(store.getState().pendingApprovalIds));
      }
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
  const activityCardState = store.getState().activityCards;
  const isActivityCardWindow = windowMode === 'activity-card';

  if (isActivityCardWindow) {
    return (
      <ActivityCardRoute
        card={activityCardState.activeCard}
        pendingApprovalIds={pendingApprovalIds}
        onJump={handleJump}
        onApprovalAction={(card, decisionMode) => void handleActivityCardAction({
          kind: 'approval',
          approvalId: card.approvalId,
          taskId: card.taskId,
          decisionMode,
        })}
        onQuestionAction={(card, option) => {
          if (!card.participantId) {
            return;
          }

          void handleActivityCardAction({
            kind: 'question',
            questionId: card.questionId,
            participantId: card.participantId,
            taskId: card.taskId,
            threadId: card.threadId,
            answer: option.value,
          });
        }}
        onHoverChange={(hovered) => {
          store.setActivityCardHovered(hovered, Date.now());
        }}
      />
    );
  }

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
        onApprove={(approvalId, taskId) => void handleActivityCardAction({
          kind: 'approval',
          approvalId,
          taskId,
          decisionMode: 'yes',
        })}
        onDeny={(approvalId, taskId) => void handleActivityCardAction({
          kind: 'approval',
          approvalId,
          taskId,
          decisionMode: 'no',
        })}
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
        onOpenSettings={() => void openExpandedWindow('settings')}
        onMinimize={() => void minimizeCurrentWindow()}
        onClose={() => void hidePanelWindow()}
      />
    </main>
  );
}
