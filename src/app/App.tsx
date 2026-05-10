import { useEffect, useRef, useState } from 'react';
import { BrokerClient } from '../lib/broker/client';
import type { ActivityCardProjection } from '../lib/activity-card/types';
import {
  getBrokerRuntimeStatus,
  restartBrokerRuntime,
  type BrokerRuntimeStatus,
} from '../lib/broker/runtime';
import type {
  BrokerApprovalDecisionMode,
  BrokerApprovalItem,
  BrokerEvent,
  BrokerApprovalResponseInput,
  BrokerClarificationAnswerInput,
  BrokerParticipant,
  ProjectSeed,
} from '../lib/broker/types';
import { dedupeActivelyPresentParticipants, isParticipantActivelyPresent } from '../lib/broker/liveness';
import type { JumpTarget } from '../lib/jump/types';
import { buildActivityCardsFromSeed } from '../lib/activity-card/projections';
import { selectPopupSessionCards } from '../lib/activity-card/popup-candidates';
import {
  createHiddenPopupSession,
  markPopupSessionLocalAction,
  reconcilePopupSession,
  type PopupVisibilityIntent,
} from '../lib/activity-card/popup-session';
import type { ProjectSnapshotProjection } from '../lib/projections/types';
import { buildProjectSnapshot } from '../lib/projections/project-snapshot';
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
import { nextLocalBrokerBootstrapAttempt } from './local-broker-bootstrap';
import { DragDemoRoute } from './routes/drag-demo';
import { ActivityCardRoute, type ActivityCardDebugInfo } from './routes/activity-card';
import { ExpandedRoute } from './routes/expanded';
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

function getActivityCardPreviewMode(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const preview = new URLSearchParams(window.location.search).get('preview')?.trim();
  return preview || null;
}

function getActivityCardProjectOverride(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const project = new URLSearchParams(window.location.search).get('project')?.trim();
  if (project) {
    return project;
  }

  const matchedProject = window.location.href.match(/[?&#]project=([^&#]+)/)?.[1];
  return matchedProject ? decodeURIComponent(matchedProject).trim() || null : null;
}

function normalizeProjectIdentity(project: string | null | undefined): string | null {
  const normalized = project?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function basenameFromPath(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? null;
}

function isLocalCodexHostApprovalItem(approval: BrokerApprovalItem): boolean {
  const body = approval.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }

  const delivery = (body as Record<string, unknown>).delivery;
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
    return false;
  }

  return (delivery as Record<string, unknown>).source === 'hexdeck-local-host-approval';
}

function isQueuedContextLocalApproval(approval: BrokerApprovalItem): boolean {
  const body = approval.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }

  const localHostApproval = (body as Record<string, unknown>).localHostApproval;
  if (!localHostApproval || typeof localHostApproval !== 'object' || Array.isArray(localHostApproval)) {
    return false;
  }

  return (localHostApproval as Record<string, unknown>).runtimeSource === 'queued-context';
}

function extractLocalApprovalProjectName(approval: BrokerApprovalItem): string | null {
  const body = approval.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const localHostApproval = (body as Record<string, unknown>).localHostApproval;
  if (!localHostApproval || typeof localHostApproval !== 'object' || Array.isArray(localHostApproval)) {
    return null;
  }

  const projectPath = (localHostApproval as Record<string, unknown>).projectPath;
  return typeof projectPath === 'string' ? basenameFromPath(projectPath) : null;
}

function shouldSuppressQueuedContextLocalApprovalForProject(
  approval: BrokerApprovalItem,
  currentProject: string
): boolean {
  if (!isLocalCodexHostApprovalItem(approval) || !isQueuedContextLocalApproval(approval)) {
    return false;
  }

  const normalizedCurrentProject = normalizeProjectIdentity(currentProject);
  if (!normalizedCurrentProject || normalizedCurrentProject === ALL_AGENTS_PROJECT) {
    return false;
  }

  const approvalProject = normalizeProjectIdentity(extractLocalApprovalProjectName(approval));
  return approvalProject !== null && approvalProject !== normalizedCurrentProject;
}

