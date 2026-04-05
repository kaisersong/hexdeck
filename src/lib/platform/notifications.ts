export function notifyCritical(summary: string): void {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return;
  }

  if (Notification.permission !== 'granted') {
    return;
  }

  new Notification('HexDeck', { body: summary });
}
