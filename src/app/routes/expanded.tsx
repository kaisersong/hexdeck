import { ActivityCardHost } from '../../features/activity-card/ActivityCardHost';
import { SettingsPanel } from '../../features/settings/SettingsPanel';
import type { BrokerRuntimeStatus } from '../../lib/broker/runtime';
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
  currentProject,
  globalShortcut,
  connectionState,
  connectionMessage,
  runtimeStatus,
  onSaveSettings,
  onRefreshBroker,
  onRestartBroker,
  capabilities,
  pendingApprovalIds,
  onJump,
  onApprove,
  onDeny,
  onMinimize,
  onClose,
}: {
  section: ExpandedSection;
  onSectionChange: (section: ExpandedSection) => void;
  snapshot: ProjectSnapshotProjection | null;
  participants: BrokerParticipant[];
  currentProject: string;
  globalShortcut: string;
  connectionState: 'idle' | 'checking' | 'connected' | 'error';
  connectionMessage: string | null;
  runtimeStatus: BrokerRuntimeStatus | null;
  onSaveSettings: (input: { globalShortcut: string }) => void;
  onRefreshBroker: () => void;
  onRestartBroker: () => void;
  capabilities: CapabilityStatus;
  pendingApprovalIds: Set<string>;
  onJump?: (target: JumpTarget) => void;
  onApprove?: (approvalId: string, taskId?: string) => void;
  onDeny?: (approvalId: string, taskId?: string) => void;
  onMinimize: () => void;
  onClose: () => void;
}) {
  const expandedSnapshot: ProjectSnapshotProjection =
    snapshot ?? {
      overview: {
        brokerHealthy: false,
        onlineCount: participants.length,
        busyCount: 0,
        blockedCount: 0,
        pendingApprovalCount: 0,
      },
      now: [],
      attention: [],
      recent: [],
    };

  return (
    <main className="expanded-shell">
      <header
        className="expanded-header panel-header--draggable"
        onMouseDown={(event) => void startWindowDragging(event.target, event.currentTarget)}
      >
        <div className="panel-drag-handle panel-drag-handle--expanded" aria-hidden="true" />
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
          <div className="window-controls" aria-label="Window controls">
            <button
              type="button"
              className="window-control-btn"
              onClick={onMinimize}
              title="Minimize"
              aria-label="Minimize"
            >
              -
            </button>
            <button
              type="button"
              className="window-control-btn window-control-btn--close"
              onClick={onClose}
              title="Close details"
              aria-label="Close details"
            >
              x
            </button>
          </div>
        </div>
      </header>

      {section === 'settings' ? (
        <SettingsPanel
          globalShortcut={globalShortcut}
          connectionState={connectionState}
          connectionMessage={connectionMessage}
          runtimeStatus={runtimeStatus}
          onSaveSettings={onSaveSettings}
          onRefreshBroker={onRefreshBroker}
          onRestartBroker={onRestartBroker}
        />
      ) : (
        <div className="expanded-body">
          <ActivityCardHost
            items={expandedSnapshot.attention}
            onJump={onJump}
            pendingApprovalIds={pendingApprovalIds}
            onApprove={onApprove}
            onDeny={onDeny}
          />
          <PanelRoute
            snapshot={expandedSnapshot}
            participants={participants}
            currentProject={currentProject}
            onJump={onJump}
          />
        </div>
      )}
    </main>
  );
}
