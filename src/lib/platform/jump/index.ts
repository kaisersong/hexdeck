import type { JumpResult, JumpTarget } from '../../jump/types';
import { jumpWithGhostty } from './mac/ghostty';
import { jumpWithIterm } from './mac/iterm';
import { jumpWithTerminalApp } from './mac/terminal-app';

interface JumpAdapters {
  ghostty?: typeof jumpWithGhostty;
  iterm?: typeof jumpWithIterm;
  terminalApp?: typeof jumpWithTerminalApp;
}

export async function jumpToTarget(
  target: JumpTarget,
  adapters: JumpAdapters = {}
): Promise<JumpResult> {
  const ghostty = adapters.ghostty ?? jumpWithGhostty;
  const iterm = adapters.iterm ?? jumpWithIterm;
  const terminalApp = adapters.terminalApp ?? jumpWithTerminalApp;

  if (target.terminalApp === 'Ghostty') {
    return ghostty(target);
  }

  if (target.terminalApp === 'iTerm') {
    return iterm(target);
  }

  if (target.terminalApp === 'Terminal.app') {
    return terminalApp(target);
  }

  return {
    ok: false,
    precision: 'unsupported',
    reason: 'unsupported_terminal',
  };
}
