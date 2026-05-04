import { dedupeActivelyPresentParticipants, isParticipantActivelyPresent } from '../broker/liveness';
import type { ProjectSeed } from '../broker/types';
import { buildJumpTarget } from '../jump/targets';
import { buildRecentFeed } from './recent-feed';
import type {
  AgentCardProjection,
  AttentionItemProjection,
  ProjectSnapshotProjection
} from './types';

function resolveApprovalEventParticipantId(
  event: ProjectSeed['events'][number],
  payload: Record<string, unknown>
): string | null {
  if (typeof payload.participantId === 'string' && payload.participantId.trim()) {
    return payload.participantId.trim();
  }

  if (typeof event.fromParticipantId === 'string' && event.fromParticipantId.trim()) {
    return event.fromParticipantId.trim();
  }

  return null;
}

function derivePendingApprovals(
  seed: ProjectSeed,
  participantIds: ReadonlySet<string>
): ProjectSeed['approvals'] {
  const pendingById = new Map<string, ProjectSeed['approvals'][number]>();

  for (const approval of seed.approvals) {
    if ((approval.decision ?? 'pending') === 'pending') {
      pendingById.set(approval.approvalId, approval);
    }
  }

  for (const event of seed.events) {
    const payload = event.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      continue;
    }

    if (event.type === 'request_approval') {
      const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : null;
      const taskId = typeof event.taskId === 'string' ? event.taskId : null;
      const participantId = resolveApprovalEventParticipantId(event, payload);
      if (
        !approvalId
        || !taskId
        || pendingById.has(approvalId)
        || !participantId
        || !participantIds.has(participantId)
      ) {
        continue;
      }

      const body = payload.body && typeof payload.body === 'object' && !Array.isArray(payload.body)
        ? payload.body as Record<string, unknown>
        : null;
      const summary = typeof body?.summary === 'string' && body.summary.trim()
        ? body.summary.trim()
        : typeof payload.summary === 'string' && payload.summary.trim()
          ? payload.summary.trim()
          : 'Approval requested';

      pendingById.set(approvalId, {
        approvalId,
        taskId,
        threadId: typeof event.threadId === 'string' ? event.threadId : undefined,
        createdAt: typeof event.createdAt === 'string' ? event.createdAt : undefined,
        summary,
        decision: 'pending',
        participantId,
        body: body ?? payload,
      });
      continue;
    }

    if (event.type === 'respond_approval') {
      const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : null;
      if (approvalId) {
        pendingById.delete(approvalId);
      }
    }
  }

  return [...pendingById.values()];
}

export function buildProjectSnapshot(seed: ProjectSeed): ProjectSnapshotProjection {
  const participantIds = new Set(seed.participants.map((participant) => participant.participantId));
  const workStateParticipantIds = new Set(seed.workStates.map((workState) => workState.participantId));
  const cliParticipants = seed.participants.filter((participant) => {
    const source = (participant as { metadata?: Record<string, unknown> }).metadata?.source;
    return source === undefined || source === null || source === 'cli';
  });
  const dedupedParticipants = dedupeActivelyPresentParticipants(cliParticipants, workStateParticipantIds);
  const byParticipant = new Map(dedupedParticipants.map((participant) => [participant.participantId, participant]));
  const agentParticipants = dedupedParticipants.filter(
    (participant) => participant.kind !== 'human' && participant.kind !== 'adapter'
  );
  const agentParticipantIds = new Set(agentParticipants.map((participant) => participant.participantId));
  const onlineAgentCount = agentParticipants.filter((participant) =>
    isParticipantActivelyPresent(participant, workStateParticipantIds)
  ).length;

  const buildParticipantJumpTarget = (participantId: string) => {
    const participant = byParticipant.get(participantId);
    const metadata = (participant as { metadata?: Record<string, unknown> } | undefined)?.metadata;

    return buildJumpTarget({
      participantId,
      alias: participant?.alias ?? participantId,
      toolLabel: participant?.tool ?? 'agent',
      terminalApp: String(metadata?.terminalApp ?? 'unknown'),
      sessionHint: typeof metadata?.sessionHint === 'string' ? metadata.sessionHint : null,
      terminalTTY: typeof metadata?.terminalTTY === 'string'
        ? metadata.terminalTTY
        : typeof metadata?.sessionHint === 'string' && metadata?.terminalApp === 'Terminal.app'
          ? metadata.sessionHint
          : null,
      terminalSessionID: typeof metadata?.terminalSessionID === 'string'
        ? metadata.terminalSessionID
        : null,
      projectPath: typeof metadata?.projectPath === 'string' ? metadata.projectPath : null,
    });
  };

  const now: AgentCardProjection[] = seed.workStates
    .filter((workState) => agentParticipantIds.has(workState.participantId) || !byParticipant.has(workState.participantId))
    .slice(0, 5)
    .map((workState) => {
    const participant = byParticipant.get(workState.participantId);
    const jumpTarget = buildParticipantJumpTarget(workState.participantId);

    return {
      participantId: workState.participantId,
      alias: participant?.alias ?? workState.participantId,
      toolLabel: participant?.tool ?? 'agent',
      projectName: participant?.context?.projectName ?? workState.projectName ?? undefined,
      workState: workState.status,
      summary: workState.summary ?? workState.status,
      updatedAtLabel: workState.updatedAt ?? 'just now',
      jumpPrecision: jumpTarget.precision,
      jumpTarget,
    };
    });

  const attention: AttentionItemProjection[] = [];
  const pendingApprovals = derivePendingApprovals(seed, participantIds);
  for (const workState of seed.workStates) {
    if (byParticipant.has(workState.participantId) && !agentParticipantIds.has(workState.participantId)) {
      continue;
    }
    if (workState.status === 'blocked') {
      const participant = byParticipant.get(workState.participantId);
      attention.push({
        kind: 'blocked',
        priority: 'critical',
        summary: workState.summary ?? `${workState.participantId} is blocked`,
        actorLabel: participant ? `@${participant.alias}` : undefined,
        jumpTarget: buildParticipantJumpTarget(workState.participantId),
      });
    }
  }
  for (const approval of pendingApprovals) {
    attention.push({
      kind: 'approval',
      priority: 'critical',
      summary: approval.summary ?? 'Approval requested',
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      approvalDecision: approval.decision ?? 'pending',
    });
  }

  return {
    overview: {
      brokerHealthy: seed.health.ok,
      onlineCount: onlineAgentCount,
      busyCount: seed.workStates.filter(
        (item) => item.status === 'implementing' && (agentParticipantIds.has(item.participantId) || !byParticipant.has(item.participantId))
      ).length,
      blockedCount: seed.workStates.filter(
        (item) => item.status === 'blocked' && (agentParticipantIds.has(item.participantId) || !byParticipant.has(item.participantId))
      ).length,
      pendingApprovalCount: pendingApprovals.length,
    },
    now,
    attention,
    recent: buildRecentFeed(seed.events),
  };
}
