import { describe, expect, it, vi } from 'vitest';
import { jumpToTarget } from '../../../src/lib/platform/jump';

describe('jumpToTarget', () => {
  it('uses the Ghostty adapter for exact Ghostty targets', async () => {
    const ghostty = vi.fn().mockResolvedValue({ ok: true, precision: 'exact' });
    const iterm = vi.fn();
    const terminalApp = vi.fn();

    const result = await jumpToTarget(
      {
        participantId: 'a',
        alias: 'codex4',
        terminalApp: 'Ghostty',
        precision: 'exact',
        sessionHint: 'ghostty-tab-1',
        terminalTTY: '/dev/ttys003',
        terminalSessionID: 'ghostty-tab-1',
        projectPath: '/repo',
      },
      {
        ghostty,
        iterm,
        terminalApp,
      }
    );

    expect(result).toEqual({ ok: true, precision: 'exact' });
    expect(ghostty).toHaveBeenCalledOnce();
    expect(iterm).not.toHaveBeenCalled();
    expect(terminalApp).not.toHaveBeenCalled();
  });

  it('returns the Ghostty adapter result directly when an exact match is unavailable', async () => {
    const ghostty = vi.fn().mockResolvedValue({ ok: false, precision: 'best_effort' });

    const result = await jumpToTarget(
      {
        participantId: 'a',
        alias: 'codex2',
        terminalApp: 'Ghostty',
        precision: 'exact',
        sessionHint: 'ghostty-terminal-2',
        terminalTTY: '/dev/ttys005',
        terminalSessionID: 'ghostty-terminal-2',
        projectPath: '/repo',
      },
      {
        ghostty,
      }
    );

    expect(result).toEqual({ ok: false, precision: 'best_effort' });
    expect(ghostty).toHaveBeenCalledOnce();
  });

  it('returns unsupported for unknown terminals', async () => {
    const result = await jumpToTarget({
      participantId: 'a',
      alias: 'codex4',
      terminalApp: 'Warp',
      precision: 'unsupported',
      sessionHint: null,
      terminalTTY: null,
      terminalSessionID: null,
      projectPath: null,
    });

    expect(result).toEqual({
      ok: false,
      precision: 'unsupported',
      reason: 'unsupported_terminal',
    });
  });

  it('opens the project path when the terminal is unsupported but a repo path exists', async () => {
    const openProjectPath = vi.fn().mockResolvedValue(undefined);

    const result = await jumpToTarget(
      {
        participantId: 'a',
        alias: 'codex4',
        terminalApp: 'Warp',
        precision: 'best_effort',
        sessionHint: null,
        terminalTTY: null,
        terminalSessionID: null,
        projectPath: 'D:/projects/hexdeck',
      },
      { openProjectPath }
    );

    expect(result).toEqual({
      ok: true,
      precision: 'best_effort',
    });
    expect(openProjectPath).toHaveBeenCalledWith('D:/projects/hexdeck');
  });

  it('returns unsupported when terminal metadata is missing', async () => {
    const result = await jumpToTarget(
      {
        participantId: 'a',
        alias: 'codex4',
        terminalApp: 'unknown',
        precision: 'unsupported',
        sessionHint: null,
        terminalTTY: null,
        terminalSessionID: null,
        projectPath: null,
      }
    );

    expect(result).toEqual({
      ok: false,
      precision: 'unsupported',
      reason: 'unsupported_terminal',
    });
  });
});
