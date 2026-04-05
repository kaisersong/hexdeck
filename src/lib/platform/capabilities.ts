export interface CapabilityStatus {
  notifications: 'unknown' | 'ready' | 'blocked';
  globalShortcut: 'unknown' | 'ready' | 'blocked';
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

export function getCapabilityStatus(): CapabilityStatus {
  return {
    notifications: getNotificationCapability(),
    globalShortcut: 'unknown',
  };
}
