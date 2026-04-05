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
        terminalApp: 'Ghostty',
        precision: 'exact',
        sessionHint: 'ghostty-tab-1',
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

  it('returns unsupported for unknown terminals', async () => {
    const result = await jumpToTarget({
      participantId: 'a',
      terminalApp: 'Warp',
      precision: 'unsupported',
      sessionHint: null,
      projectPath: '/repo',
    });

    expect(result).toEqual({
      ok: false,
      precision: 'unsupported',
      reason: 'unsupported_terminal',
    });
  });
});
