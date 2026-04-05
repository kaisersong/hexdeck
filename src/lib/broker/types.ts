export interface BrokerHealth {
  ok: boolean;
  status?: 'healthy' | 'degraded';
}

export interface BrokerParticipant {
  participantId: string;
  alias: string;
  kind?: string;
  tool?: string;
  context?: {
    projectName?: string;
  };
}

export interface BrokerWorkState {
  participantId: string;
  status: string;
  taskId?: string;
  threadId?: string;
  summary?: string;
  updatedAt?: string;
}

export interface BrokerEvent {
  id: number;
  type: string;
  taskId?: string;
  threadId?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
}

export interface BrokerApprovalItem {
  approvalId: string;
  taskId: string;
  threadId?: string;
  summary?: string;
  decision?: 'approved' | 'denied' | 'pending';
}

export interface BrokerApprovalResponseInput {
  approvalId: string;
  taskId: string;
  fromParticipantId: string;
  decision: 'approved' | 'denied';
}

export interface ProjectSeed {
  health: BrokerHealth;
  participants: BrokerParticipant[];
  workStates: BrokerWorkState[];
  /** Raw broker replay slice from /events/replay?after=0; not project-scoped. */
  events: BrokerEvent[];
  approvals: BrokerApprovalItem[];
}
