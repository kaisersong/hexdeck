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
});
