export interface LocalSettings {
  brokerUrl: string;
  globalShortcut: string;
  currentProject: string;
  recentProjects: string[];
}

const DEFAULT_BROKER_URL = 'http://127.0.0.1:4318';
const DEFAULT_GLOBAL_SHORTCUT = 'CmdOrCtrl+Shift+H';
const DEFAULT_PROJECT = 'intent-broker';

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

function readStoredArray(key: string): string[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function loadLocalSettings(): LocalSettings {
  return {
    brokerUrl: readStoredValue('hexdeck.brokerUrl') ?? DEFAULT_BROKER_URL,
    globalShortcut: readStoredValue('hexdeck.shortcut') ?? DEFAULT_GLOBAL_SHORTCUT,
    currentProject: readStoredValue('hexdeck.currentProject') ?? DEFAULT_PROJECT,
    recentProjects: readStoredArray('hexdeck.recentProjects'),
  };
}

export function saveCurrentProject(project: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem('hexdeck.currentProject', project);

    // Update recent projects list
    const recent = readStoredArray('hexdeck.recentProjects');
    const updated = [project, ...recent.filter((p) => p !== project)].slice(0, 5);
    window.localStorage.setItem('hexdeck.recentProjects', JSON.stringify(updated));
  } catch {
    // Ignore storage errors
  }
}
