import { describe, expect, it } from 'vitest';
import type { ActivityCardProjection } from '../../../src/lib/activity-card/types';
import { createActivityCardStore } from '../../../src/lib/activity-card/store';

function makeApproval(cardId: string, approvalId = 'approval-1'): ActivityCardProjection {
  return {
    cardId,
    resolutionKey: `approval:${approvalId}`,
    kind: 'approval',
    priority: 'critical',
    summary: 'Approval requested',
    approvalId,
    actionMode: 'action',
    decision: 'pending',
    taskId: 'task-1',
    actions: [
      { label: 'Yes', decisionMode: 'yes' },
      { label: 'Always', decisionMode: 'always' },
      { label: 'No', decisionMode: 'no' },
    ],
  };
}

function makeQuestion(
  cardId: string,
  questionId = 'question-1',
  summary = 'Which target?'
): ActivityCardProjection {
  return {
    cardId,
    resolutionKey: `question:${questionId}`,
    kind: 'question',
    priority: 'attention',
    summary,
    questionId,
    prompt: summary,
    selectionMode: 'single-select',
    options: [{ label: 'staging', value: 'staging' }],
  };
}

function makeCompletion(options: {
  cardId: string;
  taskId?: string;
  threadId?: string;
  participantId?: string;
  summary?: string;
}): ActivityCardProjection {
  const {
    cardId,
    taskId,
    threadId,
    participantId,
    summary = 'Completed rollout',
  } = options;

  return {
    cardId,
    resolutionKey: `completion:${cardId.replace(/^completion:/, '')}`,
    kind: 'completion',
    priority: 'ambient',
    summary,
    stage: 'completed',
    taskId,
    threadId,
    participantId,
  };
}

