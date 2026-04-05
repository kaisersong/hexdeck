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
});
