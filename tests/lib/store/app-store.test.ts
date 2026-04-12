import { describe, expect, it } from 'vitest';
import { createAppStore } from '../../../src/lib/store/app-store';

describe('createAppStore', () => {
  it('stores the latest projected snapshot', () => {
    const store = createAppStore();
    store.setSnapshot({
      overview: {
        brokerHealthy: true,
        onlineCount: 2,
        busyCount: 1,
        blockedCount: 1,
        pendingApprovalCount: 0,
      },
      now: [],
      attention: [],
      recent: [],
    });

    expect(store.getState().snapshot?.overview.onlineCount).toBe(2);
  });

  it('tracks in-flight approval actions', () => {
    const store = createAppStore();

    store.startApprovalAction('approval-1');
    expect(store.getState().pendingApprovalIds.has('approval-1')).toBe(true);

    store.finishApprovalAction('approval-1');
    expect(store.getState().pendingApprovalIds.has('approval-1')).toBe(false);
  });

  it('keeps approval pending while concurrent actions are still in flight', () => {
    const store = createAppStore();

    store.startApprovalAction('approval-1');
    store.startApprovalAction('approval-1');

    expect(store.getState().pendingApprovalIds.has('approval-1')).toBe(true);

    store.finishApprovalAction('approval-1');
    expect(store.getState().pendingApprovalIds.has('approval-1')).toBe(true);

    store.finishApprovalAction('approval-1');
    expect(store.getState().pendingApprovalIds.has('approval-1')).toBe(false);
  });

  it('exposes the activity-card runtime store and forwards queue lifecycle actions', () => {
    const store = createAppStore();

    store.replaceActivityCards(
      [
        {
          cardId: 'question:1',
          kind: 'question',
          priority: 'attention',
          summary: 'Which target?',
          questionId: 'question-1',
          prompt: 'Which target?',
          selectionMode: 'single-select',
          options: [{ label: 'staging', value: 'staging' }],
        },
        {
          cardId: 'approval:1',
          kind: 'approval',
          priority: 'critical',
          summary: 'Approval requested',
          approvalId: 'approval-1',
          actionMode: 'action',
          decision: 'pending',
          taskId: 'task-1',
          actions: [
            { label: 'Yes', decisionMode: 'yes' },
            { label: 'Always', decisionMode: 'always' },
            { label: 'No', decisionMode: 'no' },
          ],
        },
      ],
      0
    );

    expect(store.getState().activityCards.activeCard?.cardId).toBe('approval:1');

    store.setActivityCardHovered(true, 5_500);
    store.tickActivityCards(6_500);
    expect(store.getState().activityCards.activeCard?.cardId).toBe('approval:1');

    store.setActivityCardHovered(false, 6_500);
    store.tickActivityCards(7_100);
    expect(store.getState().activityCards.activeCard?.cardId).toBe('approval:1');

    store.dismissActivityCard(7_200);

    expect(store.getState().activityCards.dismissedCardIds.has('approval:approval-1')).toBe(true);
    expect(store.getState().activityCards.activeCard?.cardId).toBe('question:1');
  });
});
