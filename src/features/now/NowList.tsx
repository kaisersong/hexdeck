import type { AgentCardProjection } from '../../lib/projections/types';
import type { JumpTarget } from '../../lib/jump/types';

export function NowList({
  items,
  onJump,
}: {
  items: AgentCardProjection[];
  onJump?: (target: JumpTarget) => void;
}) {
  return (
    <section className="panel-section" aria-labelledby="now-title">
      <div className="panel-section-header">
        <h2 id="now-title">Now</h2>
      </div>
      {items.length === 0 ? (
        <p className="empty-state">No active agent cards yet.</p>
      ) : (
        <ul className="stack-list">
          {items.map((item) => (
            <li key={item.participantId} className="stack-card">
              <div className="stack-card__topline">
                <strong>@{item.alias}</strong>
                <span>{item.toolLabel}</span>
              </div>
              <p className="stack-card__summary">{item.summary}</p>
              <p className="stack-card__meta">
                <span>{item.workState}</span>
                <span>{item.updatedAtLabel}</span>
                {item.jumpPrecision ? <span>Jump: {item.jumpPrecision}</span> : null}
              </p>
              {item.jumpTarget && item.jumpPrecision !== 'unsupported' ? (
                <div className="stack-card__actions">
                  <button
                    type="button"
                    className="action-button"
                    onClick={() => onJump?.(item.jumpTarget!)}
                    aria-label={`Jump to @${item.alias}`}
                  >
                    Jump
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
