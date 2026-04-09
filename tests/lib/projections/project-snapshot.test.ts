import { describe, expect, it } from 'vitest';
import { buildProjectSnapshot } from '../../../src/lib/projections/project-snapshot';

describe('buildProjectSnapshot', () => {
  it('builds overview and attention sections from broker data', () => {
    const snapshot = buildProjectSnapshot({
      health: { ok: true },
      participants: [
        { participantId: 'a', alias: 'codex4', kind: 'agent', presence: 'online', context: { projectName: 'intent-broker' } },
        { participantId: 'b', alias: 'claude2', kind: 'agent', presence: 'offline', context: { projectName: 'intent-broker' } },
        { participantId: 'human.local', alias: 'human', kind: 'human', presence: 'online', context: { projectName: 'intent-broker' } },
      ],
      workStates: [
        { participantId: 'a', status: 'implementing', summary: 'Working on HexDeck' },
        { participantId: 'b', status: 'blocked', summary: 'Waiting on schema decision' },
      ],
      events: [
        { id: 1282, type: 'report_progress', payload: { summary: 'Working on HexDeck' } },
      ],
      approvals: [
        {
          approvalId: 'approval-1',
          taskId: 'task-1',
          summary: 'Deploy approval needed',
          decision: 'pending',
        },
      ],
    });

    expect(snapshot.overview.onlineCount).toBe(1);
    expect(snapshot.overview.blockedCount).toBe(1);
    expect(snapshot.attention[0].kind).toBe('blocked');
    expect(snapshot.attention[1].kind).toBe('approval');
  });

  it('falls back to work-state presence when explicit broker presence is missing', () => {
    const snapshot = buildProjectSnapshot({
      health: { ok: true },
      participants: [
        { participantId: 'a', alias: 'codex4', kind: 'agent', context: { projectName: 'intent-broker' } },
        { participantId: 'b', alias: 'claude2', kind: 'agent', context: { projectName: 'intent-broker' } },
      ],
      workStates: [{ participantId: 'a', status: 'idle', summary: 'Available' }],
      events: [],
      approvals: [],
    });

    expect(snapshot.overview.onlineCount).toBe(1);
  });

  it('counts registration-only broker presence as online', () => {
    const snapshot = buildProjectSnapshot({
      health: { ok: true },
      participants: [
        {
          participantId: 'a',
          alias: 'codex4',
          kind: 'agent',
          presence: 'online',
          presenceMetadata: { source: 'registration' },
          context: { projectName: 'intent-broker' },
        },
        {
          participantId: 'b',
          alias: 'claude2',
          kind: 'agent',
          presence: 'online',
          presenceMetadata: { transport: 'websocket', connectionCount: 1 },
          context: { projectName: 'intent-broker' },
        },
      ],
      workStates: [],
      events: [],
      approvals: [],
    });

    expect(snapshot.overview.onlineCount).toBe(2);
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
            terminalTTY: '/dev/ttys003',
            terminalSessionID: 'ghostty-tab-1',
            projectPath: '/Users/song/projects/intent-broker',
          },
        } as any,
      ],
      workStates: [{ participantId: 'a', status: 'implementing', summary: 'Working' }],
      events: [],
      approvals: [],
    });

    expect(snapshot.now[0].jumpPrecision).toBe('exact');
    expect(snapshot.now[0].jumpTarget).toEqual({
      participantId: 'a',
      alias: 'codex4',
      terminalApp: 'Ghostty',
      precision: 'exact',
      sessionHint: 'ghostty-tab-1',
      terminalTTY: '/dev/ttys003',
      terminalSessionID: 'ghostty-tab-1',
      projectPath: '/Users/song/projects/intent-broker',
    });
  });

  it('includes pending approvals in attention with approval metadata', () => {
    const snapshot = buildProjectSnapshot({
      health: { ok: true },
      participants: [],
      workStates: [],
      events: [],
      approvals: [
        {
          approvalId: 'approval-1',
          taskId: 'task-1',
          summary: 'Deploy approval needed',
          decision: 'pending',
        },
      ],
    });

    expect(snapshot.attention[0].kind).toBe('approval');
    expect(snapshot.attention[0].approvalId).toBe('approval-1');
    expect(snapshot.attention[0].approvalDecision).toBe('pending');
  });
});
