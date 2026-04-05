import { describe, expect, it } from 'vitest';
import { buildProjectSnapshot } from '../../../src/lib/projections/project-snapshot';

describe('buildProjectSnapshot', () => {
  it('builds overview and attention sections from broker data', () => {
    const snapshot = buildProjectSnapshot({
      health: { ok: true },
      participants: [
        { participantId: 'a', alias: 'codex4', context: { projectName: 'intent-broker' } },
        { participantId: 'b', alias: 'claude2', context: { projectName: 'intent-broker' } },
      ],
      workStates: [
        { participantId: 'a', status: 'implementing', summary: 'Working on HexDeck' },
        { participantId: 'b', status: 'blocked', summary: 'Waiting on schema decision' },
      ],
      events: [
        { id: 1282, type: 'report_progress', payload: { summary: 'Working on HexDeck' } },
        { id: 1283, type: 'request_approval', payload: { summary: 'Deploy approval needed' } },
      ],
    });

    expect(snapshot.overview.onlineCount).toBe(2);
    expect(snapshot.overview.blockedCount).toBe(1);
    expect(snapshot.attention[0].kind).toBe('blocked');
    expect(snapshot.attention[1].kind).toBe('approval');
  });

  it('adds jump metadata to now cards', () => {
    const snapshot = buildProjectSnapshot({
      health: { ok: true },
      participants: [
        {
          participantId: 'a',
          alias: 'codex4',
          tool: 'codex',
          context: { projectName: 'intent-broker' },
          metadata: {
            terminalApp: 'Ghostty',
            sessionHint: 'ghostty-tab-1',
            projectPath: '/Users/song/projects/intent-broker',
          },
        } as any,
      ],
      workStates: [{ participantId: 'a', status: 'implementing', summary: 'Working' }],
      events: [],
    });

    expect(snapshot.now[0].jumpPrecision).toBe('exact');
    expect(snapshot.now[0].jumpTarget).toEqual({
      participantId: 'a',
      terminalApp: 'Ghostty',
      precision: 'exact',
      sessionHint: 'ghostty-tab-1',
      projectPath: '/Users/song/projects/intent-broker',
    });
  });
});
