import { getCurrentWindow } from '@tauri-apps/api/window';

export async function startWindowDragging(
  target: EventTarget | null,
  currentTarget: EventTarget | null
): Promise<void> {
  if (target instanceof HTMLElement && target.closest('button, input, textarea, select, a, summary')) {
    return;
  }

  if (!(currentTarget instanceof HTMLElement)) {
    return;
  }

  try {
    await getCurrentWindow().startDragging();
  } catch {
    // Ignore outside Tauri.
  }
}