function filterPopupScopedLocalApprovals(seed: ProjectSeed, currentProject: string): ProjectSeed {
  const suppressedApprovals = seed.approvals.filter((approval) => (
    shouldSuppressQueuedContextLocalApprovalForProject(approval, currentProject)
  ));
  if (suppressedApprovals.length === 0) {
    return seed;
  }

  const suppressedApprovalIds = new Set(suppressedApprovals.map((approval) => approval.approvalId));
  const suppressedCallKeys = new Set(
    suppressedApprovals
      .map((approval) => buildQueuedContextApprovalCallKeyFromApproval(approval))
      .filter((value): value is string => Boolean(value))
  );

  return {
    ...seed,
    approvals: seed.approvals.filter((approval) => !suppressedApprovalIds.has(approval.approvalId)),
    events: seed.events.filter((event) => !isSuppressedQueuedContextNativeApprovalEvent(event, suppressedCallKeys)),
  };
}

function buildQueuedContextApprovalCallKeyFromApproval(approval: BrokerApprovalItem): string | null {
  const participantId = typeof approval.participantId === 'string' && approval.participantId.trim()
    ? approval.participantId.trim()
    : null;
  const body = approval.body;
  if (!participantId || !body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const localHostApproval = (body as Record<string, unknown>).localHostApproval;
  if (!localHostApproval || typeof localHostApproval !== 'object' || Array.isArray(localHostApproval)) {
    return null;
  }

  const callId = (localHostApproval as Record<string, unknown>).callId;
  return typeof callId === 'string' && callId.trim()
    ? `${participantId}\u0000${callId.trim()}`
    : null;
}

function buildQueuedContextApprovalCallKeyFromEvent(event: BrokerEvent): string | null {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const participantId = typeof payload.participantId === 'string' && payload.participantId.trim()
    ? payload.participantId.trim()
    : typeof event.fromParticipantId === 'string' && event.fromParticipantId.trim()
      ? event.fromParticipantId.trim()
      : null;
  if (!participantId) {
    return null;
  }

  const nativeCodexApproval = payload.nativeCodexApproval;
  if (!nativeCodexApproval || typeof nativeCodexApproval !== 'object' || Array.isArray(nativeCodexApproval)) {
    return null;
  }

  const callId = (nativeCodexApproval as Record<string, unknown>).callId;
  return typeof callId === 'string' && callId.trim()
    ? `${participantId}\u0000${callId.trim()}`
    : null;
}

function isBrokerOwnedCodexNativeApprovalEvent(event: BrokerEvent): boolean {
  if (event.type !== 'request_approval') {
    return false;
  }

  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }

  const delivery = payload.delivery;
  if (delivery && typeof delivery === 'object' && !Array.isArray(delivery)) {
    const source = (delivery as Record<string, unknown>).source;
    if (source === 'codex-native-approval') {
      return true;
    }
  }

  if (payload.nativeCodexApproval && typeof payload.nativeCodexApproval === 'object' && !Array.isArray(payload.nativeCodexApproval)) {
    return true;
  }

  return (typeof payload.approvalId === 'string' && payload.approvalId.startsWith('codex-native-call_'))
    || (typeof event.taskId === 'string' && event.taskId.startsWith('codex-native-call_'));
}

function isSuppressedQueuedContextNativeApprovalEvent(
  event: BrokerEvent,
  suppressedCallKeys: ReadonlySet<string>
): boolean {
  if (suppressedCallKeys.size === 0 || !isBrokerOwnedCodexNativeApprovalEvent(event)) {
    return false;
  }

  const callKey = buildQueuedContextApprovalCallKeyFromEvent(event);
  return callKey !== null && suppressedCallKeys.has(callKey);
}

async function debugLogActivityCardFrontend(message: string): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  if (!('__TAURI_INTERNALS__' in window)) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const isActivityCardWindow = params.get('view') === 'activity-card';
  const debugEnabled = isActivityCardWindow
    || params.has('debugLive')
    || params.get('debug') === 'activity-card';
  if (!debugEnabled) {
    return;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('debug_log_activity_card_frontend', { message });
  } catch {
    // Ignore when not running in Tauri.
  }
}

function debugErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function debugLogApprovalFlowEvent(event: Record<string, unknown>): Promise<void> {
  await debugLogActivityCardFrontend(JSON.stringify({
    kind: 'approval_flow',
    source: 'frontend',
    ...event,
  }));
}

async function readCurrentWindowVisibleState(): Promise<boolean | null> {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return await getCurrentWindow().isVisible();
  } catch {
    return null;
  }
}

