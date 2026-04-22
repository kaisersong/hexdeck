import { describe, expect, it } from 'vitest';
import type { ActivityCardProjection } from '../../../src/lib/activity-card/types';
import {
  createHiddenPopupSession,
  markPopupSessionLocalAction,
  reconcilePopupSession,
} from '../../../src/lib/activity-card/popup-session';

function makeApproval(summary = 'Need approval'): ActivityCardProjection {
  return {
    cardId: 'approval:1',
    resolutionKey: 'approval:approval-1',
    kind: 'approval',
    priority: 'critical',
    summary,
    approvalId: 'approval-1',
    taskId: 'task-1',
    actionMode: 'action',
    decision: 'pending',
    actions: [{ label: 'Yes', decisionMode: 'yes' }],
  };
}

function makeQuestion(): ActivityCardProjection {
  return {
    cardId: 'question:201',
    resolutionKey: 'question:question-a',
    kind: 'question',
    priority: 'attention',
    summary: 'Which target?',
    questionId: 'question:question-a',
    prompt: 'Which target?',
    selectionMode: 'single-select',
    options: [{ label: 'A', value: 'a' }],
    taskId: 'task-1',
    threadId: 'thread-1',
  };
}

function makeEventScopedQuestion(): ActivityCardProjection {
  return {
    cardId: 'question:14245',
    resolutionKey: 'question:14245',
    kind: 'question',
    priority: 'attention',
    summary: 'Xiaok needs a real popup verification choice.',
    questionId: 'question:14245',
    prompt: 'Which mode should Xiaok export?',
    selectionMode: 'single-select',
    options: [{ label: 'Compact', value: 'compact' }],
    taskId: 'hexdeck-real-xiaok-question-20260420-2325',
    threadId: 'hexdeck-real-xiaok-question-20260420-2325',
  };
}

function makeCompletion(overrides: Partial<Extract<ActivityCardProjection, { kind: 'completion' }>> = {}): ActivityCardProjection {
  return {
    cardId: 'completion:301',
    resolutionKey: 'completion:301',
    kind: 'completion',
    priority: 'ambient',
    summary: 'Completed rollout',
    stage: 'completed',
    taskId: 'task-1',
    threadId: 'thread-1',
    ...overrides,
  };
}

describe('reconcilePopupSession', () => {
  it('keeps a visible approval alive across repeated empty refreshes without resolution evidence', () => {
    const activeCard = makeApproval();
    const first = reconcilePopupSession({
      session: {
        visibility: 'visible',
        activeCard,
        pendingLocalResolutionKey: null,
      },
      nextCards: [],
      seed: { health: { ok: true }, participants: [], workStates: [], events: [], approvals: [] },
      nowMs: 1_000,
    });

    const second = reconcilePopupSession({
      session: first.session,
      nextCards: [],
      seed: { health: { ok: true }, participants: [], workStates: [], events: [], approvals: [] },
      nowMs: 2_000,
    });

    expect(first.visibilityIntent).toBe('keep');
    expect(first.cardsForStore.map((card) => card.cardId)).toEqual(['approval:1']);
    expect(second.visibilityIntent).toBe('keep');
    expect(second.cardsForStore.map((card) => card.cardId)).toEqual(['approval:1']);
  });

  it('hides after a local approval action removes the last visible card', () => {
    const pendingLocal = markPopupSessionLocalAction(
      {
        visibility: 'visible',
        activeCard: makeApproval(),
        pendingLocalResolutionKey: null,
      },
      makeApproval()
    );

    const result = reconcilePopupSession({
      session: pendingLocal,
      nextCards: [],
      seed: { health: { ok: true }, participants: [], workStates: [], events: [], approvals: [] },
      nowMs: 1_000,
      allowImmediateEmptySync: true,
    });

    expect(result.visibilityIntent).toBe('hide');
    expect(result.cardsForStore).toEqual([]);
  });

  it('preempts a visible completion with a higher-priority approval without hiding', () => {
    const result = reconcilePopupSession({
      session: {
        visibility: 'visible',
        activeCard: makeCompletion(),
        pendingLocalResolutionKey: null,
      },
      nextCards: [makeCompletion(), makeApproval('Later approval')],
      seed: { health: { ok: true }, participants: [], workStates: [], events: [], approvals: [] },
      nowMs: 1_000,
    });

    expect(result.visibilityIntent).toBe('keep');
    expect(result.allowPreemption).toBe(true);
    expect(result.cardsForStore.map((card) => card.kind)).toEqual(['completion', 'approval']);
  });

  it('replaces a visible completion when a newer completion for the same task and thread arrives', () => {
    const olderCompletion = makeCompletion({
      cardId: 'completion:older',
      resolutionKey: 'completion:older',
      summary: 'Older completion',
      taskId: 'shared-task',
      threadId: 'shared-thread',
    });
    const newerCompletion = makeCompletion({
      cardId: 'completion:newer',
      resolutionKey: 'completion:newer',
      summary: 'Newer completion',
      taskId: 'shared-task',
      threadId: 'shared-thread',
    });

    const result = reconcilePopupSession({
      session: {
        visibility: 'visible',
        activeCard: olderCompletion,
        pendingLocalResolutionKey: null,
      },
      nextCards: [newerCompletion],
      seed: { health: { ok: true }, participants: [], workStates: [], events: [], approvals: [] },
      nowMs: 1_000,
    });

    expect(result.visibilityIntent).toBe('keep');
    expect(result.cardsForStore.map((card) => card.cardId)).toEqual(['completion:newer']);
    expect(result.session.activeCard?.cardId).toBe('completion:newer');
  });

  it('does not resolve a visible question from an unrelated answer on the same task when ids differ', () => {
    const result = reconcilePopupSession({
      session: {
        visibility: 'visible',
        activeCard: makeQuestion(),
        pendingLocalResolutionKey: null,
      },
      nextCards: [],
      seed: {
        health: { ok: true },
        participants: [],
        workStates: [],
        approvals: [],
        events: [
          {
            id: 999,
            type: 'answer_clarification',
            taskId: 'task-1',
            threadId: 'thread-1',
            payload: {
              questionId: 'question-b',
              body: { summary: 'Use B' },
            },
          },
        ],
      },
      nowMs: 1_000,
    });

    expect(result.visibilityIntent).toBe('keep');
    expect(result.cardsForStore.map((card) => card.cardId)).toEqual(['question:201']);
  });

  it('hides an event-scoped question when a real answer arrives on the same task and thread', () => {
    const result = reconcilePopupSession({
      session: {
        visibility: 'visible',
        activeCard: makeEventScopedQuestion(),
        pendingLocalResolutionKey: null,
      },
      nextCards: [],
      seed: {
        health: { ok: true },
        participants: [],
        workStates: [],
        approvals: [],
        events: [
          {
            id: 14250,
            type: 'answer_clarification',
            taskId: 'hexdeck-real-xiaok-question-20260420-2325',
            threadId: 'hexdeck-real-xiaok-question-20260420-2325',
            payload: {
              participantId: 'human.local',
              body: { summary: 'Compact' },
            },
          },
        ],
      },
      nowMs: 1_000,
    });

    expect(result.visibilityIntent).toBe('hide');
    expect(result.cardsForStore).toEqual([]);
  });
});
