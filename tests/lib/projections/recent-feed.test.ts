import { describe, expect, it } from 'vitest';
import { buildRecentFeed } from '../../../src/lib/projections/recent-feed';

describe('buildRecentFeed', () => {
  it('deduplicates consecutive ambient progress updates and preserves critical items', () => {
    const recent = buildRecentFeed([
      {
        id: 10,
        type: 'report_progress',
        fromAlias: 'claude5',
        fromProjectName: 'projects',
        payload: { participantId: 'a', body: { summary: 'Still implementing' } },
      },
      {
        id: 11,
        type: 'report_progress',
        fromAlias: 'claude5',
        fromProjectName: 'projects',
        payload: { participantId: 'a', body: { summary: 'Still implementing' } },
      },
      { id: 12, type: 'request_approval', payload: { participantId: 'a', body: { summary: 'Need approval' } } },
    ]);

    expect(recent).toHaveLength(2);
    expect(recent[0]).toMatchObject({
      actorLabel: '@claude5',
      projectLabel: 'projects',
      summary: 'Still implementing',
    });
    expect(recent[1].summary).toContain('Need approval');
  });

  it('drops internal hook approval noise so real agent messages stay visible', () => {
    const recent = buildRecentFeed([
      {
        id: 1,
        type: 'request_approval',
        taskId: 'codex-hook-approval-call_1',
        payload: {
          approvalId: 'codex-hook-PreToolUse-call_1',
          delivery: { source: 'codex-hook-approval' },
          body: { summary: 'Codex needs approval to run Bash.' },
        },
      },
      {
        id: 2,
        type: 'report_progress',
        fromAlias: 'claude5',
        fromProjectName: 'projects',
        payload: {
          participantId: 'claude-code-session-c459d359',
          body: { summary: 'HexDeck real-agent test: please confirm reception' },
        },
      },
      {
        id: 3,
        type: 'respond_approval',
        taskId: 'codex-hook-approval-call_1',
        payload: { approvalId: 'codex-hook-PreToolUse-call_1', participantId: 'human.local' },
      },
    ]);

    expect(recent).toEqual([
      expect.objectContaining({
        actorLabel: '@claude5',
        projectLabel: 'projects',
        summary: 'HexDeck real-agent test: please confirm reception',
      }),
    ]);
  });
});
