import { useEffect, useState } from 'react';
import packageJson from '../../../package.json';
import {
  getBrokerChannelSettings,
  saveBrokerChannelSettings,
  type BrokerChannelSettings,
} from '../../lib/broker/channels';
import type { BrokerRuntimeStatus } from '../../lib/broker/runtime';
import { checkHexDeckUpdate, downloadAndInstallHexDeckUpdate } from '../../lib/update/hexdeck-updater';
import type { UpdateStatus } from '../../lib/update/types';

const HEXDECK_VERSION = packageJson.version;
const CHANNEL_DEFINITIONS = [
  { key: 'yunzhijia', label: '云之家', urlField: 'sendUrl', adapterReady: true },
  { key: 'feishu', label: '飞书', urlField: 'webhookUrl', adapterReady: false },
  { key: 'dingtalk', label: '钉钉', urlField: 'webhookUrl', adapterReady: false },
] as const;

type ChannelKey = (typeof CHANNEL_DEFINITIONS)[number]['key'];

interface ChannelDraft {
  enabled: boolean;
  webhookUrl: string;
}

function emptyChannelDrafts(): Record<ChannelKey, ChannelDraft> {
  return CHANNEL_DEFINITIONS.reduce(
    (drafts, channel) => ({
      ...drafts,
      [channel.key]: { enabled: false, webhookUrl: '' },
    }),
    {} as Record<ChannelKey, ChannelDraft>
  );
}

function draftsFromSettings(settings: BrokerChannelSettings): Record<ChannelKey, ChannelDraft> {
  return CHANNEL_DEFINITIONS.reduce((drafts, channel) => {
    const config = settings.channels[channel.key];
    const configuredUrl = channel.urlField === 'sendUrl' ? config?.sendUrl : config?.webhookUrl;
    drafts[channel.key] = {
      enabled: Boolean(config?.enabled),
      webhookUrl: typeof configuredUrl === 'string' ? configuredUrl : '',
    };
    return drafts;
  }, emptyChannelDrafts());
}

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
  onRestartBroker: () => void | Promise<void>;
}) {
  const [draftShortcut, setDraftShortcut] = useState(globalShortcut);
  const [channelSettings, setChannelSettings] = useState<BrokerChannelSettings | null>(null);
  const [channelDrafts, setChannelDrafts] = useState<Record<ChannelKey, ChannelDraft>>(emptyChannelDrafts);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [channelsSaving, setChannelsSaving] = useState(false);
  const [channelsMessage, setChannelsMessage] = useState<string | null>(null);
  const [channelsError, setChannelsError] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    setChannelsLoading(true);
    setChannelsError(null);

    void getBrokerChannelSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        setChannelSettings(settings);
        setChannelDrafts(draftsFromSettings(settings));
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setChannelsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setChannelsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const updateChannelDraft = (key: ChannelKey, next: Partial<ChannelDraft>) => {
    setChannelDrafts((drafts) => ({
      ...drafts,
      [key]: {
        ...drafts[key],
        ...next,
      },
    }));
  };

  const saveChannels = async () => {
    const baseChannels = channelSettings?.channels ?? {};
    const nextChannels = { ...baseChannels };

    for (const channel of CHANNEL_DEFINITIONS) {
      const draft = channelDrafts[channel.key];
      const previous = baseChannels[channel.key] ?? { enabled: false };
      nextChannels[channel.key] = {
        ...previous,
        enabled: draft.enabled,
        [channel.urlField]: draft.webhookUrl.trim(),
      };
    }

    setChannelsSaving(true);
    setChannelsMessage(null);
    setChannelsError(null);

    try {
      const saved = await saveBrokerChannelSettings(nextChannels);
      setChannelSettings(saved);
      setChannelDrafts(draftsFromSettings(saved));
      await onRestartBroker();
      setChannelsMessage('Saved channel settings and restarted broker');
    } catch (error) {
      setChannelsError(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelsSaving(false);
    }
  };

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
        <h2>Notification Channels</h2>
        <div className="settings-form settings-channel-form">
          {channelsLoading ? <p className="update-checking">Loading channel settings...</p> : null}
          {!channelsLoading && !channelSettings?.installed ? (
            <p className="update-warning">Broker is not installed yet.</p>
          ) : null}
          {CHANNEL_DEFINITIONS.map((channel) => {
            const draft = channelDrafts[channel.key];
            return (
              <div className="settings-channel-row" key={channel.key}>
                <div className="settings-channel-header">
                  <label className="settings-channel-toggle">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      disabled={channelsLoading || channelsSaving}
                      onChange={(event) => updateChannelDraft(channel.key, { enabled: event.target.checked })}
                    />
                    <span>{channel.label}</span>
                  </label>
                  <span className={channel.adapterReady ? 'settings-channel-badge' : 'settings-channel-badge muted'}>
                    {channel.adapterReady ? 'Ready' : 'Adapter pending'}
                  </span>
                </div>
                <label className="settings-field">
                  <span>Webhook URL</span>
                  <input
                    className="project-input"
                    value={draft.webhookUrl}
                    disabled={channelsLoading || channelsSaving}
                    onChange={(event) => updateChannelDraft(channel.key, { webhookUrl: event.target.value })}
                    placeholder="https://..."
                  />
                </label>
              </div>
            );
          })}
          <div className="settings-actions settings-actions--spread">
            <button
              type="button"
              className="update-install-btn"
              disabled={channelsLoading || channelsSaving || channelSettings?.installed === false}
              onClick={() => void saveChannels()}
            >
              {channelsSaving ? 'Saving...' : 'Save and Restart Broker'}
            </button>
            {channelSettings?.configPath ? (
              <span className="settings-channel-path">{channelSettings.configPath}</span>
            ) : null}
          </div>
          {channelsMessage ? <p className="update-uptodate">{channelsMessage}</p> : null}
          {channelsError ? <p className="update-error">Error: {channelsError}</p> : null}
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
