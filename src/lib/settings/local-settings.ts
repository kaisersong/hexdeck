export interface LocalSettings {
  brokerUrl: string;
  globalShortcut: string;
  currentProject: string;
  recentProjects: string[];
}

const DEFAULT_BROKER_URL = 'http://127.0.0.1:4318';
const DEFAULT_GLOBAL_SHORTCUT = 'CommandOrControl+Shift+H';
const DEFAULT_PROJECT = 'hexdeck';

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

function writeStoredValue(key: string, value: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors
  }
}

function writeStoredArray(key: string, value: string[]): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors
  }
}

export function loadLocalSettings(): LocalSettings {
  return {
    brokerUrl: DEFAULT_BROKER_URL,
    globalShortcut: readStoredValue('hexdeck.shortcut') ?? DEFAULT_GLOBAL_SHORTCUT,
    currentProject: readStoredValue('hexdeck.currentProject') ?? DEFAULT_PROJECT,
    recentProjects: readStoredArray('hexdeck.recentProjects'),
  };
}

export function saveLocalSettings(
  next: Partial<Pick<LocalSettings, 'globalShortcut' | 'currentProject'>>
): LocalSettings {
  const current = loadLocalSettings();
  const brokerUrl = DEFAULT_BROKER_URL;
  const globalShortcut = next.globalShortcut?.trim() || current.globalShortcut;
  const currentProject = next.currentProject?.trim() || current.currentProject;

  writeStoredValue('hexdeck.shortcut', globalShortcut);
  writeStoredValue('hexdeck.currentProject', currentProject);

  const recent = readStoredArray('hexdeck.recentProjects');
  const updatedRecentProjects = [currentProject, ...recent.filter((project) => project !== currentProject)].slice(0, 5);
  writeStoredArray('hexdeck.recentProjects', updatedRecentProjects);

  return {
    brokerUrl,
    globalShortcut,
    currentProject,
    recentProjects: updatedRecentProjects,
  };
}

export function saveCurrentProject(project: string): LocalSettings {
  return saveLocalSettings({ currentProject: project });
}