describe('createActivityCardStore', () => {
  it('keeps same-priority cards in FIFO order', () => {
    const store = createActivityCardStore();

    store.replaceQueue([makeQuestion('question:2', 'question-2', 'Second target?'), makeQuestion('question:1')], 1_000);

    expect(store.getState().activeCard?.cardId).toBe('question:2');
    expect(store.getState().queue.map((item) => item.cardId)).toEqual(['question:1']);
  });

  it('primes existing cards as dismissed so startup backlog does not replay as notifications', () => {
    const store = createActivityCardStore();

    store.primeExisting([makeApproval('approval:1'), makeQuestion('question:1')]);

    expect(store.getState().activeCard).toBeNull();
    expect(store.getState().queue).toEqual([]);
    expect(store.getState().dismissedCardIds.has('approval:approval-1')).toBe(true);
    expect(store.getState().dismissedCardIds.has('question:question-1')).toBe(true);
  });

  it('deduplicates approval and question cards by semantic identity even when cardIds change', () => {
    const store = createActivityCardStore();

    store.replaceQueue([makeApproval('approval:1'), makeQuestion('question:1')], 0);
    const firstActiveCard = store.getState().activeCard;
    if (!firstActiveCard || firstActiveCard.kind !== 'approval') {
      throw new Error(`expected approval card, got ${firstActiveCard?.kind ?? 'null'}`);
    }
    expect(firstActiveCard.approvalId).toBe('approval-1');
    const firstQueuedCard = store.getState().queue[0];
    if (!firstQueuedCard || firstQueuedCard.kind !== 'question') {
      throw new Error(`expected question card, got ${firstQueuedCard?.kind ?? 'null'}`);
    }
    expect(firstQueuedCard.questionId).toBe('question-1');

    store.replaceQueue([makeApproval('approval:2'), makeQuestion('question:2')], 1_000);

    const refreshedActiveCard = store.getState().activeCard;
    if (!refreshedActiveCard || refreshedActiveCard.kind !== 'approval') {
      throw new Error(`expected approval card, got ${refreshedActiveCard?.kind ?? 'null'}`);
    }
    expect(refreshedActiveCard.approvalId).toBe('approval-1');
    expect(store.getState().queue).toHaveLength(1);
    const refreshedQueuedCard = store.getState().queue[0];
    if (!refreshedQueuedCard || refreshedQueuedCard.kind !== 'question') {
      throw new Error(`expected question card, got ${refreshedQueuedCard?.kind ?? 'null'}`);
    }
    expect(refreshedQueuedCard.questionId).toBe('question-1');
  });

  it('drops stale cards from the latest snapshot and advances to the next valid card', () => {
    const store = createActivityCardStore();

    store.replaceQueue([makeApproval('approval:1'), makeQuestion('question:1')], 0);
    expect(store.getState().activeCard?.cardId).toBe('approval:1');

    store.replaceQueue([makeQuestion('question:1')], 1_000);

    const nextActiveCard = store.getState().activeCard;
    if (!nextActiveCard || nextActiveCard.kind !== 'question') {
      throw new Error(`expected question card, got ${nextActiveCard?.kind ?? 'null'}`);
    }

    expect(nextActiveCard.questionId).toBe('question-1');
    expect(store.getState().queue).toEqual([]);
  });

  it('pauses timeout while hovering and resumes when hover ends', () => {
    const store = createActivityCardStore();
    store.replaceQueue([makeApproval('approval:1')], 0);

    store.setHovered(true, 5_500);
    store.tick(6_500);
    expect(store.getState().activeCard?.cardId).toBe('approval:1');

    store.setHovered(false, 6_500);
    store.tick(7_100);
    expect(store.getState().activeCard?.cardId).toBe('approval:1');
  });

  it('uses kind-specific timeout durations for approval, question, and completion cards', () => {
    const store = createActivityCardStore();

    store.replaceQueue(
      [
        makeApproval('approval:1'),
        makeQuestion('question:1'),
        makeCompletion({ cardId: 'completion:1' }),
      ],
      0
    );
    store.tick(6_001);

    expect(store.getState().dismissedCardIds.has('approval:approval-1')).toBe(false);
    expect(store.getState().activeCard?.cardId).toBe('approval:1');

    store.dismissActiveCard(6_100);
    expect(store.getState().dismissedCardIds.has('approval:approval-1')).toBe(true);
    const questionCard = store.getState().activeCard;
    if (!questionCard || questionCard.kind !== 'question') {
      throw new Error(`expected question card, got ${questionCard?.kind ?? 'null'}`);
    }
    expect(questionCard.questionId).toBe('question-1');

    store.tick(18_102);
    expect(store.getState().dismissedCardIds.has('question:question-1')).toBe(true);
    expect(store.getState().activeCard?.cardId).toBe('completion:1');

    store.tick(30_103);
    expect(store.getState().dismissedCardIds.has('completion:completion:1')).toBe(true);
    expect(store.getState().activeCard).toBeNull();
  });

  it('keeps a manually dismissed approval identity out of the queue even if it reappears with a new cardId', () => {
    const store = createActivityCardStore();

    store.replaceQueue([makeApproval('approval:1')], 0);
    store.dismissActiveCard(6_001);

    expect(store.getState().dismissedCardIds.has('approval:approval-1')).toBe(true);

    store.replaceQueue([makeApproval('approval:2')], 7_000);

    expect(store.getState().activeCard).toBeNull();
    expect(store.getState().queue).toEqual([]);
  });

  it('surfaces a new completion event for the same task after the previous completion expires', () => {
    const store = createActivityCardStore();

    store.replaceQueue([makeCompletion({ cardId: 'completion:1', taskId: 'task-1', summary: 'Completed rollout' })], 0);
    store.tick(12_001);

    expect(store.getState().dismissedCardIds.has('completion:completion:1')).toBe(true);

    store.replaceQueue([makeCompletion({ cardId: 'completion:2', taskId: 'task-1', summary: 'Completion text refreshed' })], 13_000);

    expect(store.getState().activeCard?.cardId).toBe('completion:2');
    expect(store.getState().queue).toEqual([]);
  });

  it('preempts a visible completion when a higher-priority approval arrives', () => {
    const store = createActivityCardStore();

    store.replaceQueue([makeCompletion({ cardId: 'completion:1' })], 0, { allowPreemption: true });
    expect(store.getState().activeCard?.cardId).toBe('completion:1');

    store.replaceQueue(
      [
        makeCompletion({ cardId: 'completion:1' }),
        makeApproval('approval:2', 'approval-2'),
      ],
      1_000,
      { allowPreemption: true }
    );

    const activeCard = store.getState().activeCard;
    if (!activeCard || activeCard.kind !== 'approval') {
      throw new Error(`expected approval card, got ${activeCard?.kind ?? 'null'}`);
    }

    expect(activeCard.approvalId).toBe('approval-2');
    expect(store.getState().queue.map((card) => card.cardId)).toEqual(['completion:1']);
  });

  it('preempts a visible approval when the next snapshot orders a newer same-priority approval first', () => {
    const store = createActivityCardStore();

    store.replaceQueue([makeApproval('approval:1', 'approval-1')], 0, { allowPreemption: true });
    expect(store.getState().activeCard?.cardId).toBe('approval:1');

    store.replaceQueue(
      [
        makeApproval('approval:2', 'approval-2'),
        makeApproval('approval:1', 'approval-1'),
      ],
      1_000,
      { allowPreemption: true }
    );

    const activeCard = store.getState().activeCard;
    if (!activeCard || activeCard.kind !== 'approval') {
      throw new Error(`expected approval card, got ${activeCard?.kind ?? 'null'}`);
    }

    expect(activeCard.approvalId).toBe('approval-2');
    expect(store.getState().queue.map((card) => card.cardId)).toEqual(['approval:1']);
  });

  it('does not merge distinct completion cards that only share the same summary', () => {
    const store = createActivityCardStore();

    store.replaceQueue(
      [
        makeCompletion({ cardId: 'completion:1', summary: 'Completed rollout' }),
        makeCompletion({ cardId: 'completion:2', summary: 'Completed rollout' }),
      ],
      0
    );

    const activeCard = store.getState().activeCard;
    if (!activeCard || activeCard.kind !== 'completion') {
      throw new Error(`expected completion card, got ${activeCard?.kind ?? 'null'}`);
    }

    expect(activeCard.cardId).toBe('completion:1');
    expect(store.getState().queue).toHaveLength(1);
    expect(store.getState().queue[0].cardId).toBe('completion:2');
  });

  it('keeps same-thread completion events separate by broker event cardId', () => {
    const store = createActivityCardStore();

    store.replaceQueue(
      [
        makeCompletion({
          cardId: 'completion:1',
          threadId: 'thread-1',
          participantId: 'agent-1',
          summary: 'First completion',
        }),
        makeCompletion({
          cardId: 'completion:2',
          threadId: 'thread-1',
          participantId: 'agent-1',
          summary: 'Refreshed completion',
        }),
      ],
      0
    );

    const activeCard = store.getState().activeCard;
    if (!activeCard || activeCard.kind !== 'completion') {
      throw new Error(`expected completion card, got ${activeCard?.kind ?? 'null'}`);
    }

    expect(activeCard.cardId).toBe('completion:1');
    expect(store.getState().queue.map((card) => card.cardId)).toEqual(['completion:2']);
  });

  it('keeps different thread completions separate even for the same participant', () => {
    const store = createActivityCardStore();

    store.replaceQueue(
      [
        makeCompletion({
          cardId: 'completion:1',
          threadId: 'thread-1',
          participantId: 'agent-1',
          summary: 'First completion',
        }),
        makeCompletion({
          cardId: 'completion:2',
          threadId: 'thread-2',
          participantId: 'agent-1',
          summary: 'Second completion',
        }),
      ],
      0
    );

    const activeCard = store.getState().activeCard;
    if (!activeCard || activeCard.kind !== 'completion') {
      throw new Error(`expected completion card, got ${activeCard?.kind ?? 'null'}`);
    }

    expect(activeCard.cardId).toBe('completion:1');
    expect(store.getState().queue).toHaveLength(1);
    expect(store.getState().queue[0].cardId).toBe('completion:2');
  });
});
