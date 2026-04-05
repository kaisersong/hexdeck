import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import type { UpdateStatus, UpdateEventCallback } from './types';

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

export async function checkHexDeckUpdate(
  onEvent: UpdateEventCallback
): Promise<void> {
  onEvent({ ...initialStatus, checking: true });

  try {
    const update = await check();

    if (!update) {
      onEvent(initialStatus);
      return;
    }

    onEvent({
      ...initialStatus,
      available: true,
      version: update.version,
      releaseNotes: update.body ?? null,
    });
  } catch (err) {
    onEvent({
      ...initialStatus,
      error: String(err),
    });
  }
}

export async function downloadAndInstallHexDeckUpdate(
  onEvent: UpdateEventCallback
): Promise<void> {
  onEvent({ ...initialStatus, available: true, downloading: true });

  try {
    const update = await check();
    if (!update) {
      onEvent({ ...initialStatus, error: 'No update available' });
      return;
    }

    let downloaded = 0;
    let contentLength = 0;

    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          contentLength = event.data.contentLength ?? 0;
          onEvent({
            ...initialStatus,
            available: true,
            downloading: true,
            version: update.version,
            releaseNotes: update.body ?? null,
            progress: { downloaded: 0, total: contentLength },
          });
          break;
        case 'Progress':
          downloaded += event.data.chunkLength;
          onEvent({
            ...initialStatus,
            available: true,
            downloading: true,
            version: update.version,
            releaseNotes: update.body ?? null,
            progress: { downloaded, total: contentLength },
          });
          break;
        case 'Finished':
          onEvent({
            ...initialStatus,
            available: true,
            downloading: false,
            downloaded: true,
            version: update.version,
            releaseNotes: update.body ?? null,
            progress: { downloaded: contentLength, total: contentLength },
          });
          break;
      }
    });

    await relaunch();
  } catch (err) {
    onEvent({
      ...initialStatus,
      error: String(err),
    });
  }
}