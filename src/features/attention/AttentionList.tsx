import type { AttentionItemProjection } from '../../lib/projections/types';

export function AttentionList({
  items,
  pendingApprovalIds,
  onApprove,
  onDeny,
}: {
  items: AttentionItemProjection[];
  pendingApprovalIds?: Set<string>;
  onApprove?: (approvalId: string, taskId?: string) => void;
  onDeny?: (approvalId: string, taskId?: string) => void;
}) {
  return (
    <section className="panel-section" aria-labelledby="queue-title">
      <div className="panel-section-header">
        <div>
          <h2 id="queue-title">Queue</h2>
          <p className="section-kicker">Items that still need explicit human attention</p>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="empty-state">Nothing needs attention right now.</p>
      ) : (
        <ul className="stack-list">
          {items.map((item, index) => (
            <li key={`${item.kind}-${index}`} className={`stack-card stack-card--${item.priority}`}>
              <span className="stack-card__badge">{item.kind}</span>
              <p className="stack-card__summary">{item.summary}</p>
              {item.kind === 'approval' && item.approvalId ? (
                <div className="stack-card__actions">
                  <button
                    type="button"
                    className="action-button"
                    disabled={pendingApprovalIds?.has(item.approvalId)}
                    onClick={() => onApprove?.(item.approvalId!, item.taskId)}
                    aria-label={`Approve ${item.approvalId}`}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="action-button"
                    disabled={pendingApprovalIds?.has(item.approvalId)}
                    onClick={() => onDeny?.(item.approvalId!, item.taskId)}
                    aria-label={`Deny ${item.approvalId}`}
                  >
                    Deny
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
