import type { JumpResult, JumpTarget } from '../../jump/types';
import { invoke } from '@tauri-apps/api/core';
import { jumpWithGhostty } from './mac/ghostty';
import { jumpWithIterm } from './mac/iterm';
import { jumpWithTerminalApp } from './mac/terminal-app';

interface JumpAdapters {
  ghostty?: typeof jumpWithGhostty;
  iterm?: typeof jumpWithIterm;
  terminalApp?: typeof jumpWithTerminalApp;
  openProjectPath?: (projectPath: string) => Promise<void>;
}

async function openProjectPathFallback(projectPath: string): Promise<void> {
  await invoke('open_project_path', { projectPath });
}

export async function jumpToTarget(
  target: JumpTarget,
  adapters: JumpAdapters = {}
): Promise<JumpResult> {
  const ghostty = adapters.ghostty ?? jumpWithGhostty;
  const iterm = adapters.iterm ?? jumpWithIterm;
  const terminalApp = adapters.terminalApp ?? jumpWithTerminalApp;
  const openProjectPath = adapters.openProjectPath ?? openProjectPathFallback;

  if (target.terminalApp === 'Ghostty') {
    return ghostty(target);
  }

  if (target.terminalApp === 'iTerm') {
    return iterm(target);
  }

  if (target.terminalApp === 'Terminal.app') {
    return terminalApp(target);
  }

  if (target.projectPath) {
    try {
      await openProjectPath(target.projectPath);
      return {
        ok: true,
        precision: 'best_effort',
      };
    } catch {
      return {
        ok: false,
        precision: 'best_effort',
        reason: 'project_path_open_failed',
      };
    }
  }

  return {
    ok: false,
    precision: 'unsupported',
    reason: 'unsupported_terminal',
  };
}
