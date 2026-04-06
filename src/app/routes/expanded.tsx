import { ActivityCardHost } from '../../features/activity-card/ActivityCardHost';
import { OnboardingPanel } from '../../features/onboarding/OnboardingPanel';
import { SettingsPanel } from '../../features/settings/SettingsPanel';
import type { BrokerParticipant } from '../../lib/broker/types';
import type { JumpTarget } from '../../lib/jump/types';
import type { ProjectSnapshotProjection } from '../../lib/projections/types';
import type { CapabilityStatus } from '../../lib/platform/capabilities';
import { startWindowDragging } from '../../lib/platform/window-controls';
import { PanelRoute } from './panel';

export type ExpandedSection = 'overview' | 'settings';

export function ExpandedRoute({
  section,
  onSectionChange,
  snapshot,
  participants,
  brokerUrl,
  globalShortcut,
  capabilities,
  pendingApprovalIds,
  onJump,
  onApprove,
  onDeny,
  onClose,
}: {
  section: ExpandedSection;
  onSectionChange: (section: ExpandedSection) => void;
  snapshot: ProjectSnapshotProjection | null;
  participants: BrokerParticipant[];
  brokerUrl: string;
  globalShortcut: string;
  capabilities: CapabilityStatus;
  pendingApprovalIds: Set<string>;
  onJump?: (target: JumpTarget) => void;
  onApprove?: (approvalId: string, taskId?: string) => void;
  onDeny?: (approvalId: string, taskId?: string) => void;
  onClose: () => void;
}) {
  return (
    <main className="expanded-shell">
      <header
        className="expanded-header panel-header--draggable"
        onMouseDown={(event) => void startWindowDragging(event.target)}
      >
        <div>
          <h1>HexDeck Details</h1>
          <p>Expanded workspace for deeper review and settings</p>
        </div>
        <div className="expanded-actions">
          <div className="expanded-tabs" role="tablist" aria-label="Expanded sections">
            <button
              type="button"
              className={`expanded-tab ${section === 'overview' ? 'expanded-tab--active' : ''}`}
              onClick={() => onSectionChange('overview')}
            >
              Overview
            </button>
            <button
              type="button"
              className={`expanded-tab ${section === 'settings' ? 'expanded-tab--active' : ''}`}
              onClick={() => onSectionChange('settings')}
            >
              Settings
            </button>
          </div>
          <button type="button" className="settings-btn" onClick={onClose} title="Close details">
            Close
          </button>
        </div>
      </header>

      {section === 'settings' ? (
        <SettingsPanel />
      ) : snapshot === null ? (
        <OnboardingPanel
          brokerUrl={brokerUrl}
          globalShortcut={globalShortcut}
          capabilities={capabilities}
          participants={participants}
        />
      ) : (
        <div className="expanded-body">
          <ActivityCardHost
            items={snapshot.attention}
            onJump={onJump}
            pendingApprovalIds={pendingApprovalIds}
            onApprove={onApprove}
            onDeny={onDeny}
          />
          <PanelRoute
            snapshot={snapshot}
            onJump={onJump}
            pendingApprovalIds={pendingApprovalIds}
            onApprove={onApprove}
            onDeny={onDeny}
          />
        </div>
      )}
    </main>
  );
}
