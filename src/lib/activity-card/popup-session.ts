import type { ProjectSeed } from '../broker/types';
import { getPopupCompletionGroupKey } from './popup-candidates';
import type { ActivityCardProjection } from './types';

export type PopupVisibilityState = 'hidden' | 'visible' | 'pending_local_resolution';
export type PopupVisibilityIntent = 'show' | 'keep' | 'hide';

export interface PopupSessionState {
  visibility: PopupVisibilityState;
  activeCard: ActivityCardProjection | null;
  pendingLocalResolutionKey: string | null;
}

export interface ReconcilePopupSessionInput {
  session: PopupSessionState;
  nextCards: ActivityCardProjection[];
  seed: ProjectSeed;
  nowMs: number;
  allowImmediateEmptySync?: boolean;
}

export interface ReconcilePopupSessionResult {
  session: PopupSessionState;
  cardsForStore: ActivityCardProjection[];
  visibilityIntent: PopupVisibilityIntent;
  allowPreemption: boolean;
}

function findSupersedingCompletion(
  activeCard: ActivityCardProjection | null,
  nextCards: ActivityCardProjection[],
): ActivityCardProjection | null {
  if (!activeCard || activeCard.kind !== 'completion') {
    return null;
  }

  const activeGroupKey = getPopupCompletionGroupKey(activeCard);
  if (!activeGroupKey) {
    return null;
  }

  return nextCards.find((card) => (
    card.kind === 'completion'
      && card.cardId !== activeCard.cardId
      && getPopupCompletionGroupKey(card) === activeGroupKey
  )) ?? null;
}

function getTaskThreadResolutionKey(value: { taskId?: string; threadId?: string }): string | null {
  if (value.taskId && value.threadId) {
    return `task-thread:${value.taskId}:${value.threadId}`;
  }

  if (value.taskId) {
    return `task:${value.taskId}`;
  }

  if (value.threadId) {
    return `thread:${value.threadId}`;
  }

  return null;
}

function matchesTaskThreadResolution(
  value: { taskId?: string; threadId?: string },
  event: { taskId?: string; threadId?: string }
): boolean {
  const taskMatch = Boolean(value.taskId && event.taskId && value.taskId === event.taskId);
  const threadMatch = Boolean(value.threadId && event.threadId && value.threadId === event.threadId);

  if (!taskMatch && !threadMatch) {
    return false;
  }

  if (value.taskId && value.threadId && event.taskId && event.threadId) {
    return taskMatch && threadMatch;
  }

  return taskMatch || threadMatch;
}

function getQuestionEventResolutionKey(event: ProjectSeed['events'][number]): string | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const explicitQuestionId = typeof payload.questionId === 'string' && payload.questionId.trim()
    ? payload.questionId.trim()
    : null;
  if (explicitQuestionId) {
    return `question:${explicitQuestionId}`;
  }

  return getTaskThreadResolutionKey(event);
}

function isTerminalProgressEvent(event: ProjectSeed['events'][number]): boolean {
  if (event.type !== 'report_progress') {
    return false;
  }

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const stage = typeof payload.stage === 'string' ? payload.stage : null;
  if (stage === null) {
    return true;
  }

  return stage === 'completed' || stage === 'failed' || stage === 'cancelled';
}

