export async function startWindowDragging(target: EventTarget | null): Promise<void> {
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.closest('button, input, textarea, select, a, summary')) {
    return;
  }

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startDragging();
  } catch {
    // Ignore outside Tauri.
  }
}
