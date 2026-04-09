import type { ProjectSeed } from '../broker/types';
import { buildJumpTarget } from '../jump/targets';
import { buildRecentFeed } from './recent-feed';
import type {
  AgentCardProjection,
  AttentionItemProjection,
  ProjectSnapshotProjection
} from './types';

export function buildProjectSnapshot(seed: ProjectSeed): ProjectSnapshotProjection {
  const byParticipant = new Map(seed.participants.map((participant) => [participant.participantId, participant]));
  const agentParticipants = seed.participants.filter(
    (participant) => participant.kind !== 'human' && participant.kind !== 'adapter'
  );
  const agentParticipantIds = new Set(agentParticipants.map((participant) => participant.participantId));
  const workStateParticipantIds = new Set(seed.workStates.map((workState) => workState.participantId));
  const onlineAgentCount = agentParticipants.filter((participant) => {
    if (participant.presence === 'online') {
      return true;
    }

    if (participant.presence === 'offline') {
      return false;
    }

    if (workStateParticipantIds.has(participant.participantId)) {
      return true;
    }

    return false;
  }).length;

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
  for (const approval of seed.approvals) {
    if ((approval.decision ?? 'pending') === 'pending') {
      attention.push({
        kind: 'approval',
        priority: 'critical',
        summary: approval.summary ?? 'Approval requested',
        approvalId: approval.approvalId,
        taskId: approval.taskId,
        approvalDecision: approval.decision ?? 'pending',
      });
    }
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
      pendingApprovalCount: seed.approvals.filter((approval) => (approval.decision ?? 'pending') === 'pending').length,
    },
    now,
    attention,
    recent: buildRecentFeed(seed.events),
  };
}
