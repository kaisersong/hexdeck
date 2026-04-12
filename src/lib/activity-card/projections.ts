import type { ProjectSeed } from '../broker/types';
import { buildJumpTarget } from '../jump/targets';
import type { JumpTarget } from '../jump/types';
import type {
  ActivityCardApprovalAction,
  ActivityCardApprovalProjection,
  ActivityCardCompletionProjection,
  ActivityCardProjection,
  ActivityCardQuestionOption,
  ActivityCardQuestionProjection,
} from './types';

const DEFAULT_APPROVAL_ACTIONS: ActivityCardApprovalAction[] = [
  { label: 'Yes', decisionMode: 'yes' },
  { label: 'Always', decisionMode: 'always' },
  { label: 'No', decisionMode: 'no' },
];

interface ParticipantMetadata {
  terminalApp?: string;
  sessionHint?: string;
  terminalTTY?: string;
  terminalSessionID?: string;
  projectPath?: string;
}

interface ParticipantLabels {
  actorLabel?: string;
  projectLabel?: string;
  toolLabel?: string;
  terminalLabel?: string;
}

function readStringValue(
  source: Record<string, unknown> | null | undefined,
  keys: string[]
): string | undefined {
  if (!source) {
    return undefined;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function normalizeCommandTitle(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function deriveApprovalCommandTitle(
  summary: string,
  payload: Record<string, unknown>,
  body: Record<string, unknown> | null
): string | undefined {
  const directTitle = readStringValue(body, ['commandTitle', 'commandLabel', 'title', 'label'])
    ?? readStringValue(payload, ['commandTitle', 'commandLabel', 'title', 'label']);
  if (directTitle) {
    return directTitle;
  }

  const approvalScope = readStringValue(payload, ['approvalScope']);
  if (approvalScope === 'run_command') {
    const matchedShell = summary.match(/\b(bash|zsh|shell|terminal)\b/i)?.[1];
    return matchedShell ? normalizeCommandTitle(matchedShell) : 'Command';
  }

  const matchedShell = summary.match(/\b(bash|zsh|shell|terminal)\b/i)?.[1];
  return matchedShell ? normalizeCommandTitle(matchedShell) : undefined;
}

function buildApprovalPresentation(
  summary: string,
  payload: Record<string, unknown>,
  body: Record<string, unknown> | null
): Pick<ActivityCardApprovalProjection, 'detailText' | 'commandTitle' | 'commandLine' | 'commandPreview'> {
  const detailText = readStringValue(body, ['detailText', 'detail', 'description', 'reason', 'message'])
    ?? readStringValue(payload, ['detailText', 'detail', 'description', 'reason', 'message']);
  const commandLine = readStringValue(body, ['commandLine', 'command', 'script', 'shellCommand'])
    ?? readStringValue(payload, ['commandLine', 'command', 'script', 'shellCommand']);
  const commandPreview = readStringValue(body, ['commandPreview', 'preview', 'displayCommand'])
    ?? (commandLine ? commandLine.replace(/^\$\s*/, '') : undefined);

  return {
    detailText,
    commandTitle: deriveApprovalCommandTitle(summary, payload, body),
    commandLine,
    commandPreview,
  };
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

function buildParticipantLabels(
  participantId: string | undefined,
  participantsById: Map<string, ProjectSeed['participants'][number]>
): ParticipantLabels {
  if (!participantId) {
    return {};
  }

  const participant = participantsById.get(participantId);
  if (!participant) {
    return {};
  }

  const metadata = (participant.metadata ?? {}) as ParticipantMetadata;
  return {
    actorLabel: participant.alias ? `@${participant.alias}` : undefined,
    projectLabel: typeof participant.context?.projectName === 'string' && participant.context.projectName.trim()
      ? participant.context.projectName.trim()
      : undefined,
    toolLabel: typeof participant.tool === 'string' && participant.tool.trim()
      ? participant.tool.trim()
      : undefined,
    terminalLabel: typeof metadata.terminalApp === 'string' && metadata.terminalApp.trim()
      ? metadata.terminalApp.trim()
      : undefined,
  };
}

function normalizeApprovalAction(
  value: unknown,
  fallbackIndex: number
): ActivityCardApprovalAction | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const decisionMode = candidate.decisionMode ?? candidate.mode ?? candidate.value;
  if (decisionMode !== 'yes' && decisionMode !== 'always' && decisionMode !== 'no') {
    return null;
  }

  const fallbackLabel = DEFAULT_APPROVAL_ACTIONS[fallbackIndex]?.label ?? String(decisionMode);
  const label = typeof candidate.label === 'string' && candidate.label.trim()
    ? candidate.label.trim()
    : fallbackLabel;

  return {
    label,
    decisionMode,
  };
}

function buildApprovalActions(payload: Record<string, unknown> | null | undefined): ActivityCardApprovalAction[] {
  const sources = [
    payload?.actions,
    payload?.body && typeof payload.body === 'object' && !Array.isArray(payload.body)
      ? (payload.body as Record<string, unknown>).actions
      : undefined,
  ];

  for (const source of sources) {
    if (!Array.isArray(source)) {
      continue;
    }

    const actions = source
      .map((value, index) => normalizeApprovalAction(value, index))
      .filter((value): value is ActivityCardApprovalAction => value !== null);

    if (actions.length > 0) {
      return actions;
    }
  }

  return DEFAULT_APPROVAL_ACTIONS;
}

export function buildActivityCardsFromSeed(seed: ProjectSeed): ActivityCardProjection[] {
  const participantsById = new Map(seed.participants.map((participant) => [participant.participantId, participant]));
  const approvalCards: ActivityCardApprovalProjection[] = [];
  const questionCards: ActivityCardQuestionProjection[] = [];
  const completionCards: ActivityCardCompletionProjection[] = [];
  const approvalCardsById = new Map<string, ActivityCardApprovalProjection>();
  const resolvedApprovalIds = new Set<string>();

  for (const approval of seed.approvals) {
    if ((approval.decision ?? 'pending') !== 'pending') {
      continue;
    }

    approvalCardsById.set(approval.approvalId, {
      cardId: `approval:${approval.approvalId}`,
      kind: 'approval',
      priority: 'critical',
      summary: approval.summary ?? 'Approval requested',
      actionMode: 'action',
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      decision: approval.decision ?? 'pending',
      actions: DEFAULT_APPROVAL_ACTIONS,
    } satisfies ActivityCardApprovalProjection);
  }

  for (const event of seed.events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const participantId = typeof payload.participantId === 'string' ? payload.participantId : undefined;
    const participantLabels = buildParticipantLabels(participantId, participantsById);
    const jumpTarget = participantId ? buildParticipantJumpTarget(participantId, participantsById) : null;

    if (event.type === 'request_approval') {
      const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : null;
      const taskId = typeof event.taskId === 'string' ? event.taskId : null;
      if (approvalId && taskId && !resolvedApprovalIds.has(approvalId) && !approvalCardsById.has(approvalId)) {
        const body = payload.body && typeof payload.body === 'object' && !Array.isArray(payload.body)
          ? payload.body as Record<string, unknown>
          : null;
        const summary = String(body?.summary ?? payload.summary ?? 'Approval requested');
        approvalCardsById.set(approvalId, {
          cardId: `approval:${approvalId}`,
          kind: 'approval',
          priority: 'critical',
          summary,
          actionMode: 'action',
          approvalId,
          taskId,
          decision: 'pending',
          actions: buildApprovalActions(payload),
          ...buildApprovalPresentation(summary, payload, body),
          participantId,
          ...participantLabels,
          jumpTarget,
        } satisfies ActivityCardApprovalProjection);
      }
    }

    if (event.type === 'respond_approval') {
      const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : null;
      if (approvalId) {
        resolvedApprovalIds.add(approvalId);
        approvalCardsById.delete(approvalId);
      }
    }

    if (event.type === 'ask_clarification' && isSingleSelectQuestionPayload(payload)) {
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
        ...participantLabels,
        jumpTarget,
        taskId: typeof event.taskId === 'string' ? event.taskId : undefined,
        threadId: typeof event.threadId === 'string' ? event.threadId : undefined,
      } satisfies ActivityCardQuestionProjection);
    }

    if (
      event.type === 'report_progress'
      && payload.stage === 'completed'
    ) {
      completionCards.push({
        cardId: `completion:${event.id}`,
        kind: 'completion',
        priority: 'ambient',
        summary: String(payload.summary ?? payload.message ?? 'Completed'),
        stage: 'completed',
        participantId,
        ...participantLabels,
        jumpTarget,
        taskId: typeof event.taskId === 'string' ? event.taskId : undefined,
        threadId: typeof event.threadId === 'string' ? event.threadId : undefined,
      } satisfies ActivityCardCompletionProjection);
    }
  }

  approvalCards.push(...approvalCardsById.values());
  return [...approvalCards, ...questionCards, ...completionCards];
}
