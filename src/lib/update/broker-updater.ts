import { invoke } from '@tauri-apps/api/core';
import type {
  UpdateStatus,
  UpdateEventCallback,
  BrokerVersionInfo,
  BrokerStartResult,
} from './types';

const initialStatus: UpdateStatus = {
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  error: null,
  version: null,
  releaseNotes: null,
  progress: { downloaded: 0, total: null },
};

export async function checkBrokerUpdate(
  onEvent: UpdateEventCallback
): Promise<void> {
  onEvent({ ...initialStatus, checking: true });

  try {
    const installedVersion = await invoke<string | null>('get_installed_broker_version');
    const latestRelease = await invoke<BrokerVersionInfo>('fetch_latest_broker_release');

    const isUpdateAvailable = installedVersion !== latestRelease.version;

    onEvent({
      ...initialStatus,
      available: isUpdateAvailable,
      version: latestRelease.version,
      releaseNotes: latestRelease.release_notes,
    });
  } catch (err) {
    onEvent({
      ...initialStatus,
      error: String(err),
    });
  }
}

export async function downloadAndInstallBrokerUpdate(
  version: string,
  downloadUrl: string,
  onEvent: UpdateEventCallback
): Promise<void> {
  onEvent({
    ...initialStatus,
    available: true,
    downloading: true,
    version,
  });

  try {
    const installedPath = await invoke<string>('install_broker_update', {
      downloadUrl,
      version,
    });

    onEvent({
      ...initialStatus,
      available: true,
      downloading: false,
      downloaded: true,
      version,
      progress: { downloaded: 100, total: 100 },
    });

    return;
  } catch (err) {
    onEvent({
      ...initialStatus,
      error: String(err),
    });
  }
}

export async function getInstalledBrokerVersion(): Promise<string | null> {
  try {
    return await invoke<string | null>('get_installed_broker_version');
  } catch {
    return null;
  }
}

export async function getInstalledBrokerPath(): Promise<string | null> {
  try {
    return await invoke<string | null>('get_installed_broker_path');
  } catch {
    return null;
  }
}

export async function isBrokerRunning(): Promise<boolean> {
  try {
    return await invoke<boolean>('is_broker_running');
  } catch {
    return false;
  }
}

export async function ensureBrokerReady(
  brokerUrl = 'http://127.0.0.1:4318',
  timeoutMs = 15000
): Promise<BrokerStartResult> {
  const result = await invoke<BrokerStartResult>('ensure_broker_ready', {
    brokerUrl,
    timeoutMs,
  });

  return result;
}
