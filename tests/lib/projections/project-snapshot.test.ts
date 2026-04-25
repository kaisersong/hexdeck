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

  it('does not count registration-only broker presence as online without transport or terminal locator', () => {
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

    expect(snapshot.overview.onlineCount).toBe(1);
  });

  it('keeps registration-only broker presence online when terminal metadata can still locate the session', () => {
    const snapshot = buildProjectSnapshot({
      health: { ok: true },
      participants: [
        {
          participantId: 'a',
          alias: 'codex4',
          kind: 'agent',
          presence: 'online',
          presenceMetadata: { source: 'registration' },
          metadata: {
            terminalApp: 'Ghostty',
            terminalSessionID: 'ghostty-session-1',
            projectPath: '/Users/song/projects/intent-broker',
          },
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

  it('deduplicates registration-only participants that point at the same weak terminal locator', () => {
    const snapshot = buildProjectSnapshot({
      health: { ok: true },
      participants: [
        {
          participantId: 'codex-session-019db0b3',
          alias: 'codex21',
          kind: 'agent',
          presence: 'online',
          presenceMetadata: { source: 'registration' },
          context: { projectName: 'xiaok-cli' },
          metadata: {
            terminalApp: 'Ghostty',
            terminalTTY: '/dev/ttys005',
            sessionHint: 'codex21',
            projectPath: '/Users/song/projects/xiaok-cli',
          },
        },
        {
          participantId: 'codex-session-019db4d2',
          alias: 'codex50',
          kind: 'agent',
          presence: 'online',
          presenceMetadata: { source: 'registration' },
          context: { projectName: 'xiaok-cli' },
          metadata: {
            terminalApp: 'Ghostty',
            terminalTTY: '/dev/ttys005',
            sessionHint: 'codex50',
            projectPath: '/Users/song/projects/xiaok-cli',
          },
        },
      ],
      workStates: [],
      events: [],
      approvals: [],
    });

    expect(snapshot.overview.onlineCount).toBe(1);
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

  it('derives pending approvals from replay events when approvals array is empty', () => {
    const snapshot = buildProjectSnapshot({
      health: { ok: true },
      participants: [
        {
          participantId: 'agent-1',
          alias: 'codex4',
          kind: 'agent',
          context: { projectName: 'intent-broker' },
        },
      ],
      workStates: [],
      events: [
        {
          id: 100,
          type: 'request_approval',
          taskId: 'task-from-event',
          threadId: 'thread-from-event',
          createdAt: '2026-04-24T04:00:00.000Z',
          payload: {
            approvalId: 'approval-from-event',
            participantId: 'agent-1',
            body: {
              summary: 'Approval from event stream',
            },
          },
        },
      ],
      approvals: [],
    });

    expect(snapshot.overview.pendingApprovalCount).toBe(1);
    expect(snapshot.attention[0].kind).toBe('approval');
    expect(snapshot.attention[0].approvalId).toBe('approval-from-event');
    expect(snapshot.attention[0].summary).toBe('Approval from event stream');
  });

  it('drops event-derived pending approvals after a respond_approval event arrives', () => {
    const snapshot = buildProjectSnapshot({
      health: { ok: true },
      participants: [
        {
          participantId: 'agent-1',
          alias: 'codex4',
          kind: 'agent',
          context: { projectName: 'intent-broker' },
        },
      ],
      workStates: [],
      events: [
        {
          id: 100,
          type: 'request_approval',
          taskId: 'task-from-event',
          payload: {
            approvalId: 'approval-from-event',
            participantId: 'agent-1',
            body: {
              summary: 'Approval from event stream',
            },
          },
        },
        {
          id: 101,
          type: 'respond_approval',
          taskId: 'task-from-event',
          payload: {
            approvalId: 'approval-from-event',
            decision: 'approved',
          },
        },
      ],
      approvals: [],
    });

    expect(snapshot.overview.pendingApprovalCount).toBe(0);
    expect(snapshot.attention).toEqual([]);
  });

  it('ignores event-derived pending approvals when the requesting participant is no longer present', () => {
    const snapshot = buildProjectSnapshot({
      health: { ok: true },
      participants: [
        {
          participantId: 'agent-live',
          alias: 'codex4',
          kind: 'agent',
          context: { projectName: 'intent-broker' },
        },
      ],
      workStates: [],
      events: [
        {
          id: 100,
          type: 'request_approval',
          taskId: 'task-from-event',
          payload: {
            approvalId: 'approval-from-event',
            participantId: 'agent-gone',
            body: {
              summary: 'Approval from stale event stream',
            },
          },
        },
      ],
      approvals: [],
    });

    expect(snapshot.overview.pendingApprovalCount).toBe(0);
    expect(snapshot.attention).toEqual([]);
  });
});