function isPopupResolvedBySeed(
  activeCard: ActivityCardProjection,
  seed: ProjectSeed,
  pendingLocalResolutionKey: string | null
): boolean {
  if (activeCard.kind === 'completion') {
    return false;
  }

  if (pendingLocalResolutionKey === activeCard.resolutionKey) {
    if (activeCard.kind === 'approval') {
      return !seed.approvals.some((approval) => approval.approvalId === activeCard.approvalId && (approval.decision ?? 'pending') === 'pending');
    }

    return seed.events.some((event) => (
      getQuestionEventResolutionKey(event) === activeCard.resolutionKey
      || (event.type === 'answer_clarification' && matchesTaskThreadResolution(activeCard, event))
    ));
  }

  if (activeCard.kind === 'approval') {
    if (seed.events.some(
      (event) => event.type === 'respond_approval' && event.payload?.approvalId === activeCard.approvalId
    )) {
      return true;
    }

    const resolutionKey = getTaskThreadResolutionKey(activeCard);
    return resolutionKey !== null && seed.events.some((event) => (
      getTaskThreadResolutionKey(event) === resolutionKey && isTerminalProgressEvent(event)
    ));
  }

  if (activeCard.questionId.startsWith('question:') && activeCard.questionId !== activeCard.cardId) {
    return seed.events.some((event) => {
      if (event.type !== 'answer_clarification') {
        return false;
      }

      return getQuestionEventResolutionKey(event) === activeCard.questionId;
    });
  }

  const coarseResolutionKey = getTaskThreadResolutionKey(activeCard);
  return seed.events.some((event) => {
    const exactResolutionMatch = coarseResolutionKey !== null && getTaskThreadResolutionKey(event) === coarseResolutionKey;
    if (!exactResolutionMatch && !matchesTaskThreadResolution(activeCard, event)) {
      return false;
    }

    return event.type === 'answer_clarification' || isTerminalProgressEvent(event);
  });
}

export function createHiddenPopupSession(): PopupSessionState {
  return {
    visibility: 'hidden',
    activeCard: null,
    pendingLocalResolutionKey: null,
  };
}

export function markPopupSessionLocalAction(
  session: PopupSessionState,
  card: ActivityCardProjection
): PopupSessionState {
  return {
    ...session,
    visibility: 'pending_local_resolution',
    activeCard: card,
    pendingLocalResolutionKey: card.resolutionKey,
  };
}

export function reconcilePopupSession(input: ReconcilePopupSessionInput): ReconcilePopupSessionResult {
  const { session, nextCards, seed, allowImmediateEmptySync = false } = input;
  const activeCard = session.activeCard;

  if (!activeCard) {
    return {
      session: nextCards[0]
        ? { visibility: 'visible', activeCard: nextCards[0], pendingLocalResolutionKey: null }
        : createHiddenPopupSession(),
      cardsForStore: nextCards,
      visibilityIntent: nextCards[0] ? 'show' : 'hide',
      allowPreemption: true,
    };
  }

  const supersedingCompletion = findSupersedingCompletion(activeCard, nextCards);
  if (supersedingCompletion) {
    return {
      session: {
        visibility: 'visible',
        activeCard: supersedingCompletion,
        pendingLocalResolutionKey: null,
      },
      cardsForStore: nextCards,
      visibilityIntent: 'keep',
      allowPreemption: true,
    };
  }

  const activeReplacement = nextCards.find((card) => card.resolutionKey === activeCard.resolutionKey) ?? null;
  const resolvedBySeed = isPopupResolvedBySeed(activeCard, seed, session.pendingLocalResolutionKey);

  if (activeReplacement) {
    return {
      session: {
        ...session,
        visibility: 'visible',
        activeCard: activeReplacement,
      },
      cardsForStore: nextCards,
      visibilityIntent: 'keep',
      allowPreemption: true,
    };
  }

  if (!resolvedBySeed && !allowImmediateEmptySync) {
    return {
      session: {
        ...session,
        visibility: 'visible',
        activeCard,
      },
      cardsForStore: [activeCard, ...nextCards],
      visibilityIntent: 'keep',
      allowPreemption: true,
    };
  }

  if (nextCards[0]) {
    return {
      session: {
        visibility: 'visible',
        activeCard: nextCards[0],
        pendingLocalResolutionKey: null,
      },
      cardsForStore: nextCards,
      visibilityIntent: 'keep',
      allowPreemption: true,
    };
  }

  return {
    session: createHiddenPopupSession(),
    cardsForStore: [],
    visibilityIntent: 'hide',
    allowPreemption: true,
  };
}
