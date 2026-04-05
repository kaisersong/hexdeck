import type { AttentionItemProjection } from '../../lib/projections/types';

export function ActivityCardHost({ items }: { items: AttentionItemProjection[] }) {
  const firstCritical = items.find((item) => item.priority === 'critical');

  if (!firstCritical) {
    return null;
  }

  return (
    <aside className="activity-card" aria-label="activity-card">
      <strong>Needs attention</strong>
      <p>{firstCritical.summary}</p>
    </aside>
  );
}
