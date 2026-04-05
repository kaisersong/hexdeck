import type { ProjectSnapshotProjection } from '../projections/types';

export interface AppState {
  snapshot: ProjectSnapshotProjection | null;
}

export interface AppStore {
  getState(): AppState;
  setSnapshot(snapshot: ProjectSnapshotProjection): void;
}

export function createAppStore(): AppStore {
  const state: AppState = {
    snapshot: null,
  };

  return {
    getState() {
      return state;
    },
    setSnapshot(snapshot) {
      state.snapshot = snapshot;
    },
  };
}
