import type { BrokerApprovalDecisionMode } from '../broker/types';
import type { JumpTarget } from '../jump/types';

export type ActivityCardKind = 'approval' | 'question' | 'completion';

export type ActivityCardPriority = 'critical' | 'attention' | 'ambient';

export type ActivityCardApprovalActionMode = 'action';
export interface ActivityCardApprovalAction {
  label: string;
  decisionMode: BrokerApprovalDecisionMode;
}

export type ActivityCardQuestionSelectionMode = 'single-select';

export interface ActivityCardBaseProjection {
  cardId: string;
  kind: ActivityCardKind;
  summary: string;
  priority: ActivityCardPriority;
  participantId?: string;
  actorLabel?: string;
  projectLabel?: string;
  toolLabel?: string;
  terminalLabel?: string;
  jumpTarget?: JumpTarget | null;
}

export interface ActivityCardApprovalProjection extends ActivityCardBaseProjection {
  kind: 'approval';
  actionMode: ActivityCardApprovalActionMode;
  approvalId: string;
  taskId: string;
  decision: 'approved' | 'denied' | 'pending';
  actions: ActivityCardApprovalAction[];
  detailText?: string;
  commandTitle?: string;
  commandLine?: string;
  commandPreview?: string;
}

export interface ActivityCardQuestionOption {
  value: string;
  label: string;
}

export interface ActivityCardQuestionProjection extends ActivityCardBaseProjection {
  kind: 'question';
  questionId: string;
  prompt: string;
  selectionMode: ActivityCardQuestionSelectionMode;
  options: ActivityCardQuestionOption[];
  taskId?: string;
  threadId?: string;
}

export interface ActivityCardCompletionProjection extends ActivityCardBaseProjection {
  kind: 'completion';
  stage: 'completed';
  taskId?: string;
  threadId?: string;
}

export type ActivityCardProjection =
  | ActivityCardApprovalProjection
  | ActivityCardQuestionProjection
  | ActivityCardCompletionProjection;
