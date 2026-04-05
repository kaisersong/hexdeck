import type { ProjectSeed } from '../broker/types';
import { buildRecentFeed } from './recent-feed';
import type {
  AgentCardProjection,
  AttentionItemProjection,
  ProjectSnapshotProjection
} from './types';

export function buildProjectSnapshot(seed: ProjectSeed): ProjectSnapshotProjection {
  const byParticipant = new Map(seed.participants.map((participant) => [participant.participantId, participant]));

  const now: AgentCardProjection[] = seed.workStates.slice(0, 5).map((workState) => {
    const participant = byParticipant.get(workState.participantId);
    return {
      participantId: workState.participantId,
      alias: participant?.alias ?? workState.participantId,
      toolLabel: participant?.tool ?? 'agent',
      workState: workState.status,
      summary: workState.summary ?? workState.status,
      updatedAtLabel: workState.updatedAt ?? 'just now',
    };
  });

  const attention: AttentionItemProjection[] = [];
  for (const workState of seed.workStates) {
    if (workState.status === 'blocked') {
      attention.push({
        kind: 'blocked',
        priority: 'critical',
        summary: workState.summary ?? `${workState.participantId} is blocked`,
      });
    }
  }
  for (const event of seed.events) {
    if (event.type === 'request_approval') {
      attention.push({
        kind: 'approval',
        priority: 'critical',
        summary: String(event.payload?.summary ?? 'Approval requested'),
      });
    }
  }

  return {
    overview: {
      brokerHealthy: seed.health.ok,
      onlineCount: seed.participants.length,
      busyCount: seed.workStates.filter((item) => item.status === 'implementing').length,
      blockedCount: seed.workStates.filter((item) => item.status === 'blocked').length,
      pendingApprovalCount: seed.events.filter((event) => event.type === 'request_approval').length,
    },
    now,
    attention,
    recent: buildRecentFeed(seed.events),
  };
}
