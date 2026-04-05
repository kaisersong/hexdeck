import type { JumpTarget } from '../../lib/jump/types';
import type { ProjectSnapshotProjection } from '../../lib/projections/types';
import { AttentionList } from '../../features/attention/AttentionList';
import { NowList } from '../../features/now/NowList';
import { OverviewBar } from '../../features/overview/OverviewBar';
import { RecentList } from '../../features/recent/RecentList';

export function PanelRoute({
  snapshot,
  onJump,
  pendingApprovalIds,
  onApprove,
  onDeny,
}: {
  snapshot: ProjectSnapshotProjection;
  onJump?: (target: JumpTarget) => void;
  pendingApprovalIds?: Set<string>;
  onApprove?: (approvalId: string, taskId?: string) => void;
  onDeny?: (approvalId: string, taskId?: string) => void;
}) {
  return (
    <div className="panel-shell">
      <OverviewBar overview={snapshot.overview} />
      <div className="panel-grid">
        <NowList items={snapshot.now} onJump={onJump} />
        <AttentionList
          items={snapshot.attention}
          pendingApprovalIds={pendingApprovalIds}
          onApprove={onApprove}
          onDeny={onDeny}
        />
        <RecentList items={snapshot.recent} />
      </div>
    </div>
  );
}
