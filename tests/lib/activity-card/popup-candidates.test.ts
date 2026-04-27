import { describe, expect, it } from 'vitest';
import type { ActivityCardProjection } from '../../../src/lib/activity-card/types';
import {
  LIVE_POPUP_COMPLETION_FRESHNESS_MS,
  selectPopupSessionCards,
} from '../../../src/lib/activity-card/popup-candidates';

function makeApproval(cardId: string): ActivityCardProjection {
  return {
    cardId,
    resolutionKey: `approval:${cardId}`,
    kind: 'approval',
    priority: 'critical',
    summary: `Approval ${cardId}`,
    approvalId: cardId,
    taskId: `${cardId}-task`,
    actionMode: 'action',
    decision: 'pending',
    actions: [{ label: 'Yes', decisionMode: 'yes' }],
  };
}

function makeCompletion(options: {
  cardId: string;
  taskId?: string;
  threadId?: string;
  createdAtMs?: number;
  summary?: string;
}): ActivityCardProjection {
  return {
    cardId: options.cardId,
    resolutionKey: `completion:${options.cardId.replace(/^completion:/, '')}`,
    kind: 'completion',
    priority: 'ambient',
    summary: options.summary ?? options.cardId,
    stage: 'completed',
    taskId: options.taskId,
    threadId: options.threadId,
    createdAtMs: options.createdAtMs,
  };
}

describe('selectPopupSessionCards', () => {
  it('drops stale completion cards from live popup candidates', () => {
    const nowMs = 1_000_000;
    const cards = selectPopupSessionCards(
      [
        makeCompletion({
          cardId: 'completion:stale',
          taskId: 'task-stale',
          threadId: 'thread-stale',
          createdAtMs: nowMs - LIVE_POPUP_COMPLETION_FRESHNESS_MS - 1,
          summary: 'Stale completion',
        }),
        makeCompletion({
          cardId: 'completion:fresh',
          taskId: 'task-fresh',
          threadId: 'thread-fresh',
          createdAtMs: nowMs - 5_000,
          summary: 'Fresh completion',
        }),
      ],
      nowMs,
    );

    expect(cards.map((card) => card.cardId)).toEqual(['completion:fresh']);
  });

  it('keeps only the latest completion for the same task and thread', () => {
    const nowMs = 1_000_000;
    const cards = selectPopupSessionCards(
      [
        makeCompletion({
          cardId: 'completion:older',
          taskId: 'shared-task',
          threadId: 'shared-thread',
          createdAtMs: nowMs - 20_000,
          summary: 'Older completion',
        }),
        makeCompletion({
          cardId: 'completion:newer',
          taskId: 'shared-task',
          threadId: 'shared-thread',
          createdAtMs: nowMs - 5_000,
          summary: 'Newer completion',
        }),
        makeApproval('approval:1'),
      ],
      nowMs,
    );

    expect(cards.map((card) => card.cardId)).toEqual(['approval:1', 'completion:newer']);
  });

  it('keeps newer approvals ahead of older approvals when they carry createdAtMs', () => {
    const nowMs = 1_000_000;
    const cards = selectPopupSessionCards(
      [
        {
          ...makeApproval('approval:older'),
          createdAtMs: nowMs - 20_000,
        },
        {
          ...makeApproval('approval:newer'),
          createdAtMs: nowMs - 5_000,
        },
      ],
      nowMs,
    );

    expect(cards.map((card) => card.cardId)).toEqual(['approval:newer', 'approval:older']);
  });

  it('excludes non-popup cards from the live popup queue', () => {
    const nowMs = 1_000_000;
    const cards = selectPopupSessionCards(
      [
        { ...makeApproval('approval:hidden'), popupEligible: false },
        makeApproval('approval:visible'),
      ],
      nowMs,
    );

    expect(cards.map((card) => card.cardId)).toEqual(['approval:visible']);
  });
});
