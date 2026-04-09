import { describe, expect, it } from 'vitest';
import { buildJumpTarget } from '../../../src/lib/jump/targets';

describe('buildJumpTarget', () => {
  it('returns an exact jump target for Ghostty-backed sessions', () => {
    const target = buildJumpTarget({
      participantId: 'codex-session-aa59e6ef',
      alias: 'codex4',
      toolLabel: 'codex',
      terminalApp: 'Ghostty',
      sessionHint: 'ghostty-tab-1',
      terminalTTY: '/dev/ttys003',
      terminalSessionID: 'ghostty-tab-1',
      projectPath: '/Users/song/projects/intent-broker',
    });

    expect(target).toEqual({
      participantId: 'codex-session-aa59e6ef',
      alias: 'codex4',
      terminalApp: 'Ghostty',
      precision: 'exact',
      sessionHint: 'ghostty-tab-1',
      terminalTTY: '/dev/ttys003',
      terminalSessionID: 'ghostty-tab-1',
      projectPath: '/Users/song/projects/intent-broker',
    });
  });

  it('returns best_effort when only a project path is available', () => {
    const target = buildJumpTarget({
      participantId: 'codex-session-win',
      alias: 'codex-win',
      toolLabel: 'codex',
      terminalApp: 'Warp',
      sessionHint: null,
      terminalTTY: null,
      terminalSessionID: null,
      projectPath: 'D:/projects/hexdeck',
    });

    expect(target.precision).toBe('best_effort');
  });

  it('does not treat Ghostty sessionHint alone as an exact locator', () => {
    const target = buildJumpTarget({
      participantId: 'codex-session-ghostty-alias',
      alias: 'codex2',
      toolLabel: 'codex',
      terminalApp: 'Ghostty',
      sessionHint: 'codex2',
      terminalTTY: '/dev/ttys003',
      terminalSessionID: null,
      projectPath: '/Users/song/projects/hexdeck',
    });

    expect(target.precision).toBe('best_effort');
    expect(target.terminalSessionID).toBeNull();
  });

  it('returns unsupported when no stable jump locator is available', () => {
    const target = buildJumpTarget({
      participantId: 'codex-session-local',
      alias: 'codex4',
      toolLabel: 'codex',
      terminalApp: 'unknown',
      sessionHint: null,
      terminalTTY: null,
      terminalSessionID: null,
      projectPath: null,
    });

    expect(target).toEqual({
      participantId: 'codex-session-local',
      alias: 'codex4',
      terminalApp: 'unknown',
      precision: 'unsupported',
      sessionHint: null,
      terminalTTY: null,
      terminalSessionID: null,
      projectPath: null,
    });
  });

  it('returns an exact jump target for Terminal.app sessions when a tty is available', () => {
    const target = buildJumpTarget({
      participantId: 'claude-session-mac',
      alias: 'claude2',
      toolLabel: 'claude-code',
      terminalApp: 'Terminal.app',
      sessionHint: '/dev/ttys011',
      terminalTTY: '/dev/ttys011',
      terminalSessionID: null,
      projectPath: '/Users/song/projects',
    });

    expect(target.precision).toBe('exact');
    expect(target.terminalTTY).toBe('/dev/ttys011');
  });
});
