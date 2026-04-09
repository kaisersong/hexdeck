import type { ProjectSeed } from '../broker/types';
import { buildJumpTarget } from '../jump/targets';
import type { JumpTarget } from '../jump/types';
import type {
  ActivityCardApprovalProjection,
  ActivityCardCompletionProjection,
  ActivityCardProjection,
  ActivityCardQuestionOption,
  ActivityCardQuestionProjection,
} from './types';

interface ParticipantMetadata {
  terminalApp?: string;
  sessionHint?: string;
  terminalTTY?: string;
  terminalSessionID?: string;
  projectPath?: string;
}

function buildParticipantJumpTarget(
  participantId: string,
  participantsById: Map<string, ProjectSeed['participants'][number]>
): JumpTarget | null {
  const participant = participantsById.get(participantId);

  if (!participant) {
    return null;
  }

  const metadata = (participant.metadata ?? {}) as ParticipantMetadata;

  return buildJumpTarget({
    participantId,
    alias: participant.alias,
    toolLabel: participant.tool ?? 'agent',
    terminalApp: String(metadata.terminalApp ?? 'unknown'),
    sessionHint: typeof metadata.sessionHint === 'string' ? metadata.sessionHint : null,
    terminalTTY: typeof metadata.terminalTTY === 'string'
      ? metadata.terminalTTY
      : typeof metadata.sessionHint === 'string' && metadata.terminalApp === 'Terminal.app'
        ? metadata.sessionHint
        : null,
    terminalSessionID: typeof metadata.terminalSessionID === 'string' ? metadata.terminalSessionID : null,
    projectPath: typeof metadata.projectPath === 'string' ? metadata.projectPath : null,
  });
}

function isSingleSelectQuestionPayload(payload: Record<string, unknown>): payload is Record<string, unknown> & {
  selectionMode: 'single-select';
  options: Array<Record<string, unknown>>;
} {
  const selectionMode = payload.selectionMode ?? payload.mode;
  return selectionMode === 'single-select' && Array.isArray(payload.options) && payload.options.length > 0;
}

function toQuestionOptions(options: Array<Record<string, unknown>>): ActivityCardQuestionOption[] {
  return options
    .map((option, index) => {
      const value = typeof option.value === 'string'
        ? option.value
        : typeof option.id === 'string'
          ? option.id
          : typeof option.label === 'string'
            ? option.label
            : String(index);
      const label = typeof option.label === 'string' ? option.label : value;

      return { value, label };
    });
}

export function buildActivityCardsFromSeed(seed: ProjectSeed): ActivityCardProjection[] {
  const participantsById = new Map(seed.participants.map((participant) => [participant.participantId, participant]));
  const approvalCards: ActivityCardApprovalProjection[] = [];
  const questionCards: ActivityCardQuestionProjection[] = [];
  const completionCards: ActivityCardCompletionProjection[] = [];

  for (const approval of seed.approvals) {
    if ((approval.decision ?? 'pending') !== 'pending') {
      continue;
    }

    approvalCards.push({
      cardId: `approval:${approval.approvalId}`,
      kind: 'approval',
      priority: 'critical',
      summary: approval.summary ?? 'Approval requested',
      actionMode: 'action',
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      decision: approval.decision ?? 'pending',
    } satisfies ActivityCardApprovalProjection);
  }

  for (const event of seed.events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    if (event.type === 'ask_clarification' && isSingleSelectQuestionPayload(payload)) {
      const participantId = typeof payload.participantId === 'string' ? payload.participantId : undefined;
      const jumpTarget = participantId ? buildParticipantJumpTarget(participantId, participantsById) : null;
      const questionId = `question:${event.id}`;
      const summary = String(payload.summary ?? payload.prompt ?? 'Clarification requested');
      const prompt = String(payload.prompt ?? payload.summary ?? 'Clarification requested');

      questionCards.push({
        cardId: questionId,
        questionId,
        kind: 'question',
        priority: 'attention',
        summary,
        prompt,
        selectionMode: 'single-select',
        options: toQuestionOptions(payload.options),
        participantId,
        actorLabel: participantId ? participantsById.get(participantId)?.alias ? `@${participantsById.get(participantId)?.alias}` : undefined : undefined,
        jumpTarget,
        taskId: typeof event.taskId === 'string' ? event.taskId : undefined,
        threadId: typeof event.threadId === 'string' ? event.threadId : undefined,
      } satisfies ActivityCardQuestionProjection);
    }

    if (
      event.type === 'report_progress'
      && payload.stage === 'completed'
    ) {
      const participantId = typeof payload.participantId === 'string' ? payload.participantId : undefined;
      const jumpTarget = participantId ? buildParticipantJumpTarget(participantId, participantsById) : null;

      completionCards.push({
        cardId: `completion:${event.id}`,
        kind: 'completion',
        priority: 'ambient',
        summary: String(payload.summary ?? payload.message ?? 'Completed'),
        stage: 'completed',
        participantId,
        actorLabel: participantId ? participantsById.get(participantId)?.alias ? `@${participantsById.get(participantId)?.alias}` : undefined : undefined,
        jumpTarget,
        taskId: typeof event.taskId === 'string' ? event.taskId : undefined,
        threadId: typeof event.threadId === 'string' ? event.threadId : undefined,
      } satisfies ActivityCardCompletionProjection);
    }
  }

  return [...approvalCards, ...questionCards, ...completionCards];
}
