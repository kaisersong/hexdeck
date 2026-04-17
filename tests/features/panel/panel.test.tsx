import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/app/App';
import { PanelRoute } from '../../../src/app/routes/panel';
import { ActivityCardHost } from '../../../src/features/activity-card/ActivityCardHost';

describe('PanelRoute', () => {
  it('renders compact project groups and footer metrics without the removed main-panel CTA', () => {
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
            presence: 'online',
            presenceMetadata: { transport: 'websocket', connectionCount: 1 },
            context: { projectName: 'HexDeck' },
          },
          {
            participantId: 'agent-b',
            alias: 'Agent-B',
            presence: 'online',
            presenceMetadata: { transport: 'websocket', connectionCount: 1 },
            context: { projectName: 'Internal Tools' },
          },
        ]}
        currentProject="HexDeck"
      />
    );

    expect(screen.getByText('Project: HexDeck')).toBeInTheDocument();
    expect(screen.getByText('Project: Internal Tools')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Main Panel' })).not.toBeInTheDocument();
    expect(screen.getByText('2 Online')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('1 approvals pending')).toBeInTheDocument();
  });

  it('keeps the dropdown focused on jumpable agent rows instead of selector and recent activity chrome', () => {
    render(
      <PanelRoute
        snapshot={{
          overview: {
            brokerHealthy: true,
            onlineCount: 1,
            busyCount: 0,
            blockedCount: 0,
            pendingApprovalCount: 0,
          },
          now: [],
          attention: [],
          recent: [
            {
              id: 451,
              priority: 'ambient',
              actorLabel: '@claude5',
              projectLabel: 'projects',
              summary: 'HexDeck real-agent test: please confirm reception',
            },
          ],
        }}
        participants={[]}
        currentProject="hexdeck"
      />
    );

    expect(screen.queryByRole('heading', { name: 'Recent activity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All agents' })).not.toBeInTheDocument();
    expect(screen.queryByText('HexDeck real-agent test: please confirm reception')).not.toBeInTheDocument();
  });

  it('shows online agents in project groups and keeps offline agents collapsed in a separate section by default', async () => {
    render(
      <PanelRoute
        snapshot={{
          overview: {
            brokerHealthy: true,
            onlineCount: 2,
            busyCount: 1,
            blockedCount: 0,
            pendingApprovalCount: 0,
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
          attention: [],
          recent: [],
        }}
        participants={[
          {
            participantId: 'agent-a',
            alias: 'Agent-A',
            presence: 'online',
            presenceMetadata: { transport: 'websocket', connectionCount: 1 },
            context: { projectName: 'HexDeck' },
          },
          {
            participantId: 'agent-b',
            alias: 'Agent-B',
            presence: 'offline',
            context: { projectName: 'HexDeck' },
          },
          {
            participantId: 'agent-c',
            alias: 'Agent-C',
            presence: 'online',
            presenceMetadata: { transport: 'websocket', connectionCount: 1 },
            context: { projectName: 'Internal Tools' },
          },
        ]}
        currentProject="HexDeck"
      />
    );

    expect(screen.getByText('Project: HexDeck')).toBeInTheDocument();
    expect(screen.getByText('Project: Internal Tools')).toBeInTheDocument();
    expect(screen.getByText('Agent-A')).toBeInTheDocument();
    expect(screen.getByText('Agent-C')).toBeInTheDocument();
    expect(screen.queryByText('Agent-B')).not.toBeInTheDocument();

    const offlineToggle = screen.getByRole('button', { name: 'Show offline agents' });
    expect(offlineToggle).toHaveTextContent('Offline');
    expect(offlineToggle).toHaveTextContent('1 Agents');

    fireEvent.click(offlineToggle);

    expect(screen.getByText('Agent-B')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide offline agents' })).toBeInTheDocument();
  });

  it('keeps registration-only online participants in the active project groups', () => {
    render(
      <PanelRoute
        snapshot={{
          overview: {
            brokerHealthy: true,
            onlineCount: 2,
            busyCount: 1,
            blockedCount: 0,
            pendingApprovalCount: 0,
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
          attention: [],
          recent: [],
        }}
        participants={[
          {
            participantId: 'agent-a',
            alias: 'Agent-A',
            presence: 'online',
            presenceMetadata: { transport: 'websocket', connectionCount: 1 },
            context: { projectName: 'HexDeck' },
          },
          {
            participantId: 'agent-b',
            alias: 'Agent-B',
            presence: 'online',
            presenceMetadata: { source: 'registration' },
            context: { projectName: 'HexDeck' },
          },
        ]}
        currentProject="HexDeck"
      />
    );

    expect(screen.getByText('Agent-A')).toBeInTheDocument();
    expect(screen.getByText('Agent-B')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show offline agents' })).not.toBeInTheDocument();
  });

  it('scrolls the offline section into view when expanding it', () => {
    const scrolledTargets: string[] = [];
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView() {
      scrolledTargets.push((this as HTMLElement).getAttribute('data-scroll-target') ?? this.tagName);
    };

    try {
      render(
        <PanelRoute
          snapshot={{
            overview: {
              brokerHealthy: true,
              onlineCount: 2,
              busyCount: 1,
              blockedCount: 0,
              pendingApprovalCount: 0,
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
            attention: [],
            recent: [],
          }}
          participants={[
            {
              participantId: 'agent-a',
              alias: 'Agent-A',
              presence: 'online',
              presenceMetadata: { transport: 'websocket', connectionCount: 1 },
              context: { projectName: 'HexDeck' },
            },
            {
              participantId: 'agent-b',
              alias: 'Agent-B',
              presence: 'offline',
              context: { projectName: 'HexDeck' },
            },
            {
              participantId: 'agent-c',
              alias: 'Agent-C',
              presence: 'online',
              presenceMetadata: { transport: 'websocket', connectionCount: 1 },
              context: { projectName: 'Internal Tools' },
            },
          ]}
          currentProject="HexDeck"
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Show offline agents' }));

      expect(scrolledTargets).toContain('offline-agent-agent-b');
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('shows a live chip when the broker is healthy and a degraded chip when it is not', () => {
    const { rerender } = render(
      <PanelRoute
        snapshot={{
          overview: {
            brokerHealthy: true,
            onlineCount: 1,
            busyCount: 0,
            blockedCount: 0,
            pendingApprovalCount: 0,
          },
          now: [],
          attention: [],
          recent: [],
        }}
        participants={[]}
        currentProject="HexDeck"
        brokerLive
      />
    );

    expect(screen.getByText('Live')).toBeInTheDocument();

    rerender(
      <PanelRoute
        snapshot={{
          overview: {
            brokerHealthy: false,
            onlineCount: 1,
            busyCount: 0,
            blockedCount: 0,
            pendingApprovalCount: 0,
          },
          now: [],
          attention: [],
          recent: [],
        }}
        participants={[]}
        currentProject="HexDeck"
        brokerLive={false}
      />
    );

    expect(screen.getAllByText('Degraded')).toHaveLength(2);
  });

  it('renders jump actions on agent rows when the agent can be focused', () => {
    const onJump = vi.fn();

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
                alias: 'codex4',
                terminalApp: 'Ghostty',
                precision: 'exact',
                sessionHint: 'ghostty-tab-1',
                terminalTTY: '/dev/ttys003',
                terminalSessionID: 'ghostty-tab-1',
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
            presence: 'online',
            presenceMetadata: { transport: 'websocket', connectionCount: 1 },
            context: { projectName: 'HexDeck' },
          },
        ]}
        currentProject="HexDeck"
        onJump={onJump}
      />
    );

    const jumpRow = screen.getByRole('button', { name: 'Jump to @codex4' });
    expect(jumpRow).toBeInTheDocument();

    fireEvent.click(jumpRow);

    expect(onJump).toHaveBeenCalledWith({
      participantId: 'a',
      alias: 'codex4',
      terminalApp: 'Ghostty',
      precision: 'exact',
      sessionHint: 'ghostty-tab-1',
      terminalTTY: '/dev/ttys003',
      terminalSessionID: 'ghostty-tab-1',
      projectPath: '/repo',
    });
  });

  it('derives jump actions for online agents from participant metadata even without work-state activity', () => {
    const onJump = vi.fn();

    render(
      <PanelRoute
        snapshot={{
          overview: {
            brokerHealthy: true,
            onlineCount: 1,
            busyCount: 0,
            blockedCount: 0,
            pendingApprovalCount: 0,
          },
          now: [],
          attention: [],
          recent: [],
        }}
        participants={[
          {
            participantId: 'a',
            alias: 'codex4',
            presence: 'online',
            presenceMetadata: { transport: 'websocket', connectionCount: 1 },
            metadata: {
              terminalApp: 'Ghostty',
              sessionHint: 'ghostty-tab-1',
              terminalTTY: '/dev/ttys003',
              terminalSessionID: 'ghostty-tab-1',
              projectPath: '/repo',
            },
            context: { projectName: 'HexDeck' },
          },
        ]}
        currentProject="HexDeck"
        onJump={onJump}
      />
    );

    const jumpRow = screen.getByRole('button', { name: 'Jump to @codex4' });
    expect(jumpRow).toBeEnabled();

    fireEvent.click(jumpRow);

    expect(onJump).toHaveBeenCalledWith({
      participantId: 'a',
      alias: 'codex4',
      terminalApp: 'Ghostty',
      precision: 'exact',
      sessionHint: 'ghostty-tab-1',
      terminalTTY: '/dev/ttys003',
      terminalSessionID: 'ghostty-tab-1',
      projectPath: '/repo',
    });
  });

  it('does not render broker adapters as clickable agent rows', () => {
    render(
      <PanelRoute
        snapshot={{
          overview: {
            brokerHealthy: true,
            onlineCount: 1,
            busyCount: 0,
            blockedCount: 0,
            pendingApprovalCount: 0,
          },
          now: [],
          attention: [],
          recent: [],
        }}
        participants={[
          {
            participantId: 'adapter.yunzhijia',
            alias: 'yunzhijia',
            kind: 'adapter',
            presence: 'online',
            presenceMetadata: { transport: 'websocket', connectionCount: 1 },
          },
          {
            participantId: 'a',
            alias: 'codex4',
            kind: 'agent',
            presence: 'online',
            presenceMetadata: { transport: 'websocket', connectionCount: 1 },
            metadata: {
              terminalApp: 'Ghostty',
              sessionHint: 'ghostty-tab-1',
              terminalTTY: '/dev/ttys003',
              terminalSessionID: 'ghostty-tab-1',
              projectPath: '/repo',
            },
            context: { projectName: 'HexDeck' },
          },
        ]}
        currentProject="HexDeck"
      />
    );

    expect(screen.queryByRole('button', { name: 'Jump to @yunzhijia' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Jump to @codex4' })).toBeInTheDocument();
  });

  it('disables online agents when stable jump metadata is missing', () => {
    const onJump = vi.fn();

    render(
      <PanelRoute
        snapshot={{
          overview: {
            brokerHealthy: true,
            onlineCount: 2,
            busyCount: 1,
            blockedCount: 1,
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
            },
            {
              participantId: 'b',
              alias: 'xiaok2',
              toolLabel: 'xiaok',
              workState: 'blocked',
              summary: 'Blocked',
              updatedAtLabel: 'just now',
            },
          ],
          attention: [],
          recent: [],
        }}
        participants={[
          {
            participantId: 'a',
              alias: 'codex4',
              presence: 'online',
              presenceMetadata: { transport: 'websocket', connectionCount: 1 },
              context: { projectName: 'HexDeck' },
            },
          {
            participantId: 'b',
            alias: 'xiaok2',
            presence: 'online',
            presenceMetadata: { transport: 'websocket', connectionCount: 1 },
            context: { projectName: 'HexDeck' },
          },
        ]}
        currentProject="HexDeck"
        onJump={onJump}
      />
    );

    const codexRow = screen.getByRole('button', { name: 'codex4 unavailable' });
    const xiaokRow = screen.getByRole('button', { name: 'xiaok2 unavailable' });

    expect(codexRow).toBeDisabled();
    expect(xiaokRow).toBeDisabled();
    expect(screen.getByText('blocked')).toBeInTheDocument();
    expect(onJump).not.toHaveBeenCalled();
  });

  it('disables rows when a snapshot jump target is unsupported and no participant metadata exists', () => {
    const onJump = vi.fn();

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
              jumpPrecision: 'unsupported',
              jumpTarget: {
                participantId: 'a',
                alias: 'codex4',
                terminalApp: 'unknown',
                precision: 'unsupported',
                sessionHint: null,
                terminalTTY: null,
                terminalSessionID: null,
                projectPath: null,
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
            presence: 'online',
            presenceMetadata: { transport: 'websocket', connectionCount: 1 },
            context: { projectName: 'HexDeck' },
          },
        ]}
        currentProject="HexDeck"
        onJump={onJump}
      />
    );

    const jumpRow = screen.getByRole('button', { name: 'codex4 unavailable' });
    expect(jumpRow).toBeDisabled();
    expect(onJump).not.toHaveBeenCalled();
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
              alias: 'codex4',
              terminalApp: 'Ghostty',
              precision: 'exact',
              sessionHint: 'ghostty-tab-1',
              terminalTTY: '/dev/ttys003',
              terminalSessionID: 'ghostty-tab-1',
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

    expect(screen.queryByRole('button', { name: 'Open Main Panel' })).not.toBeInTheDocument();
    expect(screen.getByText(/Project:/)).toBeInTheDocument();
  });

  it('renders the dropdown inside the tray shell wrapper', () => {
    const { container } = render(<App />);

    const trayShell = container.querySelector('main.panel-shell--dropdown');
    const dropdown = container.querySelector('.menu-dropdown');

    expect(trayShell).not.toBeNull();
    expect(dropdown).not.toBeNull();
    expect(trayShell?.contains(dropdown ?? null)).toBe(true);
  });
});
