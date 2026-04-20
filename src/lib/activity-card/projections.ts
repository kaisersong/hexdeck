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

function normalizeDisplayText(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }

  return value
    .replace(/\\n/g, '\n')
    .replace(/\/n/g, '\n')
    .trim();
}

function splitLongDisplayText(value: string | undefined, fallbackSummary: string): { summary: string; detailText?: string } {
  const normalized = normalizeDisplayText(value);
  if (!normalized) {
    return { summary: fallbackSummary };
  }

  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    return {
      summary: lines[0],
      detailText: lines.slice(1).join('\n'),
    };
  }

  if (normalized.length <= 96) {
    return { summary: normalized };
  }

  const sentenceMatch = normalized.match(/^(.{24,96}?[。.!?？])\s*(.+)$/s);
  if (sentenceMatch) {
    return {
      summary: sentenceMatch[1].trim(),
      detailText: sentenceMatch[2].trim(),
    };
  }

  return {
    summary: `${normalized.slice(0, 93).trimEnd()}...`,
    detailText: normalized,
  };
}

function parseEventCreatedAtMs(event: ProjectSeed['events'][number]): number | undefined {
  if (typeof event.createdAt !== 'string') {
    return undefined;
  }

  const normalizedCreatedAt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(event.createdAt)
    ? `${event.createdAt.replace(' ', 'T')}Z`
    : event.createdAt;
  const createdAtMs = Date.parse(normalizedCreatedAt);
  return Number.isFinite(createdAtMs) ? createdAtMs : undefined;
}

function readPayloadBody(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (payload.body && typeof payload.body === 'object' && !Array.isArray(payload.body)) {
    return payload.body as Record<string, unknown>;
  }

  return null;
}

function resolveEventParticipantId(event: ProjectSeed['events'][number], payload: Record<string, unknown>): string | undefined {
  const body = readPayloadBody(payload);
  return readStringValue(body, ['participantId'])
    ?? readStringValue(payload, ['participantId'])
    ?? (typeof event.fromParticipantId === 'string' ? event.fromParticipantId : undefined);
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
  body: Record<string, unknown> | null,
  summaryDetailText?: string
): Pick<ActivityCardApprovalProjection, 'detailText' | 'commandTitle' | 'commandLine' | 'commandPreview'> {
  const detailText = normalizeDisplayText(
    readStringValue(body, ['detailText', 'detail', 'description', 'reason', 'message'])
      ?? readStringValue(payload, ['detailText', 'detail', 'description', 'reason', 'message'])
      ?? summaryDetailText
  );
  const commandLine = normalizeDisplayText(
    readStringValue(body, ['commandLine', 'command', 'script', 'shellCommand'])
      ?? readStringValue(payload, ['commandLine', 'command', 'script', 'shellCommand'])
  );
  const commandPreview = normalizeDisplayText(
    readStringValue(body, ['commandPreview', 'preview', 'displayCommand'])
      ?? (commandLine ? commandLine.replace(/^\$\s*/, '') : undefined)
  );

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
  options: unknown[];
} {
  const selectionMode = payload.selectionMode ?? payload.mode;
  return selectionMode === 'single-select' && Array.isArray(payload.options) && payload.options.length > 0;
}

function toQuestionOptions(options: unknown[]): ActivityCardQuestionOption[] {
  return options
    .map((option, index) => {
      if (typeof option === 'string') {
        return {
          value: option,
          label: option,
        };
      }

      if (typeof option !== 'object' || option === null || Array.isArray(option)) {
        return null;
      }

      const record = option as Record<string, unknown>;
      const value = typeof record.value === 'string'
        ? record.value
        : typeof record.id === 'string'
          ? record.id
          : typeof record.label === 'string'
            ? record.label
            : typeof record.title === 'string'
              ? record.title
              : String(index);
      const label = typeof record.label === 'string'
        ? record.label
        : typeof record.title === 'string'
          ? record.title
          : value;
      const description = readStringValue(record, ['description', 'detail', 'subtitle', 'helpText']);

      return { value, label, description };
    })
    .filter((option): option is ActivityCardQuestionOption => option !== null);
}

function buildQuestionPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const body = readPayloadBody(payload);
  return body ? { ...payload, ...body } : payload;
}

function getQuestionIdentity(payload: Record<string, unknown>, eventId: number): string {
  const mergedPayload = buildQuestionPayload(payload);
  const explicitQuestionId = readStringValue(mergedPayload, ['questionId', 'clarificationId']);
  return explicitQuestionId ? `question:${explicitQuestionId}` : `question:${eventId}`;
}

