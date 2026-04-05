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
      projectPath: '/Users/song/projects/intent-broker',
    });

    expect(target).toEqual({
      participantId: 'codex-session-aa59e6ef',
      terminalApp: 'Ghostty',
      precision: 'exact',
      sessionHint: 'ghostty-tab-1',
      projectPath: '/Users/song/projects/intent-broker',
    });
  });
});
