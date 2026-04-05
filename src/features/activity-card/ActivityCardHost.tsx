import type { AttentionItemProjection } from '../../lib/projections/types';
import type { JumpTarget } from '../../lib/jump/types';

export function ActivityCardHost({
  items,
  onJump,
  pendingApprovalIds,
  onApprove,
  onDeny,
}: {
  items: AttentionItemProjection[];
  onJump?: (target: JumpTarget) => void;
  pendingApprovalIds?: Set<string>;
  onApprove?: (approvalId: string, taskId?: string) => void;
  onDeny?: (approvalId: string, taskId?: string) => void;
}) {
  const firstCritical = items.find((item) => item.priority === 'critical');

  if (!firstCritical) {
    return null;
  }

  return (
    <aside className="activity-card" aria-label="activity-card">
      <strong>Needs attention</strong>
      <p>{firstCritical.summary}</p>
      {firstCritical.kind === 'approval' && firstCritical.approvalId ? (
        <div className="stack-card__actions">
          <button
            type="button"
            className="action-button"
            disabled={pendingApprovalIds?.has(firstCritical.approvalId)}
            onClick={() => onApprove?.(firstCritical.approvalId!, firstCritical.taskId)}
            aria-label={`Approve ${firstCritical.approvalId}`}
          >
            Approve
          </button>
          <button
            type="button"
            className="action-button"
            disabled={pendingApprovalIds?.has(firstCritical.approvalId)}
            onClick={() => onDeny?.(firstCritical.approvalId!, firstCritical.taskId)}
            aria-label={`Deny ${firstCritical.approvalId}`}
          >
            Deny
          </button>
        </div>
      ) : null}
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
