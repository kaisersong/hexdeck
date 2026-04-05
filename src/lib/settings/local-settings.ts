export interface LocalSettings {
  brokerUrl: string;
  globalShortcut: string;
}

const DEFAULT_BROKER_URL = 'http://127.0.0.1:4318';
const DEFAULT_GLOBAL_SHORTCUT = 'CmdOrCtrl+Shift+H';

function readStoredValue(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function loadLocalSettings(): LocalSettings {
  return {
    brokerUrl: readStoredValue('hexdeck.brokerUrl') ?? DEFAULT_BROKER_URL,
    globalShortcut: readStoredValue('hexdeck.shortcut') ?? DEFAULT_GLOBAL_SHORTCUT,
  };
}