function buildEmptySnapshot(participants: BrokerParticipant[], brokerHealthy = false): ProjectSnapshotProjection {
  const dedupedParticipants = dedupeActivelyPresentParticipants(participants);
  return {
    overview: {
      brokerHealthy,
      onlineCount: dedupedParticipants.filter(
        (participant) => isAgentParticipant(participant) && isParticipantActivelyPresent(participant)
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
    const matchedProject = participants
      .map((participant) => participant.context?.projectName?.trim())
      .find((projectName): projectName is string => {
        if (!projectName) {
          return false;
        }

        return projectName.localeCompare(normalizedFallback, undefined, { sensitivity: 'accent' }) === 0;
      });

    return matchedProject ?? normalizedFallback;
  }

  return participants
    .find((participant) => isAgentParticipant(participant) && participant.context?.projectName?.trim())
    ?.context?.projectName?.trim() ?? '';
}

const BOOTSTRAP_EPHEMERAL_CARD_FRESHNESS_MS = {
  question: 60_000,
  completion: 300_000,
} as const;
const ACTIVITY_CARD_LOCAL_APPROVAL_EVENT = 'activity-card-local-approval-requested';
const ACTIVITY_CARD_REFRESH_EVENT = 'activity-card-refresh-requested';

function isBootstrapActivityCardFresh(card: ActivityCardProjection, nowMs: number): boolean {
  if (card.kind === 'approval') {
    return true;
  }

  if (typeof card.createdAtMs !== 'number') {
    return false;
  }

  return nowMs - card.createdAtMs <= BOOTSTRAP_EPHEMERAL_CARD_FRESHNESS_MS[card.kind];
}

function isPanelStartupActivityCardVisible(card: ActivityCardProjection, nowMs: number): boolean {
  if (card.kind === 'approval') {
    return true;
  }

  if (typeof card.createdAtMs !== 'number') {
    return false;
  }

  return nowMs - card.createdAtMs <= BOOTSTRAP_EPHEMERAL_CARD_FRESHNESS_MS[card.kind];
}

export type AppActivityApprovalAction = {
  kind: 'approval';
  approvalId: string;
  taskId?: string;
  decisionMode: BrokerApprovalDecisionMode;
  nativeDecision?: unknown;
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

async function syncActivityCardWindowVisibility(
  card: ActivityCardProjection | null,
  sourceWindowMode: 'panel' | 'expanded' | 'drag-demo' | 'activity-card'
): Promise<void> {
  if (!card || sourceWindowMode === 'activity-card') {
    return;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('prepare_activity_card_window');
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
      decision: action.decisionMode === 'no'
        ? 'denied'
        : action.decisionMode === 'cancel'
          ? 'cancelled'
          : 'approved',
      decisionMode: action.decisionMode,
      nativeDecision: action.nativeDecision,
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
  const isActivityCardWindow = windowMode === 'activity-card';
  const isActivityCardPreviewWindow = isActivityCardWindow && Boolean(getActivityCardPreviewMode());
  const isExpandedWindow = windowMode === 'expanded';
  const isDragDemoWindow = windowMode === 'drag-demo';
  const store = useAppStore();
  const panelBlurGuardUntilRef = useRef(0);
  const localBrokerBootstrapAttemptRef = useRef<string | null>(null);
  const [, setViewVersion] = useState(0);
  const [settings, setSettings] = useState(() => loadLocalSettings());
  const activityCardProjectOverride = isActivityCardWindow ? getActivityCardProjectOverride() : null;
  const currentProjectSetting = isActivityCardWindow
    ? activityCardProjectOverride ?? ALL_AGENTS_PROJECT
    : settings.currentProject;
  const popupApprovalProjectScope = isActivityCardWindow
    ? activityCardProjectOverride ?? settings.currentProject
    : settings.currentProject;
  const [snapshot, setSnapshot] = useState<ProjectSnapshotProjection | null>(null);
  const [pendingApprovalIds, setPendingApprovalIds] = useState<Set<string>>(new Set());
  const [participants, setParticipants] = useState<BrokerParticipant[]>([]);
  const [connectionState, setConnectionState] = useState<'idle' | 'checking' | 'connected' | 'error'>('idle');
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<BrokerRuntimeStatus | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [, setActivityCardRenderKey] = useState(0);
  const [activityCardDebugInfo, setActivityCardDebugInfo] = useState<ActivityCardDebugInfo | null>(null);
  const [activityCardWindowIntent, setActivityCardWindowIntent] = useState<PopupVisibilityIntent>('hide');
  const activityCardsBootstrappedRef = useRef(false);
  const allowImmediateEmptyActivityCardSyncRef = useRef(false);
  const popupSessionRef = useRef(createHiddenPopupSession());
  const shouldPrimeStartupActivityBacklog = windowMode !== 'activity-card';

  const syncActivityCards = async (seed: ProjectSeed, cards: ActivityCardProjection[], nowMs: number) => {
    if (!activityCardsBootstrappedRef.current) {
      activityCardsBootstrappedRef.current = true;

      if (shouldPrimeStartupActivityBacklog) {
        const startupVisibleCards = cards.filter((card) => isPanelStartupActivityCardVisible(card, nowMs));
        const passiveStartupCards = cards.filter((card) => !isPanelStartupActivityCardVisible(card, nowMs));

        store.primeActivityCards(passiveStartupCards);

        if (startupVisibleCards.length > 0) {
          store.replaceActivityCards(startupVisibleCards, nowMs);
          setActivityCardRenderKey((value) => value + 1);
          await syncActivityCardWindowVisibility(store.getState().activityCards.activeCard, windowMode);
          return;
        }

        await syncActivityCardWindowVisibility(null, windowMode);
        return;
      }

      const orderedCards = selectPopupSessionCards(cards, nowMs);
      const bootstrapCandidates = orderedCards.filter((card) => isBootstrapActivityCardFresh(card, nowMs));
      const staleCards = cards.filter((card) => !bootstrapCandidates.some((candidate) => candidate.cardId === card.cardId));

      if (staleCards.length > 0) {
        store.primeActivityCards(staleCards);
      }

      const previousActiveCardId = store.getState().activityCards.activeCard?.cardId ?? null;
      const result = reconcilePopupSession({
        session: popupSessionRef.current,
        nextCards: bootstrapCandidates,
        seed,
        nowMs,
      });
      popupSessionRef.current = result.session;
      allowImmediateEmptyActivityCardSyncRef.current = false;
      store.replaceActivityCards(result.cardsForStore, nowMs, {
        allowPreemption: result.allowPreemption,
      });

      const nextActiveCard = store.getState().activityCards.activeCard;
      const nextWindowIntent = nextActiveCard ? result.visibilityIntent : 'hide';
      if (!nextActiveCard) {
        popupSessionRef.current = createHiddenPopupSession();
      }
      if ((nextActiveCard?.cardId ?? null) !== previousActiveCardId) {
        setActivityCardRenderKey((value) => value + 1);
      }
      setActivityCardWindowIntent(nextWindowIntent);
      void debugLogActivityCardFrontend(
        `[app-sync bootstrap] cards=${cards.length} bootstrap=${bootstrapCandidates.length} visibility=${nextWindowIntent} active=${nextActiveCard?.cardId ?? 'null'}`
      );
      await syncActivityCardWindowVisibility(nextActiveCard, windowMode);
      return;
    }

    if (windowMode === 'activity-card') {
      const previousActiveCardId = store.getState().activityCards.activeCard?.cardId ?? null;
      const orderedCards = selectPopupSessionCards(cards, nowMs);
      const result = reconcilePopupSession({
        session: popupSessionRef.current,
        nextCards: orderedCards,
        seed,
        nowMs,
        allowImmediateEmptySync: allowImmediateEmptyActivityCardSyncRef.current,
      });

      popupSessionRef.current = result.session;
      allowImmediateEmptyActivityCardSyncRef.current = false;

      store.replaceActivityCards(result.cardsForStore, nowMs, {
        allowPreemption: result.allowPreemption,
      });

      const nextActiveCard = store.getState().activityCards.activeCard;
      const nextWindowIntent = nextActiveCard ? result.visibilityIntent : 'hide';
      if (!nextActiveCard) {
        popupSessionRef.current = createHiddenPopupSession();
      }
      if ((nextActiveCard?.cardId ?? null) !== previousActiveCardId) {
        setActivityCardRenderKey((value) => value + 1);
      }

      setActivityCardWindowIntent(nextWindowIntent);
      void debugLogActivityCardFrontend(
        `[app-sync live] cards=${cards.length} ordered=${orderedCards.length} visibility=${nextWindowIntent} active=${nextActiveCard?.cardId ?? 'null'}`
      );
      await syncActivityCardWindowVisibility(nextActiveCard, windowMode);
      return;
    }

    const previousActiveCardId = store.getState().activityCards.activeCard?.cardId ?? null;

    allowImmediateEmptyActivityCardSyncRef.current = false;

    store.replaceActivityCards(cards, nowMs);

    const nextActiveCard = store.getState().activityCards.activeCard;
    if ((nextActiveCard?.cardId ?? null) !== previousActiveCardId) {
      setActivityCardRenderKey((value) => value + 1);
    }

    await syncActivityCardWindowVisibility(nextActiveCard, windowMode);
  };

  useEffect(() => {
    if (isActivityCardPreviewWindow) {
      return;
    }

    let disposed = false;
    activityCardsBootstrappedRef.current = false;
    popupSessionRef.current = createHiddenPopupSession();
    if (isActivityCardWindow) {
      setActivityCardWindowIntent('hide');
    }
    const client = new BrokerClient({ brokerUrl: settings.brokerUrl });
    let refreshInFlight = false;
    let refreshQueued = false;
    let disposeActivityCardRefresh: (() => void) | undefined;
    let isFirstLoad = true;

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
              const nextBootstrapAttempt = nextLocalBrokerBootstrapAttempt(
                localBrokerBootstrapAttemptRef.current,
                settings.brokerUrl,
                reloadKey,
                DEFAULT_BROKER_URL
              );

              if (nextBootstrapAttempt) {
                localBrokerBootstrapAttemptRef.current = nextBootstrapAttempt;
                const bootstrap = await ensureBrokerReady(settings.brokerUrl);
                if (disposed) {
                  return;
                }

                if (!bootstrap.ready) {
                  throw new Error(bootstrap.last_error ?? 'broker_not_ready');
                }
              }

              const runtime = await getBrokerRuntimeStatus().catch(() => null);
              if (!disposed) {
                setRuntimeStatus(runtime);
              }
            } else {
              localBrokerBootstrapAttemptRef.current = null;
              if (!disposed) {
                setRuntimeStatus(null);
              }
            }

            // Skip local approval invoke on polls (received via Tauri event instead)
            const seed = await client.loadServiceSeed({ skipLocalApprovals: !isFirstLoad });
            if (disposed) {
              return;
            }

            const nowMs = Date.now();
            const popupScopedSeed = filterPopupScopedLocalApprovals(seed, popupApprovalProjectScope);
            const nextSnapshot = buildProjectSnapshot(seed);
            const activitySeed = popupScopedSeed;
            const activityCards = buildActivityCardsFromSeed(activitySeed);
            await syncActivityCards(activitySeed, activityCards, nowMs);
            if (isActivityCardWindow) {
              const activeCard = store.getState().activityCards.activeCard;
              const latestEventId = activitySeed.events.reduce(
                (latest, event) => Math.max(latest, typeof event.id === 'number' ? event.id : 0),
                0
              );
              setActivityCardDebugInfo({
                project: ALL_AGENTS_PROJECT,
                cardCount: activityCards.length,
                activeCardId: activeCard?.cardId ?? null,
                latestEventId: latestEventId || null,
                connectionState: 'connected',
                connectionMessage: null,
                error: null,
              });
            }
            const agentParticipants = seed.participants.filter(isAgentParticipant);
            const projectCount = new Set(
              agentParticipants
                .map((participant) => participant.context?.projectName?.trim())
                .filter((value): value is string => Boolean(value))
            ).size;

            store.setSnapshot(nextSnapshot);
            setSnapshot(nextSnapshot);
            setParticipants(seed.participants);
            isFirstLoad = false;
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
            if (isActivityCardWindow) {
              setActivityCardDebugInfo((current) => ({
                project: currentProjectSetting,
                cardCount: current?.cardCount ?? 0,
                activeCardId: store.getState().activityCards.activeCard?.cardId ?? null,
                latestEventId: current?.latestEventId ?? null,
                connectionState: 'error',
                connectionMessage: null,
                error: error instanceof Error ? error.message : String(error),
              }));
            }
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

    // Listen for local approval push events from Rust emitter
    let disposeLocalApprovalPush: (() => void) | undefined;
    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        disposeLocalApprovalPush = await listen<BrokerApprovalItem[]>(
          'local-approvals-changed',
          (event) => {
            const approvals = event.payload;
            if (!Array.isArray(approvals)) return;

            // Update snapshot approvals without full re-poll
            setSnapshot((prev) => {
              if (!prev) return prev;
              return { ...prev, approvals };
            });
          }
        );
      })
      .catch(() => undefined);

    if (isActivityCardWindow) {
      void import('@tauri-apps/api/event')
        .then(async ({ listen }) => {
          const disposeRefresh = await listen<string>(ACTIVITY_CARD_REFRESH_EVENT, () => {
            void refreshSnapshot();
          });
          const disposeLocalApproval = await listen<BrokerApprovalItem>(
            ACTIVITY_CARD_LOCAL_APPROVAL_EVENT,
            (event) => {
              const approval = event.payload;
              if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
                return;
              }
              if (typeof approval.approvalId !== 'string' || !approval.approvalId.trim()) {
                return;
              }
              void debugLogApprovalFlowEvent({
                stage: 'approval_loaded',
                approvalId: approval.approvalId,
                participantId: approval.participantId ?? null,
                taskId: approval.taskId ?? null,
              });
              void refreshSnapshot();
            }
          );
          disposeActivityCardRefresh = () => {
            disposeRefresh();
            disposeLocalApproval();
          };
        })
        .catch(() => undefined);
    }
    const unsubscribe = isActivityCardWindow
      ? () => undefined
      : client.subscribe(() => {
          void refreshSnapshot();
        });
    const disconnect = isActivityCardWindow ? () => undefined : client.connectRealtime();
    const intervalId = window.setInterval(() => {
      void refreshSnapshot();
    }, 1000);
    const handleFocus = () => {
      void refreshSnapshot();
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);

    return () => {
      disposed = true;
      allowImmediateEmptyActivityCardSyncRef.current = false;
      disposeActivityCardRefresh?.();
      disposeLocalApprovalPush?.();
      unsubscribe();
      disconnect();
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
    };
  }, [
    currentProjectSetting,
    isActivityCardPreviewWindow,
    isActivityCardWindow,
    popupApprovalProjectScope,
    reloadKey,
    settings.brokerUrl,
    store
  ]);

  useEffect(() => {
    if (isActivityCardPreviewWindow) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const previousActiveCardId = store.getState().activityCards.activeCard?.cardId ?? null;
      store.tickActivityCards(Date.now());

      const nextActiveCard = store.getState().activityCards.activeCard;
      if ((nextActiveCard?.cardId ?? null) === previousActiveCardId) {
        return;
      }

      setActivityCardRenderKey((value) => value + 1);
      if (windowMode === 'activity-card') {
        popupSessionRef.current = nextActiveCard
          ? {
              visibility: 'visible',
              activeCard: nextActiveCard,
              pendingLocalResolutionKey: null,
            }
          : createHiddenPopupSession();
        setActivityCardWindowIntent(nextActiveCard ? 'keep' : 'hide');
        return;
      }

      if (!nextActiveCard) {
        return;
      }
      void syncActivityCardWindowVisibility(nextActiveCard, windowMode);
    }, 250);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isActivityCardPreviewWindow, store, windowMode]);

  useEffect(() => {
    if (isActivityCardPreviewWindow) {
      return;
    }

    let dispose: (() => void) | undefined;

    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<string>('activity-card-dismissed', (event) => {
        const dismissedCardId = typeof event.payload === 'string' ? event.payload : null;
        const activeCardId = store.getState().activityCards.activeCard?.cardId ?? null;
        if (!dismissedCardId || dismissedCardId !== activeCardId) {
          return;
        }

        store.dismissActivityCard(Date.now());
        const nextActiveCard = store.getState().activityCards.activeCard;
        if (windowMode === 'activity-card') {
          dismissVisiblePopupBacklog();
          void hideLiveActivityCardWindow();
          return;
        }

        setActivityCardRenderKey((value) => value + 1);
        void syncActivityCardWindowVisibility(nextActiveCard, windowMode);
      }))
      .then((unlisten) => {
        dispose = unlisten;
      })
      .catch(() => undefined);

    return () => {
      dispose?.();
    };
  }, [isActivityCardPreviewWindow, store, windowMode]);

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

  useEffect(() => {
    if (windowMode !== 'panel') {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest('.menu-dropdown')) {
        return;
      }

      void hidePanelWindow();
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [windowMode]);

  useEffect(() => {
    if (windowMode !== 'panel') {
      return;
    }

    let dispose: (() => void) | undefined;

    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) {
          return;
        }

        if (Date.now() < panelBlurGuardUntilRef.current) {
          return;
        }

        void Promise.resolve(getCurrentWindow().hide()).catch(() => undefined);
      }))
      .then((unlisten) => {
        dispose = unlisten;
      })
      .catch(() => undefined);

    return () => {
      dispose?.();
    };
  }, [windowMode]);

  const handleJump = async (target: JumpTarget) => {
    await jumpToTarget(target);
  };

  const dismissVisiblePopupBacklog = () => {
    const activityCardState = store.getState().activityCards;
    const visibleCards = activityCardState.activeCard
      ? [activityCardState.activeCard, ...activityCardState.queue]
      : activityCardState.queue;

    if (visibleCards.length === 0) {
      return;
    }

    store.primeActivityCards(visibleCards);
  };

  const hideLiveActivityCardWindow = async () => {
    allowImmediateEmptyActivityCardSyncRef.current = false;
    popupSessionRef.current = createHiddenPopupSession();
    setActivityCardWindowIntent('hide');
    setActivityCardRenderKey((value) => value + 1);

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await Promise.resolve(invoke('hide_activity_card_window')).catch(() => undefined);
    } catch {
      // Ignore when not running in Tauri.
    }
  };

  const handleDismissActivityCard = async () => {
    if (isActivityCardPreviewWindow) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().hide();
      } catch {
        // Ignore when not running in Tauri.
      }
      return;
    }

    const activeCardId = store.getState().activityCards.activeCard?.cardId ?? null;
    if (!activeCardId) {
      if (windowMode === 'activity-card') {
        await hideLiveActivityCardWindow();
      }
      return;
    }

    store.dismissActivityCard(Date.now());

    if (windowMode === 'activity-card') {
      dismissVisiblePopupBacklog();
      await hideLiveActivityCardWindow();

      try {
        const [{ emit }] = await Promise.all([
          import('@tauri-apps/api/event'),
        ]);
        await emit('activity-card-dismissed', activeCardId);
      } catch {
        // Ignore when not running in Tauri.
      }
      return;
    }

    await syncActivityCardWindowVisibility(store.getState().activityCards.activeCard, windowMode);
  };

  const handleActivityCardAction = async (action: AppActivityAction) => {
    if (action.kind === 'approval' && !action.taskId) {
      return;
    }

    const client = new BrokerClient({ brokerUrl: settings.brokerUrl });
    const activeCard = store.getState().activityCards.activeCard;
    if (action.kind === 'approval' && windowMode === 'activity-card') {
      const windowVisible = await readCurrentWindowVisibleState();
      if (windowVisible === false) {
        void debugLogApprovalFlowEvent({
          stage: 'approval_ignored_hidden_window',
          approvalId: action.approvalId,
          taskId: action.taskId ?? null,
          decisionMode: action.decisionMode,
          activeCardId: activeCard?.cardId ?? null,
          participantId: activeCard?.participantId ?? null,
        });
        return;
      }
    }

    if (action.kind === 'approval') {
      store.startApprovalAction(action.approvalId);
      setPendingApprovalIds(new Set(store.getState().pendingApprovalIds));
    }

    try {
      if (action.kind === 'approval') {
        void debugLogApprovalFlowEvent({
          stage: 'approval_clicked',
          approvalId: action.approvalId,
          taskId: action.taskId ?? null,
          decisionMode: action.decisionMode,
          nativeDecision: action.nativeDecision ?? null,
          activeCardId: activeCard?.cardId ?? null,
          participantId: activeCard?.participantId ?? null,
        });
      }

      if (windowMode === 'activity-card' && activeCard) {
        popupSessionRef.current = markPopupSessionLocalAction(
          popupSessionRef.current,
          activeCard
        );
        allowImmediateEmptyActivityCardSyncRef.current = true;
        setActivityCardWindowIntent('keep');
      }

      await dispatchActivityCardAction(client, action);
      if (action.kind === 'approval') {
        void debugLogApprovalFlowEvent({
          stage: 'approval_response_posted',
          approvalId: action.approvalId,
          taskId: action.taskId ?? null,
          decisionMode: action.decisionMode,
          nativeDecision: action.nativeDecision ?? null,
        });
      }

      if (action.kind === 'question') {
        store.dismissActivityCard(Date.now());
        setActivityCardRenderKey((value) => value + 1);
      }

      const seed = await client.loadServiceSeed();
      const activitySeed = seed;
      await syncActivityCards(activitySeed, buildActivityCardsFromSeed(activitySeed), Date.now());
      const nextSnapshot = buildProjectSnapshot(seed);
      store.setSnapshot(nextSnapshot);
      setSnapshot(nextSnapshot);
      setParticipants(seed.participants);
      if (action.kind === 'approval') {
        void debugLogApprovalFlowEvent({
          stage: 'approval_refresh_synced',
          approvalId: action.approvalId,
          taskId: action.taskId ?? null,
          participantCount: seed.participants.length,
          approvalCount: seed.approvals.length,
        });
      }
    } catch (error) {
      if (action.kind === 'approval') {
        void debugLogApprovalFlowEvent({
          stage: 'approval_failed',
          approvalId: action.approvalId,
          taskId: action.taskId ?? null,
          decisionMode: action.decisionMode,
          error: debugErrorMessage(error),
        });
      }
      throw error;
    } finally {
      if (action.kind === 'approval') {
        store.finishApprovalAction(action.approvalId);
        setPendingApprovalIds(new Set(store.getState().pendingApprovalIds));
      }
    }
  };

  const openExpandedInCurrentWindow = (section: 'settings') => {
    if (typeof window === 'undefined') {
      return;
    }

    const next = new URLSearchParams(window.location.search);
    next.set('view', 'expanded');
    next.set('section', section);
    window.history.replaceState({}, '', `${window.location.pathname}?${next.toString()}`);
    setViewVersion((version) => version + 1);
  };

  const openExpandedWindow = async (section: 'settings' = 'settings') => {
    if (isExpandedWindow) {
      openExpandedInCurrentWindow(section);
      return;
    }

    if (windowMode === 'panel') {
      panelBlurGuardUntilRef.current = Date.now() + 1500;
    }

    try {
      const [{ invoke }, { getCurrentWindow }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/api/window'),
      ]);
      await invoke('open_expanded_window', { section });
      await getCurrentWindow().hide();
    } catch {
      openExpandedInCurrentWindow(section);
    } finally {
      if (typeof window !== 'undefined' && windowMode === 'panel') {
        window.setTimeout(() => {
          panelBlurGuardUntilRef.current = 0;
        }, 1500);
      }
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

  const brokerLive = runtimeStatus?.healthy ?? snapshot?.overview.brokerHealthy ?? false;
  const panelSnapshot = snapshot ?? buildEmptySnapshot(participants, brokerLive);
  const activityCardState = store.getState().activityCards;
  const activityCardId = activityCardState.activeCard?.cardId ?? null;

  useEffect(() => {
    if (!isActivityCardWindow) {
      return;
    }

    void debugLogActivityCardFrontend(
      `[app-render] intent=${activityCardWindowIntent} active=${activityCardId ?? 'null'} project=${currentProjectSetting}`
    );
  }, [activityCardId, activityCardWindowIntent, currentProjectSetting, isActivityCardWindow]);

  if (isActivityCardWindow) {
    return (
      <ActivityCardRoute
        card={activityCardState.activeCard}
        windowVisibility={activityCardWindowIntent}
        pendingApprovalIds={pendingApprovalIds}
        debugInfo={activityCardDebugInfo}
        onDismiss={() => void handleDismissActivityCard()}
        onJump={handleJump}
        onApprovalAction={(card, approvalAction) => void handleActivityCardAction({
          kind: 'approval',
          approvalId: card.approvalId,
          taskId: card.taskId,
          decisionMode: approvalAction.decisionMode,
          nativeDecision: approvalAction.nativeDecision,
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
        globalShortcut={settings.globalShortcut}
        runtimeStatus={runtimeStatus}
        onSaveSettings={handleSaveSettings}
        onRefreshBroker={handleRefreshBroker}
        onRestartBroker={handleRestartBroker}
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
        currentProject={settings.currentProject}
        brokerLive={brokerLive}
        onJump={handleJump}
        onOpenSettings={() => void openExpandedWindow('settings')}
        onMinimize={() => void minimizeCurrentWindow()}
        onClose={() => void hidePanelWindow()}
      />
    </main>
  );
}
