import type { AttentionItemProjection } from '../../lib/projections/types';
import type { JumpTarget } from '../../lib/jump/types';

export function ActivityCardHost({
  items,
  onJump,
}: {
  items: AttentionItemProjection[];
  onJump?: (target: JumpTarget) => void;
}) {
  const firstCritical = items.find((item) => item.priority === 'critical');

  if (!firstCritical) {
    return null;
  }

  return (
    <aside className="activity-card" aria-label="activity-card">
      <strong>Needs attention</strong>
      <p>{firstCritical.summary}</p>
      {firstCritical.jumpTarget && firstCritical.actorLabel ? (
        <div className="stack-card__actions">
          <button
            type="button"
            className="action-button"
            onClick={() => onJump?.(firstCritical.jumpTarget!)}
            aria-label={`Jump to ${firstCritical.actorLabel}`}
          >
            Jump
          </button>
        </div>
      ) : null}
    </aside>
  );
}
