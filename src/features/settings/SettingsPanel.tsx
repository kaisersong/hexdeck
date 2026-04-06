import { useState } from 'react';
import {
  checkHexDeckUpdate,
  downloadAndInstallHexDeckUpdate,
} from '../../lib/update/hexdeck-updater';
import {
  checkBrokerUpdate,
  downloadAndInstallBrokerUpdate,
  isBrokerRunning,
} from '../../lib/update/broker-updater';
import type { UpdateStatus } from '../../lib/update/types';

export function SettingsPanel() {
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

  const [brokerStatus, setBrokerStatus] = useState<UpdateStatus>({
    checking: false,
    available: false,
    downloading: false,
    downloaded: false,
    error: null,
    version: null,
    releaseNotes: null,
    progress: { downloaded: 0, total: null },
  });

  const handleCheckHexdeck = () => {
    void checkHexDeckUpdate(setHexdeckStatus);
  };

  const handleInstallHexdeck = () => {
    void downloadAndInstallHexDeckUpdate(setHexdeckStatus);
  };

  const handleCheckBroker = () => {
    void checkBrokerUpdate(setBrokerStatus);
  };

  const handleInstallBroker = async () => {
    if (!brokerStatus.version) return;

    const { invoke } = await import('@tauri-apps/api/core');
    try {
      const info = await invoke<{ version: string; download_url: string }>(
        'fetch_latest_broker_release'
      );
      await downloadAndInstallBrokerUpdate(
        info.version,
        info.download_url,
        setBrokerStatus
      );
    } catch (err) {
      setBrokerStatus((prev) => ({ ...prev, error: String(err) }));
    }
  };

  return (
    <div className="settings-panel">
      <section className="update-section">
        <h2>HexDeck Updates</h2>
        <UpdateStatusView
          status={hexdeckStatus}
          onCheck={handleCheckHexdeck}
          onInstall={handleInstallHexdeck}
          appName="HexDeck"
        />
      </section>

      <section className="update-section">
        <h2>Intent-Broker Kernel</h2>
        <BrokerUpdateView
          status={brokerStatus}
          onCheck={handleCheckBroker}
          onInstall={handleInstallBroker}
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
          {status.progress.total && status.progress.total > 0 && (
            <progress
              value={status.progress.downloaded}
              max={status.progress.total}
            />
          )}
        </div>
      )}

      {status.downloaded && <p className="update-complete">Update installed. Restarting...</p>}

      {status.error && <p className="update-error">Error: {status.error}</p>}

      <button
        className="update-check-btn"
        onClick={onCheck}
        disabled={status.checking || status.downloading}
      >
        Check for Updates
      </button>
    </div>
  );
}

function BrokerUpdateView({
  status,
  onCheck,
  onInstall,
}: {
  status: UpdateStatus;
  onCheck: () => void;
  onInstall: () => void;
}) {
  const [brokerRunning, setBrokerRunning] = useState<boolean | null>(null);

  const checkRunning = async () => {
    const running = await isBrokerRunning();
    setBrokerRunning(running);
  };

  return (
    <div className="update-status">
      {status.checking && <p className="update-checking">Checking for updates...</p>}

      {!status.checking && !status.available && !status.error && (
        <p className="update-uptodate">Intent-Broker is up to date</p>
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
          {brokerRunning && (
            <p className="update-warning">
              Warning: Broker is running. Please restart it after update.
            </p>
          )}
          <button className="update-install-btn" onClick={onInstall}>
            Download and Install
          </button>
        </div>
      )}

      {status.downloading && (
        <div className="download-progress">
          <p>Downloading...</p>
        </div>
      )}

      {status.downloaded && (
        <div className="update-complete">
          <p>Intent-Broker updated successfully.</p>
          {brokerRunning && (
            <p className="update-warning">Please restart the broker manually.</p>
          )}
        </div>
      )}

      {status.error && <p className="update-error">Error: {status.error}</p>}

      <div className="update-actions">
        <button
          className="update-check-btn"
          onClick={() => {
            void onCheck();
            void checkRunning();
          }}
          disabled={status.checking || status.downloading}
        >
          Check for Updates
        </button>
      </div>
    </div>
  );
}
