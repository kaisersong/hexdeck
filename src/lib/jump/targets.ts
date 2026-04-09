import type { JumpTarget } from './types';

interface JumpSeed {
  participantId: string;
  alias: string;
  toolLabel: string;
  terminalApp: string;
  sessionHint: string | null;
  terminalTTY: string | null;
  terminalSessionID: string | null;
  projectPath: string | null;
}

const BEST_EFFORT_TERMINAL_APPS = new Set([
  'Terminal.app',
  'Windows Terminal',
  'WezTerm',
  'PowerShell',
  'pwsh',
  'cmd',
]);

export function buildJumpTarget(seed: JumpSeed): JumpTarget {
  // Ghostty's sessionHint may carry a compatibility alias; only terminalSessionID
  // is stable enough to qualify as an exact locator.
  const hasExactLocator = (
    (seed.terminalApp === 'Ghostty' && Boolean(seed.terminalSessionID))
    || (seed.terminalApp === 'iTerm' && Boolean(seed.sessionHint || seed.terminalTTY))
    || (seed.terminalApp === 'Terminal.app' && Boolean(seed.terminalTTY || seed.sessionHint))
  );

  const precision = hasExactLocator
    ? 'exact'
    : BEST_EFFORT_TERMINAL_APPS.has(seed.terminalApp) || Boolean(seed.projectPath)
      ? 'best_effort'
      : 'unsupported';

  return {
    participantId: seed.participantId,
    alias: seed.alias,
    terminalApp: seed.terminalApp,
    precision,
    sessionHint: seed.sessionHint,
    terminalTTY: seed.terminalTTY,
    terminalSessionID: seed.terminalSessionID,
    projectPath: seed.projectPath,
  };
}
