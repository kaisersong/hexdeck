import type { ActivityCardProjection, ActivityCardPriority } from './types';

const PRIORITY_ORDER: Record<ActivityCardPriority, number> = {
  critical: 0,
  attention: 1,
  ambient: 2,
};

const CARD_DURATION_MS = {
  approval: null,
  question: 12_000,
  completion: 12_000,
} as const;

export interface ActivityCardRuntimeState {
  activeCard: ActivityCardProjection | null;
  queue: ActivityCardProjection[];
  dismissedCardIds: Set<string>;
  hovered: boolean;
  activeSinceMs: number | null;
  activeDeadlineMs: number | null;
  pausedRemainingMs: number | null;
}

export interface ReplaceQueueOptions {
  allowPreemption?: boolean;
}

export interface ActivityCardStore {
  getState(): ActivityCardRuntimeState;
  primeExisting(cards: ActivityCardProjection[]): void;
  replaceQueue(cards: ActivityCardProjection[], nowMs: number, options?: ReplaceQueueOptions): void;
  setHovered(hovered: boolean, nowMs: number): void;
  tick(nowMs: number): void;
  dismissActiveCard(nowMs: number): void;
}

function getCardDurationMs(card: ActivityCardProjection): number | null {
  return CARD_DURATION_MS[card.kind];
}

function getCardIdentity(card: ActivityCardProjection): string {
  switch (card.kind) {
    case 'approval':
      return `approval:${card.approvalId}`;
    case 'question':
      return `question:${card.questionId}`;
    case 'completion':
      return `completion:${card.cardId}`;
  }
}

function compareCards(
  a: { card: ActivityCardProjection; order: number },
  b: { card: ActivityCardProjection; order: number }
) {
  const priorityDelta = PRIORITY_ORDER[a.card.priority] - PRIORITY_ORDER[b.card.priority];
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return a.order - b.order;
}

export function createActivityCardStore(): ActivityCardStore {
  const cardOrderByIdentity = new Map<string, number>();
  let nextOrder = 0;

  const state: ActivityCardRuntimeState = {
    activeCard: null,
    queue: [],
    dismissedCardIds: new Set(),
    hovered: false,
    activeSinceMs: null,
    activeDeadlineMs: null,
    pausedRemainingMs: null,
  };

  const ensureCardOrder = (identity: string) => {
    const existing = cardOrderByIdentity.get(identity);
    if (typeof existing === 'number') {
      return existing;
    }

    const order = nextOrder;
    nextOrder += 1;
    cardOrderByIdentity.set(identity, order);
    return order;
  };

  const getActiveIdentity = () => (state.activeCard ? getCardIdentity(state.activeCard) : null);

  const getSortedQueueEntries = (queueByIdentity: Map<string, ActivityCardProjection>) =>
    [...queueByIdentity.entries()]
      .map(([identity, card]) => ({
        identity,
        card,
        order: ensureCardOrder(identity),
      }))
      .sort(compareCards);

  const clearActiveCardState = () => {
    state.activeCard = null;
    state.activeSinceMs = null;
    state.activeDeadlineMs = null;
    state.hovered = false;
    state.pausedRemainingMs = null;
  };

  const startActiveCardTimer = (card: ActivityCardProjection, nowMs: number) => {
    const durationMs = getCardDurationMs(card);
    state.activeCard = card;
    state.activeSinceMs = nowMs;
    state.activeDeadlineMs = durationMs == null ? null : nowMs + durationMs;
    state.hovered = false;
    state.pausedRemainingMs = null;
  };

  const promoteNextQueuedCard = (nowMs: number) => {
    const nextCard = state.queue.shift() ?? null;

    if (!nextCard) {
      clearActiveCardState();
      return;
    }

    startActiveCardTimer(nextCard, nowMs);
  };

  const dismissCurrentCard = (nowMs: number) => {
    if (!state.activeCard) {
      return;
    }

    state.dismissedCardIds.add(getCardIdentity(state.activeCard));
    promoteNextQueuedCard(nowMs);
  };

  const buildLatestQueue = (cards: ActivityCardProjection[]) => {
    const nextQueue = new Map<string, ActivityCardProjection>();
    const seenIncomingIdentities = new Set<string>();

    for (const card of cards) {
      const identity = getCardIdentity(card);

      if (seenIncomingIdentities.has(identity)) {
        continue;
      }

      seenIncomingIdentities.add(identity);

      if (state.dismissedCardIds.has(identity)) {
        continue;
      }

      ensureCardOrder(identity);
      nextQueue.set(identity, card);
    }

    return nextQueue;
  };

  return {
    getState() {
      return state;
    },
    primeExisting(cards) {
      for (const card of cards) {
        state.dismissedCardIds.add(getCardIdentity(card));
      }
      state.queue = [];
      clearActiveCardState();
    },
    replaceQueue(cards, nowMs, options = {}) {
      const latestQueue = buildLatestQueue(cards);
      const activeIdentity = getActiveIdentity();
      const activeCard = activeIdentity ? latestQueue.get(activeIdentity) ?? null : null;
      const sortedEntries = getSortedQueueEntries(latestQueue);

      if (activeCard) {
        const strongestCandidate = sortedEntries[0]?.card ?? null;
        const shouldKeepActive = !options.allowPreemption
          || !strongestCandidate
          || PRIORITY_ORDER[strongestCandidate.priority] >= PRIORITY_ORDER[activeCard.priority]
          || getCardIdentity(strongestCandidate) === activeIdentity;

        if (shouldKeepActive) {
          latestQueue.delete(activeIdentity as string);
          state.activeCard = activeCard;
          state.queue = getSortedQueueEntries(latestQueue).map(({ card }) => card);
          return;
        }
      }

      if (state.activeCard) {
        clearActiveCardState();
      }

      state.queue = sortedEntries.map(({ card }) => card);
      promoteNextQueuedCard(nowMs);
    },
    setHovered(hovered, nowMs) {
      if (!state.activeCard || hovered === state.hovered) {
        state.hovered = hovered;
        return;
      }

      if (hovered) {
        if (state.activeDeadlineMs != null) {
          state.pausedRemainingMs = Math.max(state.activeDeadlineMs - nowMs, 0);
          state.activeDeadlineMs = null;
        }
        state.hovered = true;
        return;
      }

      state.hovered = false;

      const durationMs = getCardDurationMs(state.activeCard);
      if (durationMs != null && state.pausedRemainingMs != null) {
        state.activeSinceMs = nowMs - (durationMs - state.pausedRemainingMs);
        state.activeDeadlineMs = nowMs + state.pausedRemainingMs;
        state.pausedRemainingMs = null;
      }
    },
    tick(nowMs) {
      if (!state.activeCard || state.hovered || state.activeDeadlineMs == null) {
        return;
      }

      if (nowMs < state.activeDeadlineMs) {
        return;
      }

      dismissCurrentCard(nowMs);
    },
    dismissActiveCard(nowMs) {
      dismissCurrentCard(nowMs);
    },
  };
}
