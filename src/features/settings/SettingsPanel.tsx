import { useEffect, useState } from 'react';
import packageJson from '../../../package.json';
import type { BrokerRuntimeStatus } from '../../lib/broker/runtime';
import { checkHexDeckUpdate, downloadAndInstallHexDeckUpdate } from '../../lib/update/hexdeck-updater';
import type { UpdateStatus } from '../../lib/update/types';

const HEXDECK_VERSION = packageJson.version;

export function SettingsPanel({
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
  onRestartBroker: () => void;
}) {
  const [draftShortcut, setDraftShortcut] = useState(globalShortcut);
  const [hexdeckStatus, setHexdeckStatus] = useState<UpdateStatus>({
    checking: false,
    available: false,
    downloading: false,
    downloaded: false,
    error: null,
    version: null,
    releaseNotes: null,
    progress: { downloaded: 0, total: null },
  });

  useEffect(() => {
    setDraftShortcut(globalShortcut);
  }, [globalShortcut]);

  return (
    <div className="settings-panel">
      <section className="update-section">
        <h2>Broker Runtime</h2>
        <div className="update-status">
          <dl className="status-grid settings-runtime-grid">
            <div className="status-item">
              <dt>Status</dt>
              <dd className="status-value">
                {runtimeStatus?.healthy
                  ? 'Healthy'
                  : runtimeStatus?.running
                    ? 'Starting'
                    : runtimeStatus?.installed
                    ? 'Installed'
                    : 'Not installed'}
              </dd>
            </div>
            <div className="status-item">
              <dt>HexDeck Version</dt>
              <dd className="status-value">{HEXDECK_VERSION}</dd>
            </div>
            <div className="status-item">
              <dt>Broker Version</dt>
              <dd className="status-value">{runtimeStatus?.version ?? 'pending'}</dd>
            </div>
          </dl>
          <div className="settings-actions settings-actions--spread">
            <button type="button" className="update-check-btn" onClick={onRefreshBroker}>
              Refresh Runtime
            </button>
            <button type="button" className="update-install-btn" onClick={onRestartBroker}>
              Restart Broker
            </button>
          </div>
          {runtimeStatus?.lastError ? <p className="update-error">Error: {runtimeStatus.lastError}</p> : null}
        </div>
      </section>

      <section className="update-section">
        <h2>HexDeck Shortcut</h2>
        <div className="settings-form">
          <div className="settings-shortcut-row">
            <label className="settings-field settings-field--grow">
              <span>Global Shortcut</span>
              <input
                className="project-input"
                value={draftShortcut}
                onChange={(event) => setDraftShortcut(event.target.value)}
                placeholder="CommandOrControl+Shift+H"
              />
            </label>
            <button
              type="button"
              className="update-install-btn settings-inline-save"
              onClick={() => onSaveSettings({ globalShortcut: draftShortcut })}
            >
              Save
            </button>
          </div>
        </div>
      </section>

      <section className="update-section">
        <h2>HexDeck Updates</h2>
        <UpdateStatusView
          status={hexdeckStatus}
          onCheck={() => void checkHexDeckUpdate(setHexdeckStatus)}
          onInstall={() => void downloadAndInstallHexDeckUpdate(setHexdeckStatus)}
          appName="HexDeck"
        />
      </section>
    </div>
  );
}

function UpdateStatusView({
  status,
  onCheck,
  onInstall,
  appName,
}: {
  status: UpdateStatus;
  onCheck: () => void;
  onInstall: () => void;
  appName: string;
}) {
  return (
    <div className="update-status">
      {status.checking && <p className="update-checking">Checking for updates...</p>}

      {!status.checking && !status.available && !status.error && (
        <p className="update-uptodate">{appName} is up to date</p>
      )}

      {status.available && !status.downloading && !status.downloaded && (
        <div className="update-available">
          <p>Update available: v{status.version}</p>
          {status.releaseNotes && (
            <details className="release-notes">
              <summary>Release Notes</summary>
              <pre>{status.releaseNotes}</pre>
            </details>
          )}
          <button className="update-install-btn" onClick={onInstall}>
            Download and Install
          </button>
        </div>
      )}

      {status.downloading && (
        <div className="download-progress">
          <p>Downloading...</p>
          {status.progress.total && status.progress.total > 0 ? (
            <progress value={status.progress.downloaded} max={status.progress.total} />
          ) : null}
        </div>
      )}

      {status.downloaded && <p className="update-complete">Update installed. Restarting...</p>}
      {status.error && <p className="update-error">Error: {status.error}</p>}

      <button className="update-check-btn" onClick={onCheck} disabled={status.checking || status.downloading}>
        Check for Updates
      </button>
    </div>
  );
}
