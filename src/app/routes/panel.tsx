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
  onOpenExpanded,
  onOpenSettings,
  onQuit,
}: {
  snapshot: ProjectSnapshotProjection;
  onJump?: (target: JumpTarget) => void;
  pendingApprovalIds?: Set<string>;
  onApprove?: (approvalId: string, taskId?: string) => void;
  onDeny?: (approvalId: string, taskId?: string) => void;
  onOpenExpanded?: () => void;
  onOpenSettings?: () => void;
  onQuit?: () => void;
}) {
  return (
    <div className="panel-content">
      <OverviewBar overview={snapshot.overview} />
      <div className="panel-sections">
        <NowList items={snapshot.now} onJump={onJump} />
        <AttentionList
          items={snapshot.attention}
          pendingApprovalIds={pendingApprovalIds}
          onApprove={onApprove}
          onDeny={onDeny}
        />
        <RecentList items={snapshot.recent} />
      </div>
      <footer className="panel-footer" aria-label="Panel summary">
        <div className="panel-footer__metrics">
          <div className="panel-footer__metric">
            <span>Agents</span>
            <strong>{snapshot.overview.onlineCount}</strong>
          </div>
          <div className="panel-footer__metric">
            <span>Broker</span>
            <strong>{snapshot.overview.brokerHealthy ? 'Healthy' : 'Degraded'}</strong>
          </div>
          <div className="panel-footer__metric">
            <span>Approvals</span>
            <strong>{snapshot.overview.pendingApprovalCount}</strong>
          </div>
        </div>
        <div className="panel-footer__actions">
          <button type="button" className="action-button" onClick={onOpenExpanded}>
            Details
          </button>
          <button type="button" className="action-button" onClick={onOpenSettings}>
            Settings
          </button>
          <button type="button" className="action-button" onClick={onQuit}>
            Quit
          </button>
        </div>
      </footer>
    </div>
  );
}
