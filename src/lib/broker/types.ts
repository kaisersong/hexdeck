export interface BrokerHealth {
  ok: boolean;
  status?: 'healthy' | 'degraded';
}

export type BrokerPresenceStatus = 'online' | 'offline';

export interface BrokerPresence {
  participantId: string;
  status: BrokerPresenceStatus;
  metadata?: Record<string, unknown>;
}

export interface BrokerParticipant {
  participantId: string;
  alias: string;
  kind?: string;
  tool?: string;
  presence?: BrokerPresenceStatus;
  presenceMetadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  context?: {
    projectName?: string;
  };
}

export interface BrokerWorkState {
  participantId: string;
  status: string;
  projectName?: string | null;
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

export type BrokerApprovalDecisionMode = 'yes' | 'always' | 'no';

export interface BrokerApprovalResponseInput {
  approvalId: string;
  taskId: string;
  fromParticipantId: string;
  decision: 'approved' | 'denied';
  decisionMode?: BrokerApprovalDecisionMode;
}

export interface BrokerClarificationAnswerInput {
  intentId?: string;
  taskId?: string;
  threadId?: string;
  fromParticipantId: string;
  toParticipantId: string;
  summary: string;
}

export interface ProjectSeed {
  health: BrokerHealth;
  participants: BrokerParticipant[];
  workStates: BrokerWorkState[];
  /** Raw broker replay slice from /events/replay?after=0; not project-scoped. */
  events: BrokerEvent[];
  approvals: BrokerApprovalItem[];
}
