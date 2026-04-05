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
});
