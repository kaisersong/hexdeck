import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../../src/app/App';
import { PanelRoute } from '../../../src/app/routes/panel';
import { ActivityCardHost } from '../../../src/features/activity-card/ActivityCardHost';

describe('PanelRoute', () => {
  it('renders compact project groups, quick action, and footer metrics', () => {
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
          now: [
            {
              participantId: 'agent-a',
              alias: 'Agent-A',
              toolLabel: 'codex',
              workState: 'implementing',
              summary: 'Working',
              updatedAtLabel: 'just now',
            },
          ],
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
        participants={[
          {
            participantId: 'agent-a',
            alias: 'Agent-A',
            context: { projectName: 'HexDeck' },
          },
          {
            participantId: 'agent-b',
            alias: 'Agent-B',
            context: { projectName: 'Internal Tools' },
          },
        ]}
        currentProject="HexDeck"
      />
    );

    expect(screen.getByText('Project: HexDeck')).toBeInTheDocument();
    expect(screen.getByText('Project: Internal Tools')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Main Panel' })).toBeInTheDocument();
    expect(screen.getByText('2 Total')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('1 approvals pending')).toBeInTheDocument();
  });

  it('renders jump actions on agent rows when the agent can be focused', () => {
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
        participants={[
          {
            participantId: 'a',
            alias: 'codex4',
            context: { projectName: 'HexDeck' },
          },
        ]}
        currentProject="HexDeck"
      />
    );

    expect(screen.getByRole('button', { name: 'Jump to @codex4' })).toBeInTheDocument();
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
  it('shows the compact dropdown shell when broker data has not loaded yet', () => {
    render(<App />);

    expect(screen.getByRole('button', { name: 'Open Main Panel' })).toBeInTheDocument();
    expect(screen.getByText(/Project:/)).toBeInTheDocument();
  });
});
