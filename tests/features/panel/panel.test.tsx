import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../../src/app/App';
import { PanelRoute } from '../../../src/app/routes/panel';
import { ActivityCardHost } from '../../../src/features/activity-card/ActivityCardHost';

describe('PanelRoute', () => {
  it('renders overview, now, attention, and recent sections', () => {
    render(
      <PanelRoute
        snapshot={{
          overview: {
            brokerHealthy: true,
            onlineCount: 2,
            busyCount: 1,
            blockedCount: 1,
            pendingApprovalCount: 1,
          },
          now: [],
          attention: [],
          recent: [],
        }}
      />
    );

    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Now')).toBeInTheDocument();
    expect(screen.getByText('Attention')).toBeInTheDocument();
    expect(screen.getByText('Recent')).toBeInTheDocument();
  });

  it('renders Jump actions for jump-capable cards', () => {
    render(
      <PanelRoute
        snapshot={{
          overview: {
            brokerHealthy: true,
            onlineCount: 1,
            busyCount: 1,
            blockedCount: 0,
            pendingApprovalCount: 0,
          },
          now: [
            {
              participantId: 'a',
              alias: 'codex4',
              toolLabel: 'codex',
              workState: 'implementing',
              summary: 'Working',
              updatedAtLabel: 'just now',
              jumpPrecision: 'exact',
              jumpTarget: {
                participantId: 'a',
                terminalApp: 'Ghostty',
                precision: 'exact',
                sessionHint: 'ghostty-tab-1',
                projectPath: '/repo',
              },
            },
          ],
          attention: [],
          recent: [],
        }}
      />
    );

    expect(screen.getByRole('button', { name: 'Jump to @codex4' })).toBeInTheDocument();
  });

  it('renders Approve and Deny buttons for approval attention items', () => {
    render(
      <PanelRoute
        snapshot={{
          overview: {
            brokerHealthy: true,
            onlineCount: 1,
            busyCount: 0,
            blockedCount: 0,
            pendingApprovalCount: 1,
          },
          now: [],
          attention: [
            {
              kind: 'approval',
              priority: 'critical',
              summary: 'Deploy approval needed',
              approvalId: 'approval-1',
              taskId: 'task-1',
              approvalDecision: 'pending',
            },
          ],
          recent: [],
        }}
      />
    );

    expect(screen.getByRole('button', { name: 'Approve approval-1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny approval-1' })).toBeInTheDocument();
  });
});

describe('ActivityCardHost', () => {
  it('renders a Jump action for critical cards with jump targets', () => {
    const { container } = render(
      <ActivityCardHost
        items={[
          {
            kind: 'blocked',
            priority: 'critical',
            summary: 'Waiting on schema decision',
            actorLabel: '@codex4',
            jumpTarget: {
              participantId: 'a',
              terminalApp: 'Ghostty',
              precision: 'exact',
              sessionHint: 'ghostty-tab-1',
              projectPath: '/repo',
            },
          },
        ]}
      />
    );

    expect(within(container).getByRole('button', { name: 'Jump to @codex4' })).toBeInTheDocument();
  });

  it('renders Approve and Deny buttons for approval cards', () => {
    const { container } = render(
      <ActivityCardHost
        items={[
          {
            kind: 'approval',
            priority: 'critical',
            summary: 'Deploy approval needed',
            approvalId: 'approval-1',
            taskId: 'task-1',
            approvalDecision: 'pending',
          },
        ]}
      />
    );

    expect(within(container).getByRole('button', { name: 'Approve approval-1' })).toBeInTheDocument();
    expect(within(container).getByRole('button', { name: 'Deny approval-1' })).toBeInTheDocument();
  });
});

describe('App integration', () => {
  it('shows onboarding when broker data has not loaded yet', () => {
    render(<App />);

    expect(screen.getByText('Broker connection')).toBeInTheDocument();
  });
});
