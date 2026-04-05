import type { JumpTarget } from './types';

interface JumpSeed {
  participantId: string;
  alias: string;
  toolLabel: string;
  terminalApp: string;
  sessionHint: string | null;
  projectPath: string | null;
}

const EXACT_TERMINAL_APPS = new Set(['Ghostty', 'iTerm']);
const BEST_EFFORT_TERMINAL_APPS = new Set(['Terminal.app']);

export function buildJumpTarget(seed: JumpSeed): JumpTarget {
  const precision = EXACT_TERMINAL_APPS.has(seed.terminalApp)
    ? 'exact'
    : BEST_EFFORT_TERMINAL_APPS.has(seed.terminalApp)
      ? 'best_effort'
      : 'unsupported';

  return {
    participantId: seed.participantId,
    terminalApp: seed.terminalApp,
    precision,
    sessionHint: seed.sessionHint,
    projectPath: seed.projectPath,
  };
}
