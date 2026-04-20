import type { ActivityCardProjection } from '../activity-card/types';
import {
  createActivityCardStore,
  type ReplaceQueueOptions,
  type ActivityCardRuntimeState,
} from '../activity-card/store';
import type { ProjectSnapshotProjection } from '../projections/types';

export interface AppState {
  snapshot: ProjectSnapshotProjection | null;
  pendingApprovalIds: Set<string>;
  activityCards: ActivityCardRuntimeState;
}

export interface AppStore {
  getState(): AppState;
  setSnapshot(snapshot: ProjectSnapshotProjection): void;
  primeActivityCards(cards: ActivityCardProjection[]): void;
  replaceActivityCards(cards: ActivityCardProjection[], nowMs: number, options?: ReplaceQueueOptions): void;
  setActivityCardHovered(hovered: boolean, nowMs: number): void;
  tickActivityCards(nowMs: number): void;
  dismissActivityCard(nowMs: number): void;
  startApprovalAction(approvalId: string): void;
  finishApprovalAction(approvalId: string): void;
}

export function createAppStore(): AppStore {
  const activityCardStore = createActivityCardStore();
  const pendingApprovalCounts = new Map<string, number>();
  const state: AppState = {
    snapshot: null,
    pendingApprovalIds: new Set(),
    activityCards: activityCardStore.getState(),
  };

  const syncPendingApprovalIds = (approvalId: string, delta: 1 | -1) => {
    const currentCount = pendingApprovalCounts.get(approvalId) ?? 0;
    const nextCount = Math.max(currentCount + delta, 0);

    if (nextCount === 0) {
      pendingApprovalCounts.delete(approvalId);
      state.pendingApprovalIds.delete(approvalId);
      return;
    }

    pendingApprovalCounts.set(approvalId, nextCount);
    state.pendingApprovalIds.add(approvalId);
  };

  return {
    getState() {
      return state;
    },
    setSnapshot(snapshot) {
      state.snapshot = snapshot;
    },
    primeActivityCards(cards) {
      activityCardStore.primeExisting(cards);
    },
    replaceActivityCards(cards, nowMs, options) {
      activityCardStore.replaceQueue(cards, nowMs, options);
    },
    setActivityCardHovered(hovered, nowMs) {
      activityCardStore.setHovered(hovered, nowMs);
    },
    tickActivityCards(nowMs) {
      activityCardStore.tick(nowMs);
    },
    dismissActivityCard(nowMs) {
      activityCardStore.dismissActiveCard(nowMs);
    },
    startApprovalAction(approvalId) {
      syncPendingApprovalIds(approvalId, 1);
    },
    finishApprovalAction(approvalId) {
      syncPendingApprovalIds(approvalId, -1);
    },
  };
}
