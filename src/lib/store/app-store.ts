import type { ProjectSnapshotProjection } from '../projections/types';

export interface AppState {
  snapshot: ProjectSnapshotProjection | null;
  pendingApprovalIds: Set<string>;
}

export interface AppStore {
  getState(): AppState;
  setSnapshot(snapshot: ProjectSnapshotProjection): void;
  startApprovalAction(approvalId: string): void;
  finishApprovalAction(approvalId: string): void;
}

export function createAppStore(): AppStore {
  const state: AppState = {
    snapshot: null,
    pendingApprovalIds: new Set(),
  };

  return {
    getState() {
      return state;
    },
    setSnapshot(snapshot) {
      state.snapshot = snapshot;
    },
    startApprovalAction(approvalId) {
      state.pendingApprovalIds.add(approvalId);
    },
    finishApprovalAction(approvalId) {
      state.pendingApprovalIds.delete(approvalId);
    },
  };
}
