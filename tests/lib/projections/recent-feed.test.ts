import { describe, expect, it } from 'vitest';
import { buildRecentFeed } from '../../../src/lib/projections/recent-feed';

describe('buildRecentFeed', () => {
  it('deduplicates consecutive ambient progress updates and preserves critical items', () => {
    const recent = buildRecentFeed([
      { id: 10, type: 'report_progress', payload: { participantId: 'a', summary: 'Still implementing' } },
      { id: 11, type: 'report_progress', payload: { participantId: 'a', summary: 'Still implementing' } },
      { id: 12, type: 'request_approval', payload: { participantId: 'a', summary: 'Need approval' } },
    ]);

    expect(recent).toHaveLength(2);
    expect(recent[0].summary).toContain('Still implementing');
    expect(recent[1].summary).toContain('Need approval');
  });
});
