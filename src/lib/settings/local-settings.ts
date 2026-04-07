export interface LocalSettings {
  brokerUrl: string;
  globalShortcut: string;
  currentProject: string;
  recentProjects: string[];
}

export const DEFAULT_BROKER_URL = 'http://127.0.0.1:4318';
const DEFAULT_GLOBAL_SHORTCUT = 'CmdOrCtrl+Shift+H';
export const ALL_AGENTS_PROJECT = '__all_agents__';
const DEFAULT_PROJECT = ALL_AGENTS_PROJECT;

export function formatProjectLabel(project: string): string {
  return project === ALL_AGENTS_PROJECT ? 'All agents' : project;
}

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
    brokerUrl: readStoredValue('hexdeck.brokerUrl') ?? DEFAULT_BROKER_URL,
    globalShortcut: readStoredValue('hexdeck.shortcut') ?? DEFAULT_GLOBAL_SHORTCUT,
    currentProject: readStoredValue('hexdeck.currentProject') ?? DEFAULT_PROJECT,
    recentProjects: readStoredArray('hexdeck.recentProjects').filter((project) => project !== ALL_AGENTS_PROJECT),
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
  const updatedRecentProjects =
    currentProject === ALL_AGENTS_PROJECT
      ? recent.filter((project) => project !== ALL_AGENTS_PROJECT)
      : [currentProject, ...recent.filter((project) => project !== currentProject)].slice(0, 5);

  writeStoredArray('hexdeck.recentProjects', updatedRecentProjects);

  return {
    brokerUrl,
    globalShortcut,
    currentProject,
    recentProjects: updatedRecentProjects,
  };
}

export function saveCurrentProject(project: string): LocalSettings {
  if (typeof window === 'undefined') {
    return loadLocalSettings();
  }
  return saveLocalSettings({ currentProject: project });
}