function getQuestionResolutionEventKey(
  event: ProjectSeed['events'][number],
  payload: Record<string, unknown>
): string | null {
  const mergedPayload = buildQuestionPayload(payload);
  const explicitQuestionId = readStringValue(mergedPayload, ['questionId', 'clarificationId']);
  if (explicitQuestionId) {
    return `question:${explicitQuestionId}`;
  }

  return getTaskThreadResolutionKey(event);
}

function getCompletionResolutionKey(event: Pick<ProjectSeed['events'][number], 'id'>): string {
  return `completion:${event.id}`;
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

function isSuppressedApprovalSummary(summary: string | undefined | null): boolean {
  if (!summary) {
    return false;
  }

  return /^codex needs approval\b/i.test(summary.trim());
}

function isSuppressedApprovalIdentity(approvalId: string | null | undefined, taskId: string | null | undefined): boolean {
  return Boolean(
    approvalId?.startsWith('preview-approval-')
      || taskId?.startsWith('preview-task-')
  );
}

function isSuppressedInternalApprovalNoise(
  source: Record<string, unknown> | null | undefined,
  approvalId: string | null | undefined,
  taskId: string | null | undefined
): boolean {
  const delivery = source?.delivery;
  if (delivery && typeof delivery === 'object' && !Array.isArray(delivery)) {
    const deliverySource = (delivery as Record<string, unknown>).source;
    if (deliverySource === 'codex-native-approval') {
      return true;
    }
  }

  return Boolean(
    approvalId?.startsWith('codex-native-call_')
      || taskId?.startsWith('codex-native-call_')
  );
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

function getTaskThreadResolutionKey(event: Pick<ProjectSeed['events'][number], 'taskId' | 'threadId'>): string | null {
  if (event.taskId && event.threadId) {
    return `task-thread:${event.taskId}:${event.threadId}`;
  }

  if (event.taskId) {
    return `task:${event.taskId}`;
  }

  if (event.threadId) {
    return `thread:${event.threadId}`;
  }

  return null;
}

function isCompletedProgressEvent(event: ProjectSeed['events'][number]): boolean {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  return event.type === 'report_progress' && payload.stage === 'completed';
}

export function buildActivityCardsFromSeed(seed: ProjectSeed): ActivityCardProjection[] {
  const participantsById = new Map(seed.participants.map((participant) => [participant.participantId, participant]));
  const approvalCards: ActivityCardApprovalProjection[] = [];
  const questionCards: ActivityCardQuestionProjection[] = [];
  const completionCards: ActivityCardCompletionProjection[] = [];
  const approvalCardsById = new Map<string, ActivityCardApprovalProjection>();
  const resolvedApprovalIds = new Set<string>();
  const questionResolutionEventIdByKey = new Map<string, number>();
  const completedTaskKeys = new Set<string>();

  for (const event of seed.events) {
    const resolutionKey = getTaskThreadResolutionKey(event);
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    if (event.type === 'answer_clarification') {
      const questionResolutionKey = getQuestionResolutionEventKey(event, payload);
      if (questionResolutionKey) {
        questionResolutionEventIdByKey.set(
          questionResolutionKey,
          Math.max(questionResolutionEventIdByKey.get(questionResolutionKey) ?? 0, event.id)
        );
      }
    } else if (event.type === 'report_progress' && resolutionKey) {
      questionResolutionEventIdByKey.set(
        resolutionKey,
        Math.max(questionResolutionEventIdByKey.get(resolutionKey) ?? 0, event.id)
      );
    }

    if (resolutionKey && isCompletedProgressEvent(event)) {
      completedTaskKeys.add(resolutionKey);
    }
  }

  for (const approval of seed.approvals) {
    if ((approval.decision ?? 'pending') !== 'pending') {
      continue;
    }

    const approvalRecord = approval as unknown as Record<string, unknown>;
    const approvalBody = approval.body && typeof approval.body === 'object' && !Array.isArray(approval.body)
      ? approval.body as Record<string, unknown>
      : null;
    const approvalDisplay = splitLongDisplayText(
      readStringValue(approvalBody, ['summary'])
        ?? (typeof approval.summary === 'string' ? approval.summary : undefined)
        ?? 'Approval requested',
      'Approval requested'
    );
    const approvalSummary = approvalDisplay.summary;
    if (isSuppressedApprovalSummary(approvalSummary)) {
      continue;
    }
    const approvalParticipantId = typeof approval.participantId === 'string' ? approval.participantId : undefined;
    const approvalResolutionKey = getTaskThreadResolutionKey(approval);
    if (
      isSuppressedApprovalIdentity(approval.approvalId, approval.taskId)
      || isSuppressedInternalApprovalNoise(approvalRecord, approval.approvalId, approval.taskId)
      || (approvalResolutionKey !== null && completedTaskKeys.has(approvalResolutionKey))
    ) {
      continue;
    }

    const participantLabels = buildParticipantLabels(approvalParticipantId, participantsById);
    const jumpTarget = approvalParticipantId ? buildParticipantJumpTarget(approvalParticipantId, participantsById) : null;

    approvalCardsById.set(approval.approvalId, {
      cardId: `approval:${approval.approvalId}`,
      resolutionKey: `approval:${approval.approvalId}`,
      kind: 'approval',
      priority: 'critical',
      summary: approvalSummary,
      actionMode: 'action',
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      decision: approval.decision ?? 'pending',
      actions: buildApprovalActions(approvalRecord),
      ...buildApprovalPresentation(approvalSummary, approvalRecord, approvalBody, approvalDisplay.detailText),
      participantId: approvalParticipantId,
      ...participantLabels,
      jumpTarget,
    } satisfies ActivityCardApprovalProjection);
  }

  for (const event of seed.events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const body = readPayloadBody(payload);
    const participantId = resolveEventParticipantId(event, payload);
    const participantLabels = buildParticipantLabels(participantId, participantsById);
    const jumpTarget = participantId ? buildParticipantJumpTarget(participantId, participantsById) : null;
    const createdAtMs = parseEventCreatedAtMs(event);

    if (event.type === 'request_approval') {
      const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : null;
      const taskId = typeof event.taskId === 'string' ? event.taskId : null;
      const approvalDisplay = splitLongDisplayText(String(body?.summary ?? payload.summary ?? 'Approval requested'), 'Approval requested');
      const summary = approvalDisplay.summary;
      const approvalResolutionKey = getTaskThreadResolutionKey(event);
      if (
        isSuppressedApprovalSummary(summary)
        || isSuppressedApprovalIdentity(approvalId, taskId)
        || isSuppressedInternalApprovalNoise(payload, approvalId, taskId)
        || (approvalResolutionKey !== null && completedTaskKeys.has(approvalResolutionKey))
      ) {
        continue;
      }

      if (approvalId && taskId && !resolvedApprovalIds.has(approvalId) && !approvalCardsById.has(approvalId)) {
        approvalCardsById.set(approvalId, {
          cardId: `approval:${approvalId}`,
          resolutionKey: `approval:${approvalId}`,
          kind: 'approval',
          priority: 'critical',
          summary,
          actionMode: 'action',
          approvalId,
          taskId,
          decision: 'pending',
          actions: buildApprovalActions(payload),
          ...buildApprovalPresentation(summary, payload, body, approvalDisplay.detailText),
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

    const questionPayload = buildQuestionPayload(payload);

    if (event.type === 'ask_clarification' && isSingleSelectQuestionPayload(questionPayload)) {
      const questionIdentity = getQuestionIdentity(payload, event.id);
      const coarseQuestionKey = getTaskThreadResolutionKey(event);
      if ((questionResolutionEventIdByKey.get(questionIdentity) ?? 0) > event.id) {
        continue;
      }

      if (
        questionIdentity === `question:${event.id}`
        && (questionResolutionEventIdByKey.get(coarseQuestionKey ?? '') ?? 0) > event.id
      ) {
        continue;
      }

      const questionId = questionIdentity;
      const summary = normalizeDisplayText(String(questionPayload.summary ?? questionPayload.prompt ?? 'Clarification requested'))
        ?? 'Clarification requested';
      const prompt = normalizeDisplayText(String(questionPayload.prompt ?? questionPayload.summary ?? 'Clarification requested'))
        ?? 'Clarification requested';

      questionCards.push({
        cardId: `question:${event.id}`,
        questionId,
        resolutionKey: questionIdentity,
        kind: 'question',
        priority: 'attention',
        summary,
        prompt,
        createdAtMs,
        detailText: normalizeDisplayText(readStringValue(questionPayload, ['detailText', 'detail', 'description', 'context'])),
        selectionMode: 'single-select',
        options: toQuestionOptions(questionPayload.options),
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
      const completionText = normalizeDisplayText(String(body?.summary ?? payload.summary ?? payload.message ?? 'Completed')) ?? 'Completed';
      const completionDisplay = splitLongDisplayText(completionText, 'Completed');
      completionCards.push({
        cardId: `completion:${event.id}`,
        resolutionKey: getCompletionResolutionKey(event),
        kind: 'completion',
        priority: 'ambient',
        summary: completionDisplay.summary,
        detailText: completionDisplay.detailText,
        createdAtMs,
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
