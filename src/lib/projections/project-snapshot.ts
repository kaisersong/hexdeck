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

  const buildParticipantJumpTarget = (participantId: string) => {
    const participant = byParticipant.get(participantId);
    const metadata = (participant as { metadata?: Record<string, unknown> } | undefined)?.metadata;

    return buildJumpTarget({
      participantId,
      alias: participant?.alias ?? participantId,
      toolLabel: participant?.tool ?? 'agent',
      terminalApp: String(metadata?.terminalApp ?? 'unknown'),
      sessionHint: typeof metadata?.sessionHint === 'string' ? metadata.sessionHint : null,
      projectPath: typeof metadata?.projectPath === 'string' ? metadata.projectPath : null,
    });
  };

  const now: AgentCardProjection[] = seed.workStates.slice(0, 5).map((workState) => {
    const participant = byParticipant.get(workState.participantId);
    const jumpTarget = buildParticipantJumpTarget(workState.participantId);

    return {
      participantId: workState.participantId,
      alias: participant?.alias ?? workState.participantId,
      toolLabel: participant?.tool ?? 'agent',
      workState: workState.status,
      summary: workState.summary ?? workState.status,
      updatedAtLabel: workState.updatedAt ?? 'just now',
      jumpPrecision: jumpTarget.precision,
      jumpTarget,
    };
  });

  const attention: AttentionItemProjection[] = [];
  for (const workState of seed.workStates) {
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
      onlineCount: seed.participants.length,
      busyCount: seed.workStates.filter((item) => item.status === 'implementing').length,
      blockedCount: seed.workStates.filter((item) => item.status === 'blocked').length,
      pendingApprovalCount: seed.approvals.filter((approval) => (approval.decision ?? 'pending') === 'pending').length,
    },
    now,
    attention,
    recent: buildRecentFeed(seed.events),
  };
}
