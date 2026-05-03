import { SettingsPanel } from '../../features/settings/SettingsPanel';
import type { BrokerRuntimeStatus } from '../../lib/broker/runtime';
import { startWindowDragging } from '../../lib/platform/window-controls';

export function ExpandedRoute({
  globalShortcut,
  runtimeStatus,
  onSaveSettings,
  onRefreshBroker,
  onRestartBroker,
}: {
  globalShortcut: string;
  runtimeStatus: BrokerRuntimeStatus | null;
  onSaveSettings: (input: { globalShortcut: string }) => void;
  onRefreshBroker: () => void;
  onRestartBroker: () => void | Promise<void>;
}) {
  return (
    <main className="expanded-shell">
      <header
        className="expanded-header panel-header--draggable"
        onMouseDown={(event) => void startWindowDragging(event.target, event.currentTarget)}
      >
        <div className="panel-drag-handle panel-drag-handle--expanded" aria-hidden="true" />
      </header>

      <SettingsPanel
        globalShortcut={globalShortcut}
        runtimeStatus={runtimeStatus}
        onSaveSettings={onSaveSettings}
        onRefreshBroker={onRefreshBroker}
        onRestartBroker={onRestartBroker}
      />
    </main>
  );
}
