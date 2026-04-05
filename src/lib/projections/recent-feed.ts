import type { BrokerEvent } from '../broker/types';
import { classifyEventPriority } from './priorities';
import type { RecentItemProjection } from './types';

export function buildRecentFeed(events: BrokerEvent[]): RecentItemProjection[] {
  const items: RecentItemProjection[] = [];
  let lastSignature = '';

  for (const event of events) {
    const summary = String(event.payload?.summary ?? event.type);
    const signature = `${event.type}:${summary}`;
    if (signature === lastSignature && classifyEventPriority(event) === 'ambient') continue;
    lastSignature = signature;
    items.push({
      id: event.id,
      summary,
      priority: classifyEventPriority(event),
    });
  }

  return items.slice(-8);
}
