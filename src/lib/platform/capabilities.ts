export interface CapabilityStatus {
  notifications: 'unknown' | 'ready' | 'blocked';
  globalShortcut: 'unknown' | 'ready' | 'blocked';
  jumpSupport: 'exact' | 'best_effort' | 'blocked' | 'unknown';
}

function getNotificationCapability(): CapabilityStatus['notifications'] {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'blocked';
  }

  if (Notification.permission === 'granted') {
    return 'ready';
  }

  if (Notification.permission === 'denied') {
    return 'blocked';
  }

  return 'unknown';
}

function getGlobalShortcutCapability(): CapabilityStatus['globalShortcut'] {
  if (typeof window === 'undefined') {
    return 'blocked';
  }

  return '__TAURI_INTERNALS__' in window ? 'ready' : 'unknown';
}

export function getCapabilityStatus(): CapabilityStatus {
  return {
    notifications: getNotificationCapability(),
    globalShortcut: getGlobalShortcutCapability(),
    jumpSupport: 'unknown',
  };
}
