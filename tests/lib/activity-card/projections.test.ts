import { describe, expect, it } from 'vitest';
import { buildActivityCardsFromSeed } from '../../../src/lib/activity-card/projections';

describe('buildActivityCardsFromSeed', () => {
  it('builds approval, question, and completion cards in priority order', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [
        {
          participantId: 'agent-1',
          alias: 'codex4',
          kind: 'agent',
          metadata: {
            terminalApp: 'Ghostty',
            terminalSessionID: 'session-1',
            projectPath: '/Users/song/projects/hexdeck',
          },
        },
      ],
      workStates: [],
      events: [
        {
          id: 101,
          type: 'ask_clarification',
          payload: {
            participantId: 'agent-1',
            summary: 'Which layout should I use?',
            selectionMode: 'single-select',
            options: [
              { value: 'compact', label: 'Compact' },
              { value: 'expanded', label: 'Expanded' },
            ],
          },
        },
        {
          id: 102,
          type: 'report_progress',
          payload: {
            participantId: 'agent-1',
            summary: 'Implementation is complete',
            stage: 'completed',
          },
        },
      ],
      approvals: [
        {
          approvalId: 'approval-1',
          taskId: 'task-1',
          summary: 'Deploy approval needed',
          decision: 'pending',
        },
      ],
    });

    expect(cards.map((card) => card.kind)).toEqual(['approval', 'question', 'completion']);
    expect(cards[0]).toMatchObject({
      kind: 'approval',
      approvalId: 'approval-1',
      actionMode: 'action',
      cardId: 'approval:approval-1',
    });
    const questionCard = cards[1];
    if (questionCard.kind !== 'question') {
      throw new Error(`expected question card, got ${questionCard.kind}`);
    }

    expect(questionCard).toMatchObject({
      kind: 'question',
      selectionMode: 'single-select',
      prompt: 'Which layout should I use?',
      cardId: 'question:101',
      questionId: 'question:101',
    });
    expect(questionCard.options).toEqual([
      { value: 'compact', label: 'Compact' },
      { value: 'expanded', label: 'Expanded' },
    ]);
    expect(questionCard.jumpTarget?.participantId).toBe('agent-1');
    expect(cards[2]).toMatchObject({
      kind: 'completion',
      stage: 'completed',
      summary: 'Implementation is complete',
      cardId: 'completion:102',
    });
    expect(cards[2].jumpTarget?.participantId).toBe('agent-1');
  });

  it('keeps approval, question, and completion grouped even when completion appears before question', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [],
      workStates: [],
      events: [
        {
          id: 302,
          type: 'report_progress',
          payload: {
            summary: 'Implementation is complete',
            stage: 'completed',
          },
        },
        {
          id: 301,
          type: 'ask_clarification',
          payload: {
            summary: 'Which option should I use?',
            selectionMode: 'single-select',
            options: [{ value: 'a', label: 'A' }],
          },
        },
      ],
      approvals: [
        {
          approvalId: 'approval-2',
          taskId: 'task-2',
          summary: 'Deploy approval needed',
          decision: 'pending',
        },
      ],
    });

    expect(cards.map((card) => card.kind)).toEqual(['approval', 'question', 'completion']);
    expect(cards[0].cardId).toBe('approval:approval-2');
    expect(cards[1].cardId).toBe('question:301');
    expect(cards[1]).toMatchObject({
      kind: 'question',
      questionId: 'question:301',
      selectionMode: 'single-select',
    });
    expect(cards[2].cardId).toBe('completion:302');
  });

  it('preserves distinct question summary and prompt text when both are present', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [],
      workStates: [],
      events: [
        {
          id: 401,
          type: 'ask_clarification',
          payload: {
            summary: 'Which layout should I use?',
            prompt: 'Choose the compact layout',
            selectionMode: 'single-select',
            options: [{ value: 'compact', label: 'Compact' }],
          },
        },
      ],
      approvals: [],
    });

    const questionCard = cards[0];
    if (questionCard.kind !== 'question') {
      throw new Error(`expected question card, got ${questionCard.kind}`);
    }

    expect(questionCard.summary).toBe('Which layout should I use?');
    expect(questionCard.prompt).toBe('Choose the compact layout');
  });

  it('skips clarification questions that are not single-select and progress events that are not completed', () => {
    const cards = buildActivityCardsFromSeed({
      health: { ok: true },
      participants: [],
      workStates: [],
      events: [
        {
          id: 201,
          type: 'ask_clarification',
          payload: {
            summary: 'Choose one or more options',
            selectionMode: 'multi-select',
            options: [{ value: 'a', label: 'A' }],
          },
        },
        {
          id: 202,
          type: 'report_progress',
          payload: {
            summary: 'Still working',
            stage: 'in_progress',
          },
        },
      ],
      approvals: [],
    });

    expect(cards).toEqual([]);
  });
});
