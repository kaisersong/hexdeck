export type ProjectionPriority = 'critical' | 'attention' | 'ambient';

export interface OverviewProjection {
  brokerHealthy: boolean;
  onlineCount: number;
  busyCount: number;
  blockedCount: number;
  pendingApprovalCount: number;
}

export interface AgentCardProjection {
  participantId: string;
  alias: string;
  toolLabel: string;
  workState: string;
  summary: string;
  updatedAtLabel: string;
}

export interface AttentionItemProjection {
  kind: 'blocked' | 'approval' | 'broker-alert' | 'handoff';
  priority: ProjectionPriority;
  summary: string;
}

export interface RecentItemProjection {
  id: number;
  summary: string;
  priority: ProjectionPriority;
}

export interface ProjectSnapshotProjection {
  overview: OverviewProjection;
  now: AgentCardProjection[];
  attention: AttentionItemProjection[];
  recent: RecentItemProjection[];
}
