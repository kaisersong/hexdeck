import type { BrokerEvent } from '../broker/types';
import type { ProjectionPriority } from './types';

export function classifyEventPriority(event: BrokerEvent): ProjectionPriority {
  if (event.type === 'request_approval') return 'critical';
  if (event.type === 'participant_blocked') return 'critical';
  if (event.type === 'broker_alert') return 'critical';
  if (event.type === 'report_progress') return 'ambient';
  return 'attention';
}
