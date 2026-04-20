import type { BrokerEvent } from '../broker/types';
import { classifyEventPriority } from './priorities';
import type { RecentItemProjection } from './types';

function extractSummary(event: BrokerEvent): string {
  const payload = event.payload;
  const body = payload?.body;

  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const bodyRecord = body as Record<string, unknown>;
    if (typeof bodyRecord.summary === 'string') {
      return bodyRecord.summary;
    }
  }

  if (typeof payload?.summary === 'string') {
    return payload.summary;
  }

  if (typeof payload?.message === 'string') {
    return payload.message;
  }

  if (typeof payload?.prompt === 'string') {
    return payload.prompt;
  }

  return event.type;
}

function extractActorLabel(event: BrokerEvent): string | undefined {
  if (typeof event.fromAlias === 'string' && event.fromAlias.trim()) {
    return `@${event.fromAlias.trim()}`;
  }

  const participantId = typeof event.payload?.participantId === 'string'
    ? event.payload.participantId
    : event.fromParticipantId;

  return participantId ? `@${participantId}` : undefined;
}

function extractProjectLabel(event: BrokerEvent): string | undefined {
  if (typeof event.fromProjectName === 'string' && event.fromProjectName.trim()) {
    return event.fromProjectName.trim();
  }

  const projectName = event.payload?.projectName;
  return typeof projectName === 'string' && projectName.trim() ? projectName.trim() : undefined;
}

function isInternalApprovalNoise(event: BrokerEvent): boolean {
  const delivery = event.payload?.delivery;
  const approvalId = event.payload?.approvalId;
  const nativeCodexApproval = event.payload?.nativeCodexApproval;
  const nativeHookApproval = event.payload?.nativeHookApproval;

  if (delivery && typeof delivery === 'object' && !Array.isArray(delivery)) {
    const deliveryRecord = delivery as Record<string, unknown>;
    if (deliveryRecord.source === 'codex-hook-approval' || deliveryRecord.source === 'codex-native-approval') {
      return true;
    }
  }

  if (
    (nativeCodexApproval && typeof nativeCodexApproval === 'object')
    || (nativeHookApproval && typeof nativeHookApproval === 'object')
  ) {
    return true;
  }

  if (typeof approvalId === 'string' && (approvalId.startsWith('codex-hook-') || approvalId.startsWith('codex-native-call_'))) {
    return true;
  }

  return typeof event.taskId === 'string'
    && (event.taskId.startsWith('codex-hook-approval-') || event.taskId.startsWith('codex-native-call_'));
}

export function buildRecentFeed(events: BrokerEvent[]): RecentItemProjection[] {
  const items: RecentItemProjection[] = [];
  let lastSignature = '';

  for (const event of events) {
    if (isInternalApprovalNoise(event)) {
      continue;
    }

    const summary = extractSummary(event);
    const actorLabel = extractActorLabel(event);
    const projectLabel = extractProjectLabel(event);
    const signature = `${event.type}:${actorLabel ?? ''}:${projectLabel ?? ''}:${summary}`;

    if (signature === lastSignature && classifyEventPriority(event) === 'ambient') {
      continue;
    }

    lastSignature = signature;
    items.push({
      id: event.id,
      summary,
      priority: classifyEventPriority(event),
      actorLabel,
      projectLabel,
    });
  }

  return items.slice(-8);
}
