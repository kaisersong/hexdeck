import type { JumpTarget } from '../../lib/jump/types';
import type { ProjectSnapshotProjection } from '../../lib/projections/types';
import { AttentionList } from '../../features/attention/AttentionList';
import { NowList } from '../../features/now/NowList';
import { OverviewBar } from '../../features/overview/OverviewBar';
import { RecentList } from '../../features/recent/RecentList';

export function PanelRoute({
  snapshot,
  onJump,
}: {
  snapshot: ProjectSnapshotProjection;
  onJump?: (target: JumpTarget) => void;
}) {
  return (
    <div className="panel-shell">
      <OverviewBar overview={snapshot.overview} />
      <div className="panel-grid">
        <NowList items={snapshot.now} onJump={onJump} />
        <AttentionList items={snapshot.attention} />
        <RecentList items={snapshot.recent} />
      </div>
    </div>
  );
}
