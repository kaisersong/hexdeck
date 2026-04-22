import type { ActivityCardProjection } from './types';

const ACTIVITY_CARD_PRIORITY_ORDER: Record<ActivityCardProjection['priority'], number> = {
  critical: 0,
  attention: 1,
  ambient: 2,
};

export const LIVE_POPUP_COMPLETION_FRESHNESS_MS = 60_000;

function getCardRecencyKey(card: ActivityCardProjection, index: number): number {
  return typeof card.createdAtMs === 'number' ? card.createdAtMs : index;
}

function comparePopupCards(
  a: { card: ActivityCardProjection; index: number },
  b: { card: ActivityCardProjection; index: number },
) {
  const priorityDelta = ACTIVITY_CARD_PRIORITY_ORDER[a.card.priority] - ACTIVITY_CARD_PRIORITY_ORDER[b.card.priority];
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const recencyDelta = getCardRecencyKey(b.card, b.index) - getCardRecencyKey(a.card, a.index);
  if (recencyDelta !== 0) {
    return recencyDelta;
  }

  return a.index - b.index;
}

function isLivePopupCompletionFresh(
  card: Extract<ActivityCardProjection, { kind: 'completion' }>,
  nowMs: number,
): boolean {
  if (typeof card.createdAtMs !== 'number') {
    return false;
  }

  return nowMs - card.createdAtMs <= LIVE_POPUP_COMPLETION_FRESHNESS_MS;
}

export function getPopupCompletionGroupKey(card: ActivityCardProjection): string | null {
  if (card.kind !== 'completion') {
    return null;
  }

  if (card.taskId && card.threadId) {
    return `task-thread:${card.taskId}:${card.threadId}`;
  }

  if (card.taskId) {
    return `task:${card.taskId}`;
  }

  if (card.threadId) {
    return `thread:${card.threadId}`;
  }

  return `card:${card.cardId}`;
}

export function selectPopupSessionCards(cards: ActivityCardProjection[], nowMs: number): ActivityCardProjection[] {
  const latestCompletionByGroup = new Map<string, { card: ActivityCardProjection; index: number }>();
  const retainedCards: Array<{ card: ActivityCardProjection; index: number }> = [];

  for (const [index, card] of cards.entries()) {
    if (card.kind !== 'completion') {
      retainedCards.push({ card, index });
      continue;
    }

    if (!isLivePopupCompletionFresh(card, nowMs)) {
      continue;
    }

    const groupKey = getPopupCompletionGroupKey(card) ?? `card:${card.cardId}`;
    const existing = latestCompletionByGroup.get(groupKey);
    if (!existing || comparePopupCards({ card, index }, existing) < 0) {
      latestCompletionByGroup.set(groupKey, { card, index });
    }
  }

  retainedCards.push(...latestCompletionByGroup.values());

  return retainedCards
    .sort(comparePopupCards)
    .map(({ card }) => card);
}
