import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActivityCardApprovalProjection,
  ActivityCardCompletionProjection,
  ActivityCardQuestionProjection,
} from '../../../src/lib/activity-card/types';
import { ActivityCardRoute } from '../../../src/app/routes/activity-card';
import { FloatingActivityCard } from '../../../src/features/activity-card/FloatingActivityCard';

const {
  brokerClientConstructorMock,
  expandedRouteSpy,
  getBrokerRuntimeStatusMock,
  getCurrentWindowMock,
  getCapabilityStatusMock,
  invokeMock,
  emitMock,
  listenMock,
  loadLocalSettingsMock,
  ensureBrokerReadyMock,
  hideWindowMock,
  onCloseRequestedMock,
  showWindowMock,
  setSizeMock,
  scaleFactorMock,
  innerSizeMock,
  outerSizeMock,
} = vi.hoisted(() => ({
  brokerClientConstructorMock: vi.fn(),
  expandedRouteSpy: vi.fn(),
  getBrokerRuntimeStatusMock: vi.fn(),
  getCurrentWindowMock: vi.fn(),
  getCapabilityStatusMock: vi.fn(),
  invokeMock: vi.fn(),
  emitMock: vi.fn(),
  listenMock: vi.fn().mockResolvedValue(() => undefined),
  loadLocalSettingsMock: vi.fn(),
  ensureBrokerReadyMock: vi.fn(),
  hideWindowMock: vi.fn(),
  onCloseRequestedMock: vi.fn(),
  showWindowMock: vi.fn(),
  setSizeMock: vi.fn(),
  scaleFactorMock: vi.fn(),
  innerSizeMock: vi.fn(),
  outerSizeMock: vi.fn(),
}));

vi.mock('../../../src/app/routes/expanded', () => ({
  ExpandedRoute: (props: unknown) => {
    expandedRouteSpy(props);
    return <div data-testid="expanded-route" />;
  },
}));

vi.mock('../../../src/lib/broker/client', () => ({
  BrokerClient: brokerClientConstructorMock,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: emitMock,
  listen: listenMock,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: getCurrentWindowMock,
}));

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalSize: class LogicalSize {
    width: number;
    height: number;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
  },
}));

vi.mock('../../../src/lib/broker/runtime', () => ({
  getBrokerRuntimeStatus: getBrokerRuntimeStatusMock,
  restartBrokerRuntime: vi.fn(),
}));

vi.mock('../../../src/lib/platform/capabilities', () => ({
  getCapabilityStatus: getCapabilityStatusMock,
}));

vi.mock('../../../src/lib/settings/local-settings', () => ({
  ALL_AGENTS_PROJECT: '__all_agents__',
  DEFAULT_BROKER_URL: 'http://127.0.0.1:4318',
  formatProjectLabel: (project: string) => (project === '__all_agents__' ? 'All agents' : project),
  loadLocalSettings: loadLocalSettingsMock,
  saveCurrentProject: vi.fn(),
  saveLocalSettings: vi.fn(),
}));

vi.mock('../../../src/lib/update/broker-updater', () => ({
  ensureBrokerReady: ensureBrokerReadyMock,
}));

function makeSeed() {
  return {
    health: { ok: true },
    participants: [],
    workStates: [],
    events: [],
    approvals: [],
  };
}

function makeProjectParticipant() {
  return {
    participantId: 'codex.main',
    alias: 'codex4',
    kind: 'agent',
    tool: 'codex',
    metadata: {
      terminalApp: 'Ghostty',
      terminalSessionID: 'ghostty-1',
      projectPath: '/Users/song/projects/hexdeck',
    },
    context: { projectName: 'HexDeck' },
  };
}

function makeApprovalCard(approvalId = 'approval-1'): ActivityCardApprovalProjection {
  return {
    cardId: `approval:${approvalId}`,
    resolutionKey: `approval:${approvalId}`,
    kind: 'approval',
    priority: 'critical',
    summary: 'Deploy approval needed',
    actorLabel: '@codex4',
    projectLabel: 'HexDeck',
    toolLabel: 'Claude Code',
    terminalLabel: 'Ghostty',
    approvalId,
    actionMode: 'action',
    decision: 'pending',
    taskId: 'task-1',
    actions: [
      { label: '确认删除', decisionMode: 'yes' },
      { label: '取消', decisionMode: 'no' },
    ],
    detailText: '即将删除 workspace 目录下最新文件：/naws-freeflow-demo.svg',
  };
}

function makeQuestionCard(): ActivityCardQuestionProjection {
  return {
    cardId: 'question:1',
    resolutionKey: 'question:question-1',
    kind: 'question',
    priority: 'attention',
    summary: 'Which target should I use?',
    actorLabel: '@codex4',
    projectLabel: 'HexDeck',
    toolLabel: 'Claude Code',
    terminalLabel: 'Ghostty',
    questionId: 'question-1',
    prompt: 'Choose a target',
    detailText: 'Staging is safer for verification before rollout.',
    selectionMode: 'single-select',
    options: [
      { label: 'Staging', value: 'staging', description: 'Use the staging workspace first' },
      { label: 'Production', value: 'prod', description: 'Apply the change immediately to prod' },
    ],
    participantId: 'codex.main',
    taskId: 'task-1',
    threadId: 'thread-1',
  };
}

function makeCompletionCard(): ActivityCardCompletionProjection {
  return {
    cardId: 'completion:1',
    resolutionKey: 'completion:1',
    kind: 'completion',
    priority: 'ambient',
    summary: 'Completed rollout tracking slice.',
    actorLabel: '@codex4',
    projectLabel: 'HexDeck',
    toolLabel: 'Claude Code',
    terminalLabel: 'Ghostty',
    stage: 'completed',
    participantId: 'codex.main',
    taskId: 'task-1',
    threadId: 'thread-1',
    jumpTarget: {
      participantId: 'codex.main',
      alias: 'codex4',
      terminalApp: 'Ghostty',
      precision: 'exact',
      sessionHint: 'ghostty-1',
      terminalTTY: '/dev/ttys001',
      terminalSessionID: 'ghostty-1',
      projectPath: '/Users/song/projects/hexdeck',
    },
  };
}

function makeBrokerClientMock() {
  return {
    loadServiceSeed: vi.fn().mockResolvedValue(makeSeed()),
    loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
    subscribe: vi.fn(() => () => undefined),
    connectRealtime: vi.fn(() => () => undefined),
    respondToApproval: vi.fn().mockResolvedValue(undefined),
    answerClarification: vi.fn().mockResolvedValue(undefined),
  };
}

let brokerClientInstance = makeBrokerClientMock();

beforeEach(() => {
  vi.useRealTimers();
  window.history.pushState({}, '', '/');
  expandedRouteSpy.mockClear();
  getBrokerRuntimeStatusMock.mockReset();
  getBrokerRuntimeStatusMock.mockResolvedValue({
    installed: false,
    running: false,
    healthy: false,
    version: null,
    path: null,
    heartbeatPath: null,
    stdoutPath: null,
    stderrPath: null,
    lastError: null,
  });
  getCapabilityStatusMock.mockReset();
  getCapabilityStatusMock.mockReturnValue({
    notifications: 'unknown',
    globalShortcut: 'unknown',
    jumpSupport: 'unknown',
  });
  loadLocalSettingsMock.mockReset();
  loadLocalSettingsMock.mockReturnValue({
    brokerUrl: 'http://broker.test',
    globalShortcut: 'CmdOrCtrl+Shift+H',
    currentProject: '',
    recentProjects: [],
  });
  ensureBrokerReadyMock.mockReset();
  ensureBrokerReadyMock.mockResolvedValue({ ready: true, last_error: null });
  invokeMock.mockReset();
  emitMock.mockReset();
  listenMock.mockReset();
  listenMock.mockResolvedValue(() => undefined);
  setSizeMock.mockReset();
  hideWindowMock.mockReset();
  onCloseRequestedMock.mockReset();
  onCloseRequestedMock.mockResolvedValue(() => undefined);
  showWindowMock.mockReset();
  hideWindowMock.mockResolvedValue(undefined);
  showWindowMock.mockResolvedValue(undefined);
  setSizeMock.mockResolvedValue(undefined);
  scaleFactorMock.mockReset();
  scaleFactorMock.mockResolvedValue(1);
  innerSizeMock.mockReset();
  innerSizeMock.mockResolvedValue({ width: 680, height: 336 });
  outerSizeMock.mockReset();
  outerSizeMock.mockResolvedValue({ width: 680, height: 336 });
  getCurrentWindowMock.mockReset();
  getCurrentWindowMock.mockReturnValue({
    hide: hideWindowMock,
    innerSize: innerSizeMock,
    onCloseRequested: onCloseRequestedMock,
    outerSize: outerSizeMock,
    scaleFactor: scaleFactorMock,
    show: showWindowMock,
    setSize: setSizeMock,
  });
  brokerClientInstance = makeBrokerClientMock();
  brokerClientConstructorMock.mockReset();
  brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);
});

async function loadActionDispatcher() {
  const mod = await import('../../../src/app/App');
  return mod.dispatchActivityCardAction as
    | undefined
    | ((
        client: {
          respondToApproval: (input: {
            approvalId: string;
            taskId: string;
            fromParticipantId: string;
            decision: 'approved' | 'denied';
            decisionMode?: 'yes' | 'always' | 'no';
          }) => Promise<void>;
          answerClarification: (input: {
            fromParticipantId: string;
            toParticipantId: string;
            taskId?: string;
            threadId?: string;
            summary: string;
            intentId?: string;
          }) => Promise<void>;
        },
        action:
          | {
              kind: 'approval';
              approvalId: string;
              taskId: string;
              decisionMode: 'yes' | 'always' | 'no';
            }
          | {
              kind: 'question';
              questionId: string;
              participantId: string;
              taskId?: string;
              threadId?: string;
              answer: string;
            },
        fromParticipantId?: string
      ) => Promise<void>);
}

describe('activity card action dispatcher', () => {
  it('maps approval yes mode to approved', async () => {
    const dispatcher = await loadActionDispatcher();
    const respondToApproval = vi.fn().mockResolvedValue(undefined);
    const answerClarification = vi.fn().mockResolvedValue(undefined);

    await dispatcher?.(
      {
        respondToApproval,
        answerClarification,
      },
      {
        kind: 'approval',
        approvalId: 'approval-1',
        taskId: 'task-1',
        decisionMode: 'yes',
      }
    );

    expect(respondToApproval).toHaveBeenCalledWith({
      approvalId: 'approval-1',
      taskId: 'task-1',
      fromParticipantId: 'human.local',
      decision: 'approved',
      decisionMode: 'yes',
    });
    expect(answerClarification).not.toHaveBeenCalled();
  });

  it('maps approval always mode to approved', async () => {
    const dispatcher = await loadActionDispatcher();
    const respondToApproval = vi.fn().mockResolvedValue(undefined);
    const answerClarification = vi.fn().mockResolvedValue(undefined);

    await dispatcher?.(
      {
        respondToApproval,
        answerClarification,
      },
      {
        kind: 'approval',
        approvalId: 'approval-1',
        taskId: 'task-1',
        decisionMode: 'always',
      }
    );

    expect(respondToApproval).toHaveBeenCalledWith({
      approvalId: 'approval-1',
      taskId: 'task-1',
      fromParticipantId: 'human.local',
      decision: 'approved',
      decisionMode: 'always',
    });
    expect(answerClarification).not.toHaveBeenCalled();
  });

  it('maps approval no mode to denied', async () => {
    const dispatcher = await loadActionDispatcher();
    const respondToApproval = vi.fn().mockResolvedValue(undefined);
    const answerClarification = vi.fn().mockResolvedValue(undefined);

    await dispatcher?.(
      {
        respondToApproval,
        answerClarification,
      },
      {
        kind: 'approval',
        approvalId: 'approval-1',
        taskId: 'task-1',
        decisionMode: 'no',
      }
    );

    expect(respondToApproval).toHaveBeenCalledWith({
      approvalId: 'approval-1',
      taskId: 'task-1',
      fromParticipantId: 'human.local',
      decision: 'denied',
      decisionMode: 'no',
    });
    expect(answerClarification).not.toHaveBeenCalled();
  });

  it('routes clarification answers through answer_clarification intents', async () => {
    const dispatcher = await loadActionDispatcher();
    const respondToApproval = vi.fn().mockResolvedValue(undefined);
    const answerClarification = vi.fn().mockResolvedValue(undefined);

    await dispatcher?.(
      {
        respondToApproval,
        answerClarification,
      },
      {
        kind: 'question',
        questionId: 'question-1',
        participantId: 'codex.main',
        taskId: 'task-1',
        threadId: 'thread-1',
        answer: 'Use the compact layout',
      }
    );

    expect(answerClarification).toHaveBeenCalledWith(
      expect.objectContaining({
        fromParticipantId: 'human.local',
        toParticipantId: 'codex.main',
        taskId: 'task-1',
        threadId: 'thread-1',
        summary: 'Use the compact layout',
        intentId: expect.any(String),
      })
    );
    expect(respondToApproval).not.toHaveBeenCalled();
  });

  it('renders ExpandedRoute without overview section switching props', async () => {
    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=expanded');

    render(<App />);

    await waitFor(() => {
      expect(expandedRouteSpy).toHaveBeenCalled();
    });

    const props = expandedRouteSpy.mock.calls.at(-1)?.[0] as {
      section?: unknown;
      onSectionChange?: unknown;
    };

    expect(props.section).toBeUndefined();
    expect(props.onSectionChange).toBeUndefined();
  });

  it('queues a second refresh when focus arrives during a slow refresh', async () => {
    let resolveFirstLoad: (value: ReturnType<typeof makeSeed>) => void = () => undefined;
    const firstLoadPromise = new Promise<ReturnType<typeof makeSeed>>((resolve) => {
      resolveFirstLoad = resolve;
    });
    brokerClientInstance = {
      loadServiceSeed: vi.fn()
        .mockImplementationOnce(() => firstLoadPromise)
        .mockResolvedValueOnce(makeSeed()),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=expanded');

    render(<App />);

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(1);
    });

    window.dispatchEvent(new Event('focus'));
    resolveFirstLoad(makeSeed());

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(2);
    });
  });
});

describe('FloatingActivityCard', () => {
  it('renders approval actions using the real card action labels', () => {
    const onApprovalDecision = vi.fn();

    render(
      <FloatingActivityCard
        card={makeApprovalCard()}
        onApprovalDecision={onApprovalDecision}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(onApprovalDecision).toHaveBeenNthCalledWith(1, {
      decisionMode: 'yes',
      label: '确认删除',
    });
    expect(onApprovalDecision).toHaveBeenNthCalledWith(2, {
      decisionMode: 'no',
      label: '取消',
    });
  });

  it('accepts approval button clicks in the live Tauri activity-card window without requiring a prior pointerdown', () => {
    const onApprovalDecision = vi.fn();
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    window.history.pushState({}, '', '/?view=activity-card');

    try {
      render(
        <FloatingActivityCard
          card={makeApprovalCard()}
          onApprovalDecision={onApprovalDecision}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

      expect(onApprovalDecision).toHaveBeenCalledWith({
        decisionMode: 'yes',
        label: '确认删除',
      });
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it('renders a manual close button for activity cards', () => {
    const onDismiss = vi.fn();

    render(
      <FloatingActivityCard
        card={makeApprovalCard()}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close activity card' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders approval actions using agent-provided labels when available', () => {
    const onApprovalDecision = vi.fn();

    render(
      <FloatingActivityCard
        card={{
          ...makeApprovalCard(),
          actions: [
            { label: 'Approve', decisionMode: 'yes' },
            { label: 'Approve Always', decisionMode: 'always' },
            { label: 'Reject', decisionMode: 'no' },
          ],
        }}
        onApprovalDecision={onApprovalDecision}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve Always' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    expect(onApprovalDecision).toHaveBeenNthCalledWith(1, {
      decisionMode: 'yes',
      label: 'Approve',
    });
    expect(onApprovalDecision).toHaveBeenNthCalledWith(2, {
      decisionMode: 'always',
      label: 'Approve Always',
    });
    expect(onApprovalDecision).toHaveBeenNthCalledWith(3, {
      decisionMode: 'no',
      label: 'Reject',
    });
  });

  it('renders source and runtime metadata chips when provided by the agent', () => {
    render(<FloatingActivityCard card={makeApprovalCard()} />);

    expect(screen.getByText('HexDeck')).toBeInTheDocument();
    expect(screen.getByText('@codex4 · Deploy approval needed')).toBeInTheDocument();
    expect(screen.getByText('Ghostty')).toBeInTheDocument();
  });

  it('renders approval command preview content when the agent provides it', () => {
    render(
      <FloatingActivityCard
        card={{
          ...makeApprovalCard(),
          summary: 'Claude wants to run Bash.',
          detailText: '需要创建 skill 目录并进入 scripts 子目录。',
          commandTitle: 'Bash',
          commandLine: '$ mkdir -p /Users/song/.claude/skills/kai-export-ppt-lite/scripts',
          commandPreview: 'mkdir -p /Users/song/.claude/skills/kai-export-ppt-lite/scripts',
        }}
      />
    );

    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('$ mkdir -p /Users/song/.claude/skills/kai-export-ppt-lite/scripts')).toBeInTheDocument();
    expect(screen.getByText('mkdir -p /Users/song/.claude/skills/kai-export-ppt-lite/scripts')).toBeInTheDocument();
  });

  it('renders real approval action labels and normalizes escaped line breaks in approval text', () => {
    render(<FloatingActivityCard card={makeApprovalCard()} />);

    expect(screen.getByRole('button', { name: '确认删除' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
    expect(screen.getByText(/即将删除 workspace 目录下最新文件：/)).toBeInTheDocument();
    expect(screen.getByText(/aws-freeflow-demo\.svg/)).toBeInTheDocument();
    expect(screen.queryByText('需要你立即确认这个 agent 意图')).not.toBeInTheDocument();
  });

  it('renders approval markdown in the content body without treating command previews as markdown', () => {
    const { container } = render(
      <FloatingActivityCard
        card={{
          ...makeApprovalCard(),
          detailText: '请确认以下步骤：\n\n- **删除旧索引**\n- `npm run build`',
          commandTitle: 'Bash',
          commandLine: '$ echo "**literal**"',
        }}
      />
    );

    const body = container.querySelector('.floating-card__body--approval');
    const commandBlock = container.querySelector('.floating-card__command');
    expect(body?.querySelector('ul')).toBeTruthy();
    expect(body?.querySelector('strong')?.textContent).toBe('删除旧索引');
    expect(body?.querySelector('code')?.textContent).toBe('npm run build');
    expect(commandBlock?.querySelector('strong')).toBeNull();
    expect(screen.getByText('$ echo "**literal**"')).toBeInTheDocument();
  });

  it('submits question options immediately on click', () => {
    const onQuestionSelect = vi.fn();

    render(
      <FloatingActivityCard
        card={makeQuestionCard()}
        onQuestionSelect={onQuestionSelect}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Staging/ }));

    expect(onQuestionSelect).toHaveBeenCalledWith({
      label: 'Staging',
      value: 'staging',
      description: 'Use the staging workspace first',
    });
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
  });

  it('renders question detail text and option descriptions when present', () => {
    render(<FloatingActivityCard card={makeQuestionCard()} />);

    expect(screen.getByText('Choose a target')).toBeInTheDocument();
    expect(screen.getByText('Staging is safer for verification before rollout.')).toBeInTheDocument();
    expect(screen.getByText('Use the staging workspace first')).toBeInTheDocument();
    expect(screen.getByText('Apply the change immediately to prod')).toBeInTheDocument();
  });

  it('renders question prompt and detail markdown in the content area', () => {
    const { container } = render(
      <FloatingActivityCard
        card={{
          ...makeQuestionCard(),
          prompt: 'Choose **one** target',
          detailText: 'Review the [runbook](https://example.com/runbook).\n\n> Prefer staging first.',
        }}
      />
    );

    expect(container.querySelector('.floating-card__body strong')?.textContent).toBe('one');
    expect(screen.getByRole('link', { name: 'runbook' })).toHaveAttribute('href', 'https://example.com/runbook');
    expect(container.querySelector('.floating-card__body--question-detail blockquote')?.textContent).toContain('Prefer staging first.');
  });

  it('reports hover state changes so timers can pause and resume', () => {
    const onHoverChange = vi.fn();

    render(
      <FloatingActivityCard
        card={makeApprovalCard()}
        onHoverChange={onHoverChange}
      />
    );

    const article = screen.getByText('@codex4 · Deploy approval needed').closest('article');
    if (!article) {
      throw new Error('expected floating card article');
    }

    fireEvent.mouseEnter(article);
    fireEvent.mouseLeave(article);

    expect(onHoverChange).toHaveBeenNthCalledWith(1, true);
    expect(onHoverChange).toHaveBeenNthCalledWith(2, false);
  });

  it('does not map y, a, and n keyboard shortcuts onto approval decisions', () => {
    const onApprovalDecision = vi.fn();

    render(
      <FloatingActivityCard
        card={makeApprovalCard()}
        onApprovalDecision={onApprovalDecision}
      />
    );

    fireEvent.keyDown(window, { key: 'y' });
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.keyDown(window, { key: 'n' });

    expect(onApprovalDecision).not.toHaveBeenCalled();
  });

  it('does not map approval keyboard shortcuts for non-approval cards', () => {
    const onQuestionSelect = vi.fn();

    render(
      <FloatingActivityCard
        card={makeQuestionCard()}
        onQuestionSelect={onQuestionSelect}
      />
    );

    fireEvent.keyDown(window, { key: 'y' });
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.keyDown(window, { key: 'n' });

    expect(onQuestionSelect).not.toHaveBeenCalled();
  });

  it('does not turn approval cards into jump buttons even when a jump target exists', () => {
    const onJump = vi.fn();
    const completionCard = makeCompletionCard();

    render(
      <FloatingActivityCard
        card={{
          ...makeApprovalCard(),
          jumpTarget: completionCard.jumpTarget,
        }}
        onJump={onJump}
      />
    );

    expect(screen.queryByRole('button', { name: /Open agent context/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('@codex4 · Deploy approval needed'));
    expect(onJump).not.toHaveBeenCalled();
  });

  it('renders completion summaries and jump actions when a jump target exists', () => {
    const onJump = vi.fn();
    const completionCard = makeCompletionCard();

    render(
      <FloatingActivityCard
        card={completionCard}
        onJump={onJump}
      />
    );

    expect(screen.getByText('@codex4 · Completed rollout tracking slice.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open agent context for Completed rollout tracking slice.' }));
    expect(onJump).toHaveBeenCalledWith(completionCard.jumpTarget);
    expect(screen.queryByRole('button', { name: 'Jump' })).not.toBeInTheDocument();
  });

  it('renders completion markdown details including fenced code blocks', () => {
    const { container } = render(
      <FloatingActivityCard
        card={{
          ...makeCompletionCard(),
          jumpTarget: null,
          detailText: 'Deployment finished.\n\n```bash\nnpm run build\n```',
        }}
      />
    );

    expect(screen.getByText('Deployment finished.')).toBeInTheDocument();
    expect(container.querySelector('.floating-card__body pre code')?.textContent).toContain('npm run build');
  });
});

describe('ActivityCardRoute', () => {
  it('clips the activity card shell with bottom corners that match the inner card', () => {
    render(<ActivityCardRoute card={makeApprovalCard()} />);

    const shell = screen.getByLabelText('activity-card');
    expect(shell).toHaveStyle({
      borderBottomLeftRadius: '10px',
      borderBottomRightRadius: '10px',
    });
    expect(shell).not.toHaveStyle({ borderTopLeftRadius: '10px' });
    expect(shell).not.toHaveStyle({ borderTopRightRadius: '10px' });
  });

  it('forwards question selections through the route boundary', () => {
    const onQuestionAction = vi.fn();

    render(
      <ActivityCardRoute
        card={makeQuestionCard()}
        onQuestionAction={onQuestionAction}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Staging' }));

    expect(onQuestionAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'question', questionId: 'question-1' }),
      {
        label: 'Staging',
        value: 'staging',
        description: 'Use the staging workspace first'
      }
    );
  });

  it('forwards hover state changes through the route boundary', () => {
    const onHoverChange = vi.fn();

    render(
      <ActivityCardRoute
        card={makeApprovalCard()}
        onHoverChange={onHoverChange}
      />
    );

    const article = screen.getByText('@codex4 · Deploy approval needed').closest('article');
    if (!article) {
      throw new Error('expected floating card article');
    }

    fireEvent.mouseEnter(article);
    fireEvent.mouseLeave(article);

    expect(onHoverChange).toHaveBeenNthCalledWith(1, true);
    expect(onHoverChange).toHaveBeenNthCalledWith(2, false);
  });

  it('forwards dismiss actions through the route boundary', () => {
    const onDismiss = vi.fn();

    render(
      <ActivityCardRoute
        card={makeApprovalCard()}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close activity card' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('maps native close requests to dismiss actions instead of closing the window', async () => {
    const onDismiss = vi.fn();
    let closeRequestHandler:
      | ((event: { preventDefault: () => void }) => void | Promise<void>)
      | undefined;

    onCloseRequestedMock.mockImplementation(async (handler) => {
      closeRequestHandler = handler;
      return () => undefined;
    });

    render(
      <ActivityCardRoute
        card={makeApprovalCard()}
        onDismiss={onDismiss}
      />
    );

    await waitFor(() => {
      expect(onCloseRequestedMock).toHaveBeenCalledTimes(1);
    });

    const preventDefault = vi.fn();
    await closeRequestHandler?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(hideWindowMock).not.toHaveBeenCalled();
  });

  it('does not render an empty card when the live route has no active card', async () => {
    const onDismiss = vi.fn();

    render(
      <ActivityCardRoute
        card={null}
        onDismiss={onDismiss}
      />
    );

    expect(screen.queryByText('No active activity card')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('No active activity card')).not.toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });
  });

  it('uses a fixed window width and approval fallback height before measurement is available', async () => {
    render(<ActivityCardRoute card={makeApprovalCard()} />);

    await waitFor(() => {
      const latestSize = setSizeMock.mock.calls.at(-1)?.[0] as { width: number; height: number } | undefined;
      expect(latestSize?.width).toBe(680);
      expect(latestSize?.height).toBe(336);
    });
  });

  it('uses minimum height buckets for question and completion cards', async () => {
    render(<ActivityCardRoute card={makeQuestionCard()} />);

    await waitFor(() => {
      const latestSize = setSizeMock.mock.calls.at(-1)?.[0] as { width: number; height: number } | undefined;
      expect(latestSize?.width).toBe(680);
      expect(latestSize?.height).toBe(232);
    });

    render(<ActivityCardRoute card={makeCompletionCard()} />);

    await waitFor(() => {
      const latestSize = setSizeMock.mock.calls.at(-1)?.[0] as { width: number; height: number } | undefined;
      expect(latestSize?.width).toBe(680);
      expect(latestSize?.height).toBe(180);
    });
  });

  it('expands the native window to the measured rendered card height', async () => {
    const scrollHeightSpy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(408);
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 408,
      height: 408,
      left: 0,
      right: 680,
      top: 0,
      width: 680,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    try {
      render(<ActivityCardRoute card={makeApprovalCard()} />);

      await waitFor(() => {
        const latestSize = setSizeMock.mock.calls.at(-1)?.[0] as { width: number; height: number } | undefined;
        expect(latestSize?.width).toBe(680);
        expect(latestSize?.height).toBe(410);
      });
    } finally {
      scrollHeightSpy.mockRestore();
      rectSpy.mockRestore();
    }
  });

  it('shrinks the native window to the measured rendered card height in preview mode', async () => {
    window.history.pushState({}, '', '/?view=activity-card&preview=approval');
    const scrollHeightSpy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(224);
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 224,
      height: 224,
      left: 0,
      right: 680,
      top: 0,
      width: 680,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    try {
      render(<ActivityCardRoute card={null} />);

      await waitFor(() => {
        const latestSize = setSizeMock.mock.calls.at(-1)?.[0] as { width: number; height: number } | undefined;
        expect(latestSize?.width).toBe(680);
        expect(latestSize?.height).toBe(226);
      });
    } finally {
      scrollHeightSpy.mockRestore();
      rectSpy.mockRestore();
    }
  });

  it('shrinks the live native window to the measured rendered card height', async () => {
    const scrollHeightSpy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(224);
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 224,
      height: 224,
      left: 0,
      right: 680,
      top: 0,
      width: 680,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    try {
      render(<ActivityCardRoute card={makeApprovalCard()} />);

      await waitFor(() => {
        const latestSize = setSizeMock.mock.calls.at(-1)?.[0] as { width: number; height: number } | undefined;
        expect(latestSize?.width).toBe(680);
        expect(latestSize?.height).toBe(226);
      });
    } finally {
      scrollHeightSpy.mockRestore();
      rectSpy.mockRestore();
    }
  });

  it('renders preview-only activity card measurement diagnostics', async () => {
    window.history.pushState({}, '', '/?view=activity-card&preview=approval');
    scaleFactorMock.mockResolvedValue(2);
    innerSizeMock.mockResolvedValue({ width: 1360, height: 672 });
    outerSizeMock.mockResolvedValue({ width: 1360, height: 672 });
    invokeMock.mockImplementation((command: string) => {
      if (command === 'resize_activity_card_window') {
        return Promise.resolve({
          targetHeight: 226,
          innerHeight: 336,
          outerHeight: 336,
          scaleFactor: 2,
        });
      }
      return Promise.resolve(undefined);
    });
    const scrollHeightSpy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(224);
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 224,
      height: 224,
      left: 0,
      right: 680,
      top: 0,
      width: 680,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    try {
      render(<ActivityCardRoute card={null} />);

      await waitFor(() => {
        expect(screen.getByLabelText('activity card debug measurements')).toHaveTextContent('card 224px');
        expect(screen.getByLabelText('activity card debug measurements')).toHaveTextContent('target 226px');
        expect(screen.getByLabelText('activity card debug measurements')).toHaveTextContent('inner 336px');
        expect(screen.getByLabelText('activity card debug measurements')).toHaveTextContent('outer 336px');
        expect(screen.getByLabelText('activity card debug measurements')).toHaveTextContent('scale 2x');
      });
      expect(invokeMock).toHaveBeenCalledWith('resize_activity_card_window', { width: 680, height: 226 });
    } finally {
      scrollHeightSpy.mockRestore();
      rectSpy.mockRestore();
    }
  });

  it('does not render live debug activity card measurement diagnostics', async () => {
    window.history.pushState({}, '', '/?view=activity-card&debugLive=1');
    invokeMock.mockImplementation((command: string) => {
      if (command === 'resize_activity_card_window') {
        return Promise.resolve({
          targetHeight: 226,
          innerHeight: 226,
          outerHeight: 226,
          scaleFactor: 1,
        });
      }
      return Promise.resolve(undefined);
    });
    const scrollHeightSpy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(224);
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 224,
      height: 224,
      left: 0,
      right: 680,
      top: 0,
      width: 680,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    try {
      render(<ActivityCardRoute card={makeApprovalCard()} />);

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith('resize_activity_card_window', { width: 680, height: 226 });
      });
      expect(screen.queryByLabelText('activity card debug measurements')).not.toBeInTheDocument();
    } finally {
      scrollHeightSpy.mockRestore();
      rectSpy.mockRestore();
    }
  });

  it('does not keep a debug shell mounted when the live route has no active card', () => {
    window.history.pushState({}, '', '/?view=activity-card&debugLive=1&project=hexdeck');

    render(
      <ActivityCardRoute
        card={null}
        debugInfo={{
          project: 'hexdeck',
          cardCount: 0,
          activeCardId: null,
          latestEventId: 2796,
          connectionState: 'connected',
          connectionMessage: null,
          error: null,
        }}
      />
    );

    expect(screen.queryByLabelText('activity-card')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('activity card debug measurements')).not.toBeInTheDocument();
  });

  it('hides the live activity-card window after a real card clears', async () => {
    const { rerender } = render(<ActivityCardRoute card={makeApprovalCard()} />);

    await waitFor(() => {
      expect(screen.getByText('@codex4 · Deploy approval needed')).toBeInTheDocument();
    });

    rerender(<ActivityCardRoute card={null} />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });
  });

  it('does not hide the native window when controller intent keeps the popup alive during a transient null card', async () => {
    const { rerender } = render(
      <ActivityCardRoute
        card={makeApprovalCard()}
        windowVisibility="show"
      />
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    });

    invokeMock.mockClear();
    hideWindowMock.mockClear();

    rerender(
      <ActivityCardRoute
        card={null}
        windowVisibility="keep"
      />
    );

    await Promise.resolve();

    expect(invokeMock).not.toHaveBeenCalledWith('hide_activity_card_window');
    expect(hideWindowMock).not.toHaveBeenCalled();
  });

  it('hides the native window when keep intent stays empty long enough to become a stale shell', async () => {
    const { rerender } = render(
      <ActivityCardRoute
        card={makeApprovalCard()}
        windowVisibility="show"
      />
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    });

    invokeMock.mockClear();
    hideWindowMock.mockClear();

    rerender(
      <ActivityCardRoute
        card={null}
        windowVisibility="keep"
      />
    );

    await new Promise((resolve) => {
      window.setTimeout(resolve, 300);
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });
    expect(hideWindowMock).not.toHaveBeenCalled();
  });

  it('hides an initially empty keep-intent activity-card shell after the stale delay', async () => {
    render(
      <ActivityCardRoute
        card={null}
        windowVisibility="keep"
      />
    );

    await new Promise((resolve) => {
      window.setTimeout(resolve, 300);
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });
    expect(hideWindowMock).not.toHaveBeenCalled();
  });

  it('reopens the live activity-card window when a new real card arrives after hiding', async () => {
    const { rerender } = render(<ActivityCardRoute card={makeApprovalCard('approval-1')} />);

    await waitFor(() => {
      expect(screen.getByText('@codex4 · Deploy approval needed')).toBeInTheDocument();
    });

    rerender(<ActivityCardRoute card={null} />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });
    invokeMock.mockClear();

    rerender(<ActivityCardRoute card={makeApprovalCard('approval-2')} />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    });
  });

  it('re-shows the live activity-card window when keep intent swaps in a new real card', async () => {
    const { rerender } = render(
      <ActivityCardRoute
        card={makeApprovalCard('approval-1')}
        windowVisibility="show"
      />
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    });

    invokeMock.mockClear();

    rerender(
      <ActivityCardRoute
        card={makeApprovalCard('approval-2')}
        windowVisibility="keep"
      />
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    });
  });

  it('renders a local preview approval card when preview=approval is present', async () => {
    window.history.pushState({}, '', '/?view=activity-card&preview=approval');

    render(<ActivityCardRoute card={makeQuestionCard()} />);

    await waitFor(() => {
      expect(screen.getByText('@codex3 · Claude wants to run Bash.')).toBeInTheDocument();
    });
    expect(screen.queryByText('@codex4 · Which target should I use?')).not.toBeInTheDocument();

    await waitFor(() => {
      const latestSize = setSizeMock.mock.calls.at(-1)?.[0] as { width: number; height: number } | undefined;
      expect(latestSize?.width).toBe(680);
      expect(latestSize?.height).toBe(336);
    });
  });

  it('asks Rust to show and position the activity-card window after local preview content mounts', async () => {
    window.history.pushState({}, '', '/?view=activity-card&preview=approval');

    render(<ActivityCardRoute card={null} />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    });
  });
});

describe('activity-card window routing', () => {
  it('keeps local preview activity cards out of the broker visibility lifecycle', async () => {
    window.history.pushState({}, '', '/?view=activity-card&preview=approval');

    const { App } = await import('../../../src/app/App');
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('@codex3 · Claude wants to run Bash.')).toBeInTheDocument();
    });

    expect(brokerClientConstructorMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith('hide_activity_card_window');
  });

  it('lets local preview activity cards close their own window manually', async () => {
    window.history.pushState({}, '', '/?view=activity-card&preview=approval');

    const { App } = await import('../../../src/app/App');
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('@codex3 · Claude wants to run Bash.')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close activity card' }));

    await waitFor(() => {
      expect(hideWindowMock).toHaveBeenCalledTimes(1);
    });
    expect(invokeMock).not.toHaveBeenCalledWith('hide_activity_card_window');
  });

  it('still hides the live activity-card window when dismiss bridge emit fails', async () => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [makeProjectParticipant()],
        workStates: [],
        events: [],
        approvals: [
          {
            approvalId: 'approval-dismiss-failure',
            taskId: 'task-dismiss-failure',
            summary: 'Dismiss should still close the live popup',
            decision: 'pending',
            participantId: 'codex.main',
          },
        ],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);
    emitMock.mockRejectedValueOnce(new Error('bridge unavailable'));

    window.history.pushState({}, '', '/?view=activity-card');

    const { App } = await import('../../../src/app/App');
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Dismiss should still close the live popup/ })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    });

    invokeMock.mockClear();
    hideWindowMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Close activity card' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });
    expect(screen.queryByRole('heading', { name: /Dismiss should still close the live popup/ })).not.toBeInTheDocument();
  });

  it('hides the whole live popup stack instead of promoting queued cards after manual close', async () => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [makeProjectParticipant()],
        workStates: [],
        events: [
          {
            id: 1,
            type: 'ask_clarification',
            taskId: 'task-queued-question',
            threadId: 'thread-queued-question',
            payload: {
              participantId: 'codex.main',
              summary: 'Queued follow-up question',
              prompt: 'Queued follow-up question',
              selectionMode: 'single-select',
              options: [{ label: 'staging', value: 'staging' }],
            },
          },
        ],
        approvals: [
          {
            approvalId: 'approval-close-stack',
            taskId: 'task-close-stack',
            summary: 'Dismiss should hide the whole popup stack',
            decision: 'pending',
            participantId: 'codex.main',
          },
        ],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    window.history.pushState({}, '', '/?view=activity-card');

    const { App } = await import('../../../src/app/App');
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Dismiss should hide the whole popup stack/ })).toBeInTheDocument();
    });

    invokeMock.mockClear();
    hideWindowMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Close activity card' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });
    expect(screen.queryByRole('heading', { name: /Dismiss should hide the whole popup stack/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Queued follow-up question')).not.toBeInTheDocument();
  });

  it('keeps passive startup backlog hidden for the floating activity-card window', async () => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [
          {
            participantId: 'codex.main',
            alias: 'codex4',
            kind: 'agent',
            tool: 'codex',
            metadata: {
              terminalApp: 'Ghostty',
              terminalSessionID: 'ghostty-1',
              projectPath: '/Users/song/projects/hexdeck',
            },
            context: { projectName: 'HexDeck' },
          },
        ],
        workStates: [],
        events: [
          {
            id: 1,
            type: 'ask_clarification',
            taskId: 'task-1',
            threadId: 'thread-1',
            payload: {
              participantId: 'codex.main',
              summary: 'Old startup question',
              prompt: 'Old startup question',
              selectionMode: 'single-select',
              options: [{ label: 'staging', value: 'staging' }],
            },
          },
        ],
        approvals: [],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    render(<App />);

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(1);
    });
    expect(invokeMock).not.toHaveBeenCalledWith('hide_activity_card_window');
    expect(invokeMock).not.toHaveBeenCalledWith('prepare_activity_card_window');
    expect(invokeMock).not.toHaveBeenCalledWith('show_activity_card_window');
  });

  it('shows pending startup approvals in panel mode so real agent hooks can be answered', async () => {
    const projectParticipants = [
      {
        participantId: 'codex.main',
        alias: 'codex4',
        kind: 'agent',
        tool: 'codex',
        metadata: {
          terminalApp: 'Ghostty',
          terminalSessionID: 'ghostty-1',
          projectPath: '/Users/song/projects/hexdeck',
        },
        context: { projectName: 'HexDeck' },
      },
    ];
    const initialServiceSeed = {
      health: { ok: true },
      participants: projectParticipants,
      workStates: [],
      events: [],
      approvals: [
        {
          approvalId: 'approval-old',
          taskId: 'task-old',
          summary: 'Old startup approval',
          decision: 'pending',
        },
      ],
    };

    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue(initialServiceSeed),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('prepare_activity_card_window');
    });
    expect(invokeMock).not.toHaveBeenCalledWith('show_activity_card_window');
  });

  it('shows fresh startup question and completion cards in panel mode instead of marking them as stale backlog', async () => {
    const participants = [
      makeProjectParticipant(),
      {
        participantId: 'xiaok.session',
        alias: 'xiaok4',
        kind: 'agent',
        tool: 'xiaok',
        metadata: {
          terminalApp: 'Ghostty',
          terminalSessionID: 'ghostty-xiaok',
          projectPath: '/Users/song/projects/xiaok-cli',
        },
        context: { projectName: 'xiaok-cli' },
      },
    ];

    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants,
        workStates: [],
        events: [
          {
            id: 710,
            type: 'ask_clarification',
            createdAt: new Date().toISOString(),
            taskId: 'fresh-startup-question',
            threadId: 'fresh-startup-thread',
            payload: {
              participantId: 'xiaok.session',
              summary: 'Fresh startup question',
              prompt: 'Fresh startup question',
              selectionMode: 'single-select',
              options: [{ label: 'Use fix', value: 'fixed' }],
            },
          },
          {
            id: 711,
            type: 'report_progress',
            createdAt: new Date().toISOString(),
            taskId: 'fresh-startup-completion',
            threadId: 'fresh-startup-completion-thread',
            payload: {
              participantId: 'xiaok.session',
              summary: 'Fresh startup completion',
              stage: 'completed',
            },
          },
        ],
        approvals: [],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('prepare_activity_card_window');
    });
    expect(invokeMock).not.toHaveBeenCalledWith('show_activity_card_window');
  });

  it('keeps passive startup backlog hidden in panel mode and only shows newly arrived floating cards after refresh', async () => {
    const projectParticipants = [
      {
        participantId: 'codex.main',
        alias: 'codex4',
        kind: 'agent',
        tool: 'codex',
        metadata: {
          terminalApp: 'Ghostty',
          terminalSessionID: 'ghostty-1',
          projectPath: '/Users/song/projects/hexdeck',
        },
        context: { projectName: 'HexDeck' },
      },
    ];
    const initialServiceSeed = {
      health: { ok: true },
      participants: projectParticipants,
      workStates: [],
      events: [
        {
          id: 1,
          type: 'ask_clarification',
          taskId: 'task-old',
          threadId: 'thread-old',
          payload: {
            participantId: 'codex.main',
            summary: 'Old startup question',
            prompt: 'Old startup question',
            selectionMode: 'single-select',
            options: [{ label: 'staging', value: 'staging' }],
          },
        },
      ],
      approvals: [],
    };
    const nextServiceSeed = {
      ...initialServiceSeed,
      approvals: [
        {
          approvalId: 'approval-new',
          taskId: 'task-new',
          summary: 'Fresh approval after startup',
          decision: 'pending',
        },
      ],
    };

    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValueOnce(initialServiceSeed).mockResolvedValueOnce(nextServiceSeed),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    render(<App />);

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(1);
    });
    expect(invokeMock).not.toHaveBeenCalledWith('hide_activity_card_window');
    expect(invokeMock).not.toHaveBeenCalledWith('prepare_activity_card_window');

    window.dispatchEvent(new Event('focus'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('prepare_activity_card_window');
    });
    expect(invokeMock).not.toHaveBeenCalledWith('hide_activity_card_window');
    expect(invokeMock).not.toHaveBeenCalledWith('show_activity_card_window');
  });

  it('does not try to hide the floating activity-card window when broker data has no active card', async () => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue(makeSeed()),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    render(<App />);

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(1);
    });
    expect(invokeMock).not.toHaveBeenCalledWith('hide_activity_card_window');
    expect(invokeMock).not.toHaveBeenCalledWith('prepare_activity_card_window');
    expect(invokeMock).not.toHaveBeenCalledWith('show_activity_card_window');
  });

  it('reopens the floating activity card route when view=activity-card after clearing the initial empty shell', async () => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [
          {
            participantId: 'codex.main',
            alias: 'codex4',
            kind: 'agent',
            tool: 'codex',
            metadata: {
              terminalApp: 'Ghostty',
              terminalSessionID: 'ghostty-1',
              projectPath: '/Users/song/projects/hexdeck',
            },
            context: { projectName: 'HexDeck' },
          },
        ],
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
      }),
      loadProjectSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [
          {
            participantId: 'codex.main',
            alias: 'codex4',
            kind: 'agent',
            tool: 'codex',
            metadata: {
              terminalApp: 'Ghostty',
              terminalSessionID: 'ghostty-1',
              projectPath: '/Users/song/projects/hexdeck',
            },
            context: { projectName: 'HexDeck' },
          },
        ],
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
      }),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument();
    });

    expect(screen.getByText('Deploy approval needed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Main Panel' })).not.toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    });
  });

  it('keeps the live activity-card window stable across a transient empty refresh for the same broker card', async () => {
    const approvalSeed = {
      health: { ok: true },
      participants: [makeProjectParticipant()],
      workStates: [],
      events: [],
      approvals: [
        {
          approvalId: 'approval-live',
          taskId: 'task-live',
          summary: 'Live approval request',
          decision: 'pending',
          participantId: 'codex.main',
        },
      ],
    };
    const emptySeed = {
      ...approvalSeed,
      approvals: [],
    };

    brokerClientInstance = {
      loadServiceSeed: vi.fn()
        .mockResolvedValueOnce(approvalSeed)
        .mockResolvedValueOnce(emptySeed)
        .mockResolvedValueOnce(approvalSeed),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '@codex4 · Live approval request' })).toBeInTheDocument();
    });

    invokeMock.mockClear();
    hideWindowMock.mockClear();

    await waitFor(
      () => {
        expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(2);
      },
      { timeout: 1_500 }
    );

    await waitFor(
      () => {
        expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(3);
      },
      { timeout: 1_500 }
    );

    expect(screen.getByRole('heading', { name: '@codex4 · Live approval request' })).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith('hide_activity_card_window');
    expect(invokeMock).not.toHaveBeenCalledWith('show_activity_card_window');
    expect(hideWindowMock).not.toHaveBeenCalled();
  });

  it('refreshes into a broker-owned Codex native approval when the native local approval event arrives', async () => {
    const localApproval = {
      approvalId: 'hexdeck-local-codex-host-codex-session-call_local',
      taskId: 'task-local',
      createdAt: new Date().toISOString(),
      summary: 'Local host approval request',
      decision: 'pending' as const,
      participantId: 'codex.main',
      actions: [
        { label: 'Allow once', decisionMode: 'yes' as const },
        { label: 'Reject', decisionMode: 'no' as const },
      ],
      body: {
        summary: 'Local host approval request',
        commandTitle: 'Codex',
        commandLine: 'mkdir ~/Desktop/hexdeck-codex-approval-refresh-test',
        commandPreview: '/Users/song/projects/hexdeck',
        delivery: { source: 'hexdeck-local-host-approval' },
        localHostApproval: { source: 'codex', callId: 'call_local' },
      },
    };
    const eventListeners = new Map<string, (event: { payload?: unknown }) => void>();
    const nativeApprovalSeed = {
      health: { ok: true },
      participants: [makeProjectParticipant()],
      workStates: [],
      events: [
        {
          id: 901,
          type: 'request_approval',
          createdAt: new Date().toISOString(),
          taskId: 'codex-native-task',
          threadId: 'codex-native-thread',
          payload: {
            approvalId: 'codex-native-call_local',
            participantId: 'codex.main',
            delivery: {
              semantic: 'actionable',
              source: 'codex-native-approval',
            },
            nativeCodexApproval: {
              callId: 'call_local',
            },
            body: {
              summary: 'Allow Desktop mkdir?',
              detailText: 'Mirrored from the live Codex terminal approval prompt.',
              commandTitle: 'Codex',
              commandLine: 'mkdir ~/Desktop/hexdeck-codex-approval-refresh-test',
            },
            actions: [
              { label: 'Allow once', decisionMode: 'yes' as const },
              { label: 'Reject', decisionMode: 'no' as const },
            ],
          },
        },
      ],
      approvals: [
        localApproval,
      ],
    };

    listenMock.mockImplementation(async (eventName, handler) => {
      eventListeners.set(String(eventName), handler as (event: { payload?: unknown }) => void);
      return () => {
        eventListeners.delete(String(eventName));
      };
    });

    brokerClientInstance = {
      loadServiceSeed: vi.fn()
        .mockResolvedValueOnce(makeSeed())
        .mockResolvedValueOnce(nativeApprovalSeed),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(1);
    });

    invokeMock.mockClear();

    const localApprovalListener = eventListeners.get('activity-card-local-approval-requested');
    expect(localApprovalListener).toBeTypeOf('function');

    localApprovalListener?.({
      payload: localApproval,
    });

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '@codex4 · Allow Desktop mkdir?' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('heading', { name: '@codex4 · Local host approval request' })).not.toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
  });

  it('replaces an older visible approval with the refreshed broker-owned Codex native approval when the native event arrives', async () => {
    const firstSeed = {
      health: { ok: true },
      participants: [
        makeProjectParticipant(),
        {
          participantId: 'claude.other',
          alias: 'claude7',
          kind: 'agent',
          tool: 'claude-code',
          metadata: {
            terminalApp: 'Ghostty',
            terminalSessionID: 'ghostty-7',
            projectPath: '/Users/song/projects',
          },
          context: { projectName: 'projects' },
        },
      ],
      workStates: [],
      events: [
        {
          id: 410,
          type: 'request_approval',
          createdAt: '2026-04-21T04:10:00.000Z',
          taskId: 'claude-approval-task',
          threadId: 'claude-approval-thread',
          payload: {
            approvalId: 'claude-approval',
            participantId: 'claude.other',
            body: {
              summary: 'Claude approval already visible',
            },
          },
        },
      ],
      approvals: [],
    };
    const localApproval = {
      approvalId: 'hexdeck-local-codex-host-codex-session-call_local',
      taskId: 'task-local',
      createdAt: new Date().toISOString(),
      summary: 'Local host approval request',
      decision: 'pending' as const,
      participantId: 'codex.main',
      actions: [
        { label: 'Allow once', decisionMode: 'yes' as const },
        { label: 'Reject', decisionMode: 'no' as const },
      ],
      body: {
        summary: 'Local host approval request',
        commandTitle: 'Codex',
        commandLine: 'mkdir ~/Desktop/hexdeck-codex-approval-refresh-test-2',
        commandPreview: '/Users/song/projects/hexdeck',
        delivery: { source: 'hexdeck-local-host-approval' },
        localHostApproval: { source: 'codex', callId: 'call_local' },
      },
    };
    const eventListeners = new Map<string, (event: { payload?: unknown }) => void>();
    const refreshedSeed = {
      ...firstSeed,
      events: [
        ...firstSeed.events,
        {
          id: 411,
          type: 'request_approval',
          createdAt: new Date().toISOString(),
          taskId: 'codex-native-task',
          threadId: 'codex-native-thread',
          payload: {
            approvalId: 'codex-native-call_local',
            participantId: 'codex.main',
            delivery: {
              semantic: 'actionable',
              source: 'codex-native-approval',
            },
            nativeCodexApproval: {
              callId: 'call_local',
            },
            body: {
              summary: 'Broker-owned native approval request',
              commandTitle: 'Codex',
              commandLine: 'mkdir ~/Desktop/hexdeck-codex-approval-refresh-test-2',
            },
            actions: [
              { label: 'Allow once', decisionMode: 'yes' as const },
              { label: 'Reject', decisionMode: 'no' as const },
            ],
          },
        },
      ],
      approvals: [
        localApproval,
      ],
    };

    listenMock.mockImplementation(async (eventName, handler) => {
      eventListeners.set(String(eventName), handler as (event: { payload?: unknown }) => void);
      return () => {
        eventListeners.delete(String(eventName));
      };
    });

    brokerClientInstance = {
      loadServiceSeed: vi.fn()
        .mockResolvedValueOnce(firstSeed)
        .mockResolvedValueOnce(refreshedSeed),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '@claude7 · Claude approval already visible' })).toBeInTheDocument();
    });

    invokeMock.mockClear();

    const localApprovalListener = eventListeners.get('activity-card-local-approval-requested');
    expect(localApprovalListener).toBeTypeOf('function');

    localApprovalListener?.({
      payload: localApproval,
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '@codex4 · Broker-owned native approval request' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('heading', { name: '@claude7 · Claude approval already visible' })).not.toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
  });

  it('replaces a visible completion with a later approval without hiding the popup', async () => {
    const completionSeed = {
      health: { ok: true },
      participants: [makeProjectParticipant()],
      workStates: [],
      events: [
        {
          id: 301,
          type: 'report_progress',
          createdAt: new Date().toISOString(),
          taskId: 'completion-task',
          threadId: 'completion-thread',
          payload: {
            participantId: 'codex.main',
            summary: 'Real completion',
            stage: 'completed',
          },
        },
      ],
      approvals: [],
    };
    const approvalSeed = {
      ...completionSeed,
      approvals: [
        {
          approvalId: 'approval-live',
          taskId: 'approval-task',
          summary: 'Live approval request',
          decision: 'pending',
          participantId: 'codex.main',
        },
      ],
    };

    brokerClientInstance = {
      loadServiceSeed: vi.fn()
        .mockResolvedValueOnce(completionSeed)
        .mockResolvedValueOnce(approvalSeed),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '@codex4 · Real completion' })).toBeInTheDocument();
    });

    invokeMock.mockClear();
    hideWindowMock.mockClear();

    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: '@codex4 · Live approval request' })).toBeInTheDocument();
      },
      { timeout: 1_500 }
    );

    expect(invokeMock).not.toHaveBeenCalledWith('hide_activity_card_window');
    expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    expect(hideWindowMock).not.toHaveBeenCalled();
  });

  it('replaces a visible approval with a newer approval without hiding the popup', async () => {
    const firstSeed = {
      health: { ok: true },
      participants: [
        makeProjectParticipant(),
        {
          participantId: 'claude.other',
          alias: 'claude7',
          kind: 'agent',
          tool: 'claude',
          metadata: {
            terminalApp: 'Ghostty',
            terminalSessionID: 'ghostty-7',
            projectPath: '/Users/song/projects',
          },
          context: { projectName: 'projects' },
        },
      ],
      workStates: [],
      events: [
        {
          id: 410,
          type: 'request_approval',
          createdAt: '2026-04-21T04:10:00.000Z',
          taskId: 'claude-approval-task',
          threadId: 'claude-approval-thread',
          payload: {
            approvalId: 'claude-approval',
            participantId: 'claude.other',
            body: {
              summary: 'Claude approval already visible',
            },
          },
        },
      ],
      approvals: [],
    };
    const secondSeed = {
      ...firstSeed,
      participants: [
        ...firstSeed.participants,
        {
          participantId: 'xiaok.session',
          alias: 'xiaok4',
          kind: 'agent',
          tool: 'xiaok',
          metadata: {
            terminalApp: 'Ghostty',
            terminalSessionID: 'ghostty-xiaok',
            projectPath: '/Users/song/projects/xiaok-cli',
          },
          context: { projectName: 'xiaok-cli' },
        },
      ],
      events: [
        ...firstSeed.events,
        {
          id: 411,
          type: 'request_approval',
          createdAt: '2026-04-21T04:10:10.000Z',
          taskId: 'xiaok-approval-task',
          threadId: 'xiaok-approval-thread',
          payload: {
            approvalId: 'xiaok-approval',
            participantId: 'xiaok.session',
            body: {
              summary: 'Xiaok newer approval',
            },
          },
        },
      ],
    };

    brokerClientInstance = {
      loadServiceSeed: vi.fn()
        .mockResolvedValueOnce(firstSeed)
        .mockResolvedValueOnce(secondSeed),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '@claude7 · Claude approval already visible' })).toBeInTheDocument();
    });

    invokeMock.mockClear();
    hideWindowMock.mockClear();

    await waitFor(
      () => {
        expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(2);
      },
      { timeout: 1_500 }
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '@xiaok4 · Xiaok newer approval' })).toBeInTheDocument();
    });

    expect(invokeMock).not.toHaveBeenCalledWith('hide_activity_card_window');
    expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    expect(hideWindowMock).not.toHaveBeenCalled();
  });

  it('does not open broker realtime in the live activity-card window', async () => {
    const approvalSeed = {
      health: { ok: true },
      participants: [makeProjectParticipant()],
      workStates: [],
      events: [],
      approvals: [
        {
          approvalId: 'approval-live',
          taskId: 'task-live',
          summary: 'Live approval request',
          decision: 'pending',
          participantId: 'codex.main',
        },
      ],
    };

    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue(approvalSeed),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(1);
    });

    expect(brokerClientInstance.connectRealtime).not.toHaveBeenCalled();
  });

  it('refetches broker seed when the live activity-card window fires focus or visibility events', async () => {
    const approvalSeed = {
      health: { ok: true },
      participants: [makeProjectParticipant()],
      workStates: [],
      events: [],
      approvals: [
        {
          approvalId: 'approval-live',
          taskId: 'task-live',
          summary: 'Live approval request',
          decision: 'pending',
          participantId: 'codex.main',
        },
      ],
    };

    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue(approvalSeed),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(1);
    });

    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(3);
    });
  });

  it('ignores non-popup realtime events in the live activity-card window', async () => {
    const realtimeListenerRef: { current: ((event: unknown) => void) | null } = { current: null };
    const approvalSeed = {
      health: { ok: true },
      participants: [makeProjectParticipant()],
      workStates: [],
      events: [],
      approvals: [
        {
          approvalId: 'approval-live',
          taskId: 'task-live',
          summary: 'Live approval request',
          decision: 'pending',
          participantId: 'codex.main',
        },
      ],
    };

    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue(approvalSeed),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        realtimeListenerRef.current = listener;
        return () => undefined;
      }),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(1);
    });

    realtimeListenerRef.current?.({ id: 9301, type: 'participant_online' });

    await new Promise((resolve) => {
      window.setTimeout(resolve, 50);
    });

    expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(1);
  });

  it('hides an empty live activity-card window on first boot when broker returns no cards', async () => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue(makeSeed()),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });
  });

  it.each([
    {
      kind: 'approval',
      seed: {
        health: { ok: true },
        participants: [makeProjectParticipant()],
        workStates: [],
        events: [],
        approvals: [
          {
            approvalId: 'approval-real',
            taskId: 'task-real',
            summary: 'Real approval request',
            decision: 'pending',
            participantId: 'codex.main',
          },
        ],
      },
      heading: '@codex4 · Real approval request',
    },
    {
      kind: 'question',
      seed: {
        health: { ok: true },
        participants: [makeProjectParticipant()],
        workStates: [],
        events: [
          {
            id: 201,
            type: 'ask_clarification',
            createdAt: new Date().toISOString(),
            taskId: 'question-task',
            threadId: 'question-thread',
            payload: {
              participantId: 'codex.main',
              summary: 'Real question',
              prompt: 'Real question',
              selectionMode: 'single-select',
              options: [{ label: 'Use staging', value: 'staging' }],
            },
          },
        ],
        approvals: [],
      },
      heading: '@codex4 · Real question',
    },
    {
      kind: 'completion',
      seed: {
        health: { ok: true },
        participants: [makeProjectParticipant()],
        workStates: [],
        events: [
          {
            id: 301,
            type: 'report_progress',
            createdAt: new Date().toISOString(),
            taskId: 'completion-task',
            threadId: 'completion-thread',
            payload: {
              participantId: 'codex.main',
              summary: 'Real completion',
              stage: 'completed',
            },
          },
        ],
        approvals: [],
      },
      heading: '@codex4 · Real completion',
    },
  ])('shows a native activity-card window for real broker $kind messages', async ({ seed, heading }) => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue(seed),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    });
  });

  it('shows a native activity-card window for mirrored codex hook approvals with the default summary', async () => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [makeProjectParticipant()],
        workStates: [],
        events: [
          {
            id: 111,
            type: 'request_approval',
            createdAt: new Date().toISOString(),
            taskId: 'codex-hook-approval-task',
            threadId: 'codex-hook-approval-thread',
            payload: {
              participantId: 'codex.main',
              approvalId: 'codex-hook-approval-1',
              delivery: {
                semantic: 'actionable',
                source: 'codex-hook-approval',
              },
              nativeHookApproval: {
                agentTool: 'codex',
                hookEventName: 'PreToolUse',
              },
              body: {
                summary: 'Codex needs approval to run Bash.',
                detailText: 'Mirrored from the live Codex PreToolUse hook. Approving this card lets the hook continue.',
                commandTitle: 'Codex',
                commandLine: 'mkdir -p /tmp/important-dir',
              },
              actions: [
                { label: '允许一次', decisionMode: 'yes' },
                { label: '拒绝', decisionMode: 'no' },
              ],
            },
          },
        ],
        approvals: [],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '@codex4 · Codex needs approval to run Bash.' })).toBeInTheDocument();
    });

    expect(screen.getByText('Mirrored from the live Codex PreToolUse hook. Approving this card lets the hook continue.')).toBeInTheDocument();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    });
  });

  it('prefers the broker-owned Codex hook approval card over the local fallback approval and routes clicks through the broker approval id', async () => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn()
        .mockResolvedValueOnce({
          health: { ok: true },
          participants: [makeProjectParticipant()],
          workStates: [],
          events: [
            {
              id: 112,
              type: 'request_approval',
              createdAt: new Date().toISOString(),
              taskId: 'codex-hook-approval-task',
              threadId: 'codex-hook-approval-thread',
              payload: {
                participantId: 'codex.main',
                approvalId: 'codex-hook-approval-1',
                delivery: {
                  semantic: 'actionable',
                  source: 'codex-hook-approval',
                },
                nativeHookApproval: {
                  agentTool: 'codex',
                  hookEventName: 'PreToolUse',
                },
                body: {
                  summary: 'Codex needs approval to run Bash.',
                  detailText: 'Mirrored from the live Codex PreToolUse hook. Approving this card lets the hook continue.',
                  commandTitle: 'Codex',
                  commandLine: 'rm -f ~/Desktop/hexdeck-approval-smoke.txt',
                  commandPreview: '/Users/song/projects/hexdeck',
                },
                actions: [
                  { label: '允许一次', decisionMode: 'yes' },
                  { label: '拒绝', decisionMode: 'no' },
                ],
              },
            },
          ],
          approvals: [
            {
              approvalId: 'hexdeck-local-codex-host-codex-main-call_1',
              taskId: 'local-host-approval-codex-main-call_1',
              threadId: 'local-host-approval-codex-main',
              summary: 'Do you want to allow this command?',
              decision: 'pending',
              participantId: 'codex.main',
              actions: [
                { label: 'Allow once', decisionMode: 'yes' },
                { label: 'Reject', decisionMode: 'no' },
              ],
              body: {
                summary: 'Do you want to allow this command?',
                commandTitle: 'Codex',
                commandLine: 'rm -f ~/Desktop/hexdeck-approval-smoke.txt',
                commandPreview: '/Users/song/projects/hexdeck',
                participantId: 'codex.main',
                localHostApproval: {
                  source: 'codex',
                  callId: 'call_1',
                  terminalApp: 'Ghostty',
                  terminalSessionId: 'ghostty-1',
                },
                delivery: {
                  semantic: 'actionable',
                  source: 'hexdeck-local-host-approval',
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce(makeSeed()),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '@codex4 · Codex needs approval to run Bash.' })).toBeInTheDocument();
    });

    expect(screen.getByText('Mirrored from the live Codex PreToolUse hook. Approving this card lets the hook continue.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));

    await waitFor(() => {
      expect(brokerClientInstance.respondToApproval).toHaveBeenCalledWith({
        approvalId: 'codex-hook-approval-1',
        taskId: 'codex-hook-approval-task',
        fromParticipantId: 'human.local',
        decision: 'approved',
        decisionMode: 'yes',
      });
    });
  });

  it('does not revive stale question and completion replay cards when the activity-card window boots', async () => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [makeProjectParticipant()],
        workStates: [],
        events: [
          {
            id: 101,
            type: 'ask_clarification',
            createdAt: '2000-01-01T00:00:00.000Z',
            taskId: 'question-task',
            threadId: 'question-thread',
            payload: {
              participantId: 'codex.main',
              summary: 'Old question',
              prompt: 'Old question',
              selectionMode: 'single-select',
              options: [{ label: 'A', value: 'a' }],
            },
          },
          {
            id: 102,
            type: 'report_progress',
            createdAt: '2000-01-01T00:00:00.000Z',
            taskId: 'completion-task',
            threadId: 'completion-thread',
            payload: {
              participantId: 'codex.main',
              summary: 'Old completion',
              stage: 'completed',
            },
          },
        ],
        approvals: [],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });

    expect(screen.queryByText('Old question')).not.toBeInTheDocument();
    expect(screen.queryByText('Old completion')).not.toBeInTheDocument();
    expect(screen.queryByText('No active activity card')).not.toBeInTheDocument();
  });

  it('does not revive question and completion replay cards without createdAt when the activity-card window boots', async () => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [makeProjectParticipant()],
        workStates: [],
        events: [
          {
            id: 111,
            type: 'ask_clarification',
            taskId: 'question-task',
            threadId: 'question-thread',
            payload: {
              participantId: 'codex.main',
              summary: 'Question without createdAt',
              prompt: 'Question without createdAt',
              selectionMode: 'single-select',
              options: [{ label: 'Use fix', value: 'fixed' }],
            },
          },
          {
            id: 112,
            type: 'report_progress',
            taskId: 'completion-task',
            threadId: 'completion-thread',
            payload: {
              participantId: 'codex.main',
              summary: 'Completion without createdAt',
              stage: 'completed',
            },
          },
        ],
        approvals: [],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });

    expect(screen.queryByText('Question without createdAt')).not.toBeInTheDocument();
    expect(screen.queryByText('Completion without createdAt')).not.toBeInTheDocument();
  });

  it('shows a fresh completion that arrived before the activity-card child window finished booting', async () => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [makeProjectParticipant()],
        workStates: [],
        events: [
          {
            id: 401,
            type: 'report_progress',
            createdAt: new Date(Date.now() - 30_000).toISOString(),
            taskId: 'completion-task',
            threadId: 'completion-thread',
            payload: {
              participantId: 'codex.main',
              summary: 'Slightly delayed completion',
              stage: 'completed',
            },
          },
        ],
        approvals: [],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '@codex4 · Slightly delayed completion' })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    });
  });

  it('does not show a stop-fallback completion popup while the same participant is still actively working', async () => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [makeProjectParticipant()],
        workStates: [
          {
            participantId: 'codex.main',
            status: 'implementing',
            summary: 'Still handling follow-up work',
          },
        ],
        events: [
          {
            id: 402,
            type: 'report_progress',
            createdAt: new Date().toISOString(),
            taskId: 'completion-task',
            threadId: 'completion-thread',
            payload: {
              participantId: 'codex.main',
              summary: '✅ Spec compliant',
              stage: 'completed',
              delivery: {
                semantic: 'informational',
                source: 'stop-fallback',
              },
            },
          },
        ],
        approvals: [],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });

    expect(screen.queryByText('✅ Spec compliant')).not.toBeInTheDocument();
  });

  it('opens the live activity-card window when a real xiaok question arrives after boot even without createdAt', async () => {
    const initialSeed = {
      health: { ok: true },
      participants: [makeProjectParticipant()],
      workStates: [],
      events: [],
      approvals: [],
    };
    const xiaokSeed = {
      health: { ok: true },
      participants: [
        makeProjectParticipant(),
        {
          participantId: 'xiaok-code-session-019da8e2',
          alias: 'xiaok3',
          kind: 'agent',
          tool: 'xiaok',
          metadata: {
            terminalApp: 'Ghostty',
            terminalSessionID: 'ghostty-xiaok',
            projectPath: '/Users/song/projects/xiaok-cli',
          },
          context: { projectName: 'xiaok-cli' },
        },
      ],
      workStates: [],
      events: [
        {
          id: 16370,
          type: 'ask_clarification',
          taskId: 'hexdeck-live-xiaok-q-20260421',
          threadId: 'hexdeck-live-xiaok-q-20260421',
          fromParticipantId: 'xiaok-code-session-019da8e2',
          payload: {
            participantId: 'xiaok-code-session-019da8e2',
            body: {
              summary: 'HexDeck live xiaok question',
              prompt: 'Continue Stop',
              selectionMode: 'single-select',
              options: [
                { value: 'continue', label: '继续', description: '继续执行当前计划' },
                { value: 'pause', label: '先停一下', description: '先不要继续执行' },
              ],
            },
          },
        },
      ],
      approvals: [],
    };

    brokerClientInstance = {
      loadServiceSeed: vi.fn()
        .mockResolvedValueOnce(initialSeed)
        .mockResolvedValue(xiaokSeed),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });

    invokeMock.mockClear();
    showWindowMock.mockClear();

    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: '@xiaok3 · HexDeck live xiaok question' })).toBeInTheDocument();
      },
      { timeout: 1_500 }
    );

    expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
  });

  it.each([
    {
      kind: 'question',
      event: {
        id: 501,
        type: 'ask_clarification',
        createdAt: new Date().toISOString(),
        taskId: 'question-live-task',
        threadId: 'question-live-thread',
        payload: {
          participantId: 'codex.main',
          summary: 'Realtime question',
          prompt: 'Realtime question',
          selectionMode: 'single-select',
          options: [{ label: 'Use fix', value: 'fixed' }],
        },
      },
    },
    {
      kind: 'completion',
      event: {
        id: 502,
        type: 'report_progress',
        createdAt: new Date().toISOString(),
        taskId: 'completion-live-task',
        threadId: 'completion-live-thread',
        payload: {
          participantId: 'codex.main',
          summary: 'Realtime completion',
          stage: 'completed',
        },
      },
    },
  ])('opens the native activity-card window when a realtime $kind arrives after panel boot', async ({ event }) => {
    const realtimeListenerRef: { current: ((event: unknown) => void) | null } = { current: null };
    const initialSeed = {
      health: { ok: true },
      participants: [makeProjectParticipant()],
      workStates: [],
      events: [],
      approvals: [],
    };
    const realtimeSeed = {
      ...initialSeed,
      events: [event],
    };
    brokerClientInstance = {
      loadServiceSeed: vi.fn()
        .mockResolvedValueOnce(initialSeed)
        .mockResolvedValue(realtimeSeed),
      loadProjectSeed: vi.fn()
        .mockResolvedValueOnce(initialSeed)
        .mockResolvedValue(realtimeSeed),
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        realtimeListenerRef.current = listener;
        return () => undefined;
      }),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/');

    render(<App />);

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(1);
    });
    invokeMock.mockClear();

    realtimeListenerRef.current?.({ id: event.id, type: event.type });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('prepare_activity_card_window');
    });
    expect(invokeMock).not.toHaveBeenCalledWith('show_activity_card_window');
  });

  it.each([
    {
      kind: 'approval',
      realtimeSeedPatch: {
        events: [],
        approvals: [
          {
            approvalId: 'xiaok-approval',
            taskId: 'xiaok-approval-task',
            summary: 'Xiaok approval from another project',
            decision: 'pending',
            participantId: 'xiaok.session',
          },
        ],
      },
      realtimeEvent: { id: 700, type: 'request_approval' },
    },
    {
      kind: 'question',
      realtimeSeedPatch: {
        events: [
          {
            id: 701,
            type: 'ask_clarification',
            createdAt: new Date().toISOString(),
            taskId: 'xiaok-question-task',
            threadId: 'xiaok-question-thread',
            payload: {
              participantId: 'xiaok.session',
              summary: 'Xiaok question from another project',
              prompt: 'Xiaok question from another project',
              selectionMode: 'single-select',
              options: [{ label: 'Use fix', value: 'fixed' }],
            },
          },
        ],
        approvals: [],
      },
      realtimeEvent: { id: 701, type: 'ask_clarification' },
    },
    {
      kind: 'completion',
      realtimeSeedPatch: {
        events: [
          {
            id: 702,
            type: 'report_progress',
            createdAt: new Date().toISOString(),
            taskId: 'xiaok-completion-task',
            threadId: 'xiaok-completion-thread',
            payload: {
              participantId: 'xiaok.session',
              summary: 'Xiaok completion from another project',
              stage: 'completed',
            },
          },
        ],
        approvals: [],
      },
      realtimeEvent: { id: 702, type: 'report_progress' },
    },
  ])('opens $kind floating cards from any project regardless of the panel project filter', async ({
    realtimeSeedPatch,
    realtimeEvent,
  }) => {
    loadLocalSettingsMock.mockReturnValue({
      brokerUrl: 'http://broker.test',
      globalShortcut: 'CmdOrCtrl+Shift+H',
      currentProject: 'HexDeck',
      recentProjects: ['HexDeck'],
    });

    const realtimeListenerRef: { current: ((event: unknown) => void) | null } = { current: null };
    const participants = [
      makeProjectParticipant(),
      {
        participantId: 'xiaok.session',
        alias: 'xiaok4',
        kind: 'agent',
        tool: 'xiaok',
        metadata: {
          terminalApp: 'Ghostty',
          terminalSessionID: 'ghostty-xiaok',
          projectPath: '/Users/song/projects/xiaok-cli',
        },
        context: { projectName: 'xiaok-cli' },
      },
    ];
    const initialSeed = {
      health: { ok: true },
      participants,
      workStates: [],
      events: [],
      approvals: [],
    };
    const realtimeSeed = {
      ...initialSeed,
      ...realtimeSeedPatch,
    };

    brokerClientInstance = {
      loadServiceSeed: vi.fn()
        .mockResolvedValueOnce(initialSeed)
        .mockResolvedValue(realtimeSeed),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        realtimeListenerRef.current = listener;
        return () => undefined;
      }),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/');

    render(<App />);

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(1);
    });
    invokeMock.mockClear();

    realtimeListenerRef.current?.(realtimeEvent);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('prepare_activity_card_window');
    });
    expect(brokerClientInstance.loadProjectSeed).not.toHaveBeenCalled();
  });

  it('hides the floating activity-card window after approving the last live startup approval', async () => {
    const projectParticipants = [
      {
        participantId: 'codex.main',
        alias: 'codex4',
        kind: 'agent',
        tool: 'codex',
        metadata: {
          terminalApp: 'Ghostty',
          terminalSessionID: 'ghostty-1',
          projectPath: '/Users/song/projects/hexdeck',
        },
        context: { projectName: 'HexDeck' },
      },
    ];
    const serviceSeed = {
      health: { ok: true },
      participants: projectParticipants,
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
    };

    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue(serviceSeed),
      loadProjectSeed: vi.fn()
        .mockResolvedValueOnce(serviceSeed)
        .mockResolvedValueOnce(serviceSeed),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));

    await waitFor(() => {
      expect(brokerClientInstance.respondToApproval).toHaveBeenCalledWith({
        approvalId: 'approval-1',
        taskId: 'task-1',
        fromParticipantId: 'human.local',
        decision: 'approved',
        decisionMode: 'yes',
      });
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });
  });

  it('hides the floating activity-card window after answering the last live question', async () => {
    const serviceSeed = {
      health: { ok: true },
      participants: [makeProjectParticipant()],
      workStates: [],
      events: [
        {
          id: 1201,
          type: 'ask_clarification',
          createdAt: new Date().toISOString(),
          taskId: 'question-task',
          threadId: 'question-thread',
          payload: {
            participantId: 'codex.main',
            summary: 'Ship the current fix?',
            prompt: 'Ship the current fix?',
            selectionMode: 'single-select',
            options: [{ label: 'Ship it', value: 'ship-it' }],
          },
        },
      ],
      approvals: [],
    };

    brokerClientInstance = {
      loadServiceSeed: vi.fn()
        .mockResolvedValueOnce(serviceSeed)
        .mockResolvedValueOnce({
          ...serviceSeed,
          events: [],
        }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Ship it' })).toBeInTheDocument();
    });

    invokeMock.mockClear();
    hideWindowMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Ship it' }));

    await waitFor(() => {
      expect(brokerClientInstance.answerClarification).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });
  });

  it('hides the floating activity-card window instead of leaving an empty shell when an answered question lingers in the next seed refresh', async () => {
    const lingeringQuestionSeed = {
      health: { ok: true },
      participants: [makeProjectParticipant()],
      workStates: [],
      events: [
        {
          id: 1301,
          type: 'ask_clarification',
          createdAt: new Date().toISOString(),
          taskId: 'question-task',
          threadId: 'question-thread',
          payload: {
            participantId: 'codex.main',
            summary: 'Ship the current fix?',
            prompt: 'Ship the current fix?',
            selectionMode: 'single-select',
            options: [{ label: 'Ship it', value: 'ship-it' }],
          },
        },
      ],
      approvals: [],
    };

    brokerClientInstance = {
      loadServiceSeed: vi.fn()
        .mockResolvedValueOnce(lingeringQuestionSeed)
        .mockResolvedValueOnce(lingeringQuestionSeed),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Ship it' })).toBeInTheDocument();
    });

    invokeMock.mockClear();
    hideWindowMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Ship it' }));

    await waitFor(() => {
      expect(brokerClientInstance.answerClarification).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });

    expect(screen.queryByRole('button', { name: 'Ship it' })).not.toBeInTheDocument();
  });

  it('shows only the latest highest-priority card when the activity-card window boots with backlog', async () => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [
          {
            participantId: 'codex.main',
            alias: 'codex4',
            kind: 'agent',
            tool: 'codex',
            metadata: {
              terminalApp: 'Ghostty',
              terminalSessionID: 'ghostty-1',
              projectPath: '/Users/song/projects/hexdeck',
            },
            context: { projectName: 'HexDeck' },
          },
        ],
        workStates: [],
        events: [
          {
            id: 101,
            type: 'ask_clarification',
            taskId: 'question-task',
            threadId: 'question-thread',
            payload: {
              participantId: 'codex.main',
              summary: 'Old question',
              prompt: 'Old question',
              selectionMode: 'single-select',
              options: [{ label: 'A', value: 'a' }],
            },
          },
          {
            id: 102,
            type: 'request_approval',
            taskId: 'approval-task-old',
            threadId: 'approval-thread-old',
            payload: {
              approvalId: 'approval-old',
              participantId: 'codex.main',
              body: {
                summary: 'Old approval',
              },
            },
          },
          {
            id: 103,
            type: 'request_approval',
            taskId: 'approval-task-new',
            threadId: 'approval-thread-new',
            payload: {
              approvalId: 'approval-new',
              participantId: 'codex.main',
              body: {
                summary: 'Newest approval',
              },
            },
          },
        ],
        approvals: [],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '@codex4 · Newest approval' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('heading', { name: '@codex4 · Old approval' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '@codex4 · Old question' })).not.toBeInTheDocument();
  });

  it('keeps floating activity cards on the all-agent service replay even when a saved project exists', async () => {
    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [
          {
            participantId: 'claude.other',
            alias: 'claude7',
            kind: 'agent',
            tool: 'claude',
            metadata: {
              terminalApp: 'Ghostty',
              terminalSessionID: 'ghostty-7',
              projectPath: '/Users/song/projects',
            },
            context: { projectName: 'projects' },
          },
          {
            participantId: 'codex.main',
            alias: 'codex4',
            kind: 'agent',
            tool: 'codex',
            metadata: {
              terminalApp: 'Ghostty',
              terminalSessionID: 'ghostty-1',
              projectPath: '/Users/song/projects/hexdeck',
            },
            context: { projectName: 'HexDeck' },
          },
        ],
        workStates: [],
        events: [],
        approvals: [
          {
            approvalId: 'approval-service',
            taskId: 'task-service',
            summary: 'Service-wide approval',
            decision: 'pending',
          },
        ],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [
          {
            participantId: 'codex.main',
            alias: 'codex4',
            kind: 'agent',
            tool: 'codex',
            metadata: {
              terminalApp: 'Ghostty',
              terminalSessionID: 'ghostty-1',
              projectPath: '/Users/song/projects/hexdeck',
            },
            context: { projectName: 'HexDeck' },
          },
        ],
        workStates: [],
        events: [],
        approvals: [
          {
            approvalId: 'approval-project',
            taskId: 'task-project',
            summary: 'Project-scoped approval',
            decision: 'pending',
          },
        ],
      }),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Service-wide approval')).toBeInTheDocument();
    });

    expect(screen.queryByText('Project-scoped approval')).not.toBeInTheDocument();
    expect(brokerClientInstance.loadProjectSeed).not.toHaveBeenCalled();
  });

  it('keeps all-project approvals visible when All agents is selected', async () => {
    loadLocalSettingsMock.mockReturnValue({
      brokerUrl: 'http://broker.test',
      globalShortcut: 'CmdOrCtrl+Shift+H',
      currentProject: '__all_agents__',
      recentProjects: [],
    });

    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [
          {
            participantId: 'codex.other',
            alias: 'codex2',
            kind: 'agent',
            tool: 'codex',
            metadata: {
              terminalApp: 'Ghostty',
              terminalSessionID: 'ghostty-2',
              projectPath: '/Users/song/projects',
            },
            context: { projectName: 'projects' },
          },
          {
            participantId: 'codex.main',
            alias: 'codex4',
            kind: 'agent',
            tool: 'codex',
            metadata: {
              terminalApp: 'Ghostty',
              terminalSessionID: 'ghostty-1',
              projectPath: '/Users/song/projects/hexdeck',
            },
            context: { projectName: 'HexDeck' },
          },
        ],
        workStates: [],
        events: [
          {
            id: 1,
            type: 'request_approval',
            taskId: 'task-projects',
            threadId: 'thread-projects',
            payload: {
              participantId: 'codex.other',
              approvalId: 'approval-projects',
              body: {
                summary: 'Projects approval',
              },
            },
          },
        ],
        approvals: [],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('@codex2 · Projects approval')).toBeInTheDocument();
    });

    expect(brokerClientInstance.loadProjectSeed).not.toHaveBeenCalled();
  });

  it('keeps cross-project completion cards visible even when a saved project exists', async () => {
    loadLocalSettingsMock.mockReturnValue({
      brokerUrl: 'http://broker.test',
      globalShortcut: 'CmdOrCtrl+Shift+H',
      currentProject: 'HexDeck',
      recentProjects: ['HexDeck'],
    });

    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [
          {
            participantId: 'codex.main',
            alias: 'codex4',
            kind: 'agent',
            tool: 'codex',
            metadata: {
              terminalApp: 'Ghostty',
              terminalSessionID: 'ghostty-1',
              projectPath: '/Users/song/projects/hexdeck',
            },
            context: { projectName: 'hexdeck' },
          },
        ],
        workStates: [],
        events: [
          {
            id: 900,
            type: 'report_progress',
            createdAt: new Date().toISOString(),
            taskId: 'task-claude5',
            threadId: 'thread-claude5',
            payload: {
              participantId: 'claude.other',
              stage: 'completed',
              body: {
                summary: 'Claude 7 completed the task',
              },
            },
          },
        ],
        approvals: [],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Claude 7 completed the task' })).toBeInTheDocument();
    });
    expect(brokerClientInstance.loadProjectSeed).not.toHaveBeenCalled();
  });

  it('suppresses cross-project queued-context local approvals when a specific current project is saved', async () => {
    loadLocalSettingsMock.mockReturnValue({
      brokerUrl: 'http://broker.test',
      globalShortcut: 'CmdOrCtrl+Shift+H',
      currentProject: 'HexDeck',
      recentProjects: ['HexDeck'],
    });

    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [
          {
            participantId: 'codex.other',
            alias: 'codex5',
            kind: 'agent',
            tool: 'codex',
            metadata: {
              terminalApp: 'Ghostty',
              terminalSessionID: 'ghostty-5',
              projectPath: '/Users/song/projects/kai-export-ppt-lite',
            },
            context: { projectName: 'kai-export-ppt-lite' },
          },
        ],
        workStates: [],
        events: [
          {
            id: 701,
            type: 'request_approval',
            createdAt: new Date().toISOString(),
            taskId: 'codex-native-bg-task',
            threadId: 'codex-native-bg-thread',
            payload: {
              approvalId: 'codex-native-call_bg',
              participantId: 'codex.other',
              delivery: {
                semantic: 'actionable',
                source: 'codex-native-approval',
              },
              nativeCodexApproval: {
                callId: 'call_bg',
              },
              body: {
                summary: 'Do you want to allow a browser-based visual comparison?',
                commandTitle: 'Codex',
                commandLine: 'python3 scripts/compare-html-ppt-visual.py',
                commandPreview: '/Users/song/projects/kai-export-ppt-lite',
              },
            },
          },
        ],
        approvals: [
          {
            approvalId: 'hexdeck-local-codex-host-codex-session-queued-call_bg',
            taskId: 'local-host-approval-codex-session-queued-call_bg',
            threadId: 'local-host-approval-codex-session-queued',
            createdAt: new Date().toISOString(),
            summary: 'Do you want to allow a browser-based visual comparison?',
            decision: 'pending',
            participantId: 'codex.other',
            actions: [
              { label: 'Allow once', decisionMode: 'yes' as const },
              { label: 'Reject', decisionMode: 'no' as const },
            ],
            body: {
              summary: 'Do you want to allow a browser-based visual comparison?',
              commandTitle: 'Codex',
              commandLine: 'python3 scripts/compare-html-ppt-visual.py',
              commandPreview: '/Users/song/projects/kai-export-ppt-lite',
              localHostApproval: {
                source: 'codex',
                runtimeSource: 'queued-context',
                projectPath: '/Users/song/projects/kai-export-ppt-lite',
              },
              delivery: {
                source: 'hexdeck-local-host-approval',
              },
            },
          },
        ],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByText('Do you want to allow a browser-based visual comparison?')).not.toBeInTheDocument();
  });

  it('keeps same-project queued-context local approvals visible when the saved project matches', async () => {
    loadLocalSettingsMock.mockReturnValue({
      brokerUrl: 'http://broker.test',
      globalShortcut: 'CmdOrCtrl+Shift+H',
      currentProject: 'HexDeck',
      recentProjects: ['HexDeck'],
    });

    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [
          {
            participantId: 'codex.main',
            alias: 'codex6',
            kind: 'agent',
            tool: 'codex',
            metadata: {
              terminalApp: 'Ghostty',
              terminalSessionID: 'ghostty-6',
              projectPath: '/Users/song/projects/hexdeck',
            },
            context: { projectName: 'HexDeck' },
          },
        ],
        workStates: [],
        events: [
          {
            id: 702,
            type: 'request_approval',
            createdAt: new Date().toISOString(),
            taskId: 'codex-native-fg-task',
            threadId: 'codex-native-fg-thread',
            payload: {
              approvalId: 'codex-native-call_fg',
              participantId: 'codex.main',
              delivery: {
                semantic: 'actionable',
                source: 'codex-native-approval',
              },
              nativeCodexApproval: {
                callId: 'call_fg',
              },
              body: {
                summary: 'Do you want to create /Users/song/Desktop/hexdeck-codex-click-check-20260423-u on your Desktop?',
                commandTitle: 'Codex',
                commandLine: 'mkdir /Users/song/Desktop/hexdeck-codex-click-check-20260423-u',
                commandPreview: '/Users/song/projects/hexdeck',
              },
              actions: [
                { label: 'Allow once', decisionMode: 'yes' as const },
                { label: 'Reject', decisionMode: 'no' as const },
              ],
            },
          },
        ],
        approvals: [
          {
            approvalId: 'hexdeck-local-codex-host-codex-session-queued-call_fg',
            taskId: 'local-host-approval-codex-session-queued-call_fg',
            threadId: 'local-host-approval-codex-session-queued',
            createdAt: new Date().toISOString(),
            summary: 'Do you want to create /Users/song/Desktop/hexdeck-codex-click-check-20260423-u on your Desktop?',
            decision: 'pending',
            participantId: 'codex.main',
            actions: [
              { label: 'Allow once', decisionMode: 'yes' as const },
              { label: 'Reject', decisionMode: 'no' as const },
            ],
            body: {
              summary: 'Do you want to create /Users/song/Desktop/hexdeck-codex-click-check-20260423-u on your Desktop?',
              commandTitle: 'Codex',
              commandLine: 'mkdir /Users/song/Desktop/hexdeck-codex-click-check-20260423-u',
              commandPreview: '/Users/song/projects/hexdeck',
              localHostApproval: {
                source: 'codex',
                runtimeSource: 'queued-context',
                projectPath: '/Users/song/projects/hexdeck',
              },
              delivery: {
                source: 'hexdeck-local-host-approval',
              },
            },
          },
        ],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('@codex6 · Do you want to create /Users/song/Desktop/hexdeck-codex-click-check-20260423-u on your Desktop?')).toBeInTheDocument();
    });
  });

  it('keeps same-project queued-context approvals visible in the activity-card window when a matching project override is present', async () => {
    loadLocalSettingsMock.mockReturnValue({
      brokerUrl: 'http://broker.test',
      globalShortcut: 'CmdOrCtrl+Shift+H',
      currentProject: 'kai-export-ppt-lite',
      recentProjects: ['kai-export-ppt-lite', 'HexDeck'],
    });

    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [
          {
            participantId: 'codex.main',
            alias: 'codex6',
            kind: 'agent',
            tool: 'codex',
            metadata: {
              terminalApp: 'Ghostty',
              terminalSessionID: 'ghostty-6',
              projectPath: '/Users/song/projects/hexdeck',
            },
            context: { projectName: 'HexDeck' },
          },
        ],
        workStates: [],
        events: [
          {
            id: 703,
            type: 'request_approval',
            createdAt: new Date().toISOString(),
            taskId: 'codex-native-fg-all-agents-task',
            threadId: 'codex-native-fg-all-agents-thread',
            payload: {
              approvalId: 'codex-native-call_fg_all_agents',
              participantId: 'codex.main',
              delivery: {
                semantic: 'actionable',
                source: 'codex-native-approval',
              },
              nativeCodexApproval: {
                callId: 'call_fg_all_agents',
              },
              body: {
                summary: 'Do you want to create /Users/song/Desktop/hexdeck-codex-click-check-20260423-v on your Desktop?',
                commandTitle: 'Codex',
                commandLine: 'mkdir /Users/song/Desktop/hexdeck-codex-click-check-20260423-v',
                commandPreview: '/Users/song/projects/hexdeck',
              },
              actions: [
                { label: 'Allow once', decisionMode: 'yes' as const },
                { label: 'Reject', decisionMode: 'no' as const },
              ],
            },
          },
        ],
        approvals: [
          {
            approvalId: 'hexdeck-local-codex-host-codex-session-queued-call_fg_all_agents',
            taskId: 'local-host-approval-codex-session-queued-call_fg_all_agents',
            threadId: 'local-host-approval-codex-session-queued',
            createdAt: new Date().toISOString(),
            summary: 'Do you want to create /Users/song/Desktop/hexdeck-codex-click-check-20260423-v on your Desktop?',
            decision: 'pending',
            participantId: 'codex.main',
            actions: [
              { label: 'Allow once', decisionMode: 'yes' as const },
              { label: 'Reject', decisionMode: 'no' as const },
            ],
            body: {
              summary: 'Do you want to create /Users/song/Desktop/hexdeck-codex-click-check-20260423-v on your Desktop?',
              commandTitle: 'Codex',
              commandLine: 'mkdir /Users/song/Desktop/hexdeck-codex-click-check-20260423-v',
              commandPreview: '/Users/song/projects/hexdeck',
              localHostApproval: {
                source: 'codex',
                runtimeSource: 'queued-context',
                projectPath: '/Users/song/projects/hexdeck',
              },
              delivery: {
                source: 'hexdeck-local-host-approval',
              },
            },
          },
        ],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card&project=HexDeck');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('@codex6 · Do you want to create /Users/song/Desktop/hexdeck-codex-click-check-20260423-v on your Desktop?')).toBeInTheDocument();
    });
  });

  it('ignores the activity-card project query for popup data when running live debug', async () => {
    loadLocalSettingsMock.mockReturnValue({
      brokerUrl: 'http://broker.test',
      globalShortcut: 'CmdOrCtrl+Shift+H',
      currentProject: '__all_agents__',
      recentProjects: [],
    });

    brokerClientInstance = {
      loadServiceSeed: vi.fn().mockResolvedValue({
        health: { ok: true },
        participants: [
          {
            participantId: 'codex.other',
            alias: 'codex11',
            kind: 'agent',
            tool: 'codex',
            metadata: {
              terminalApp: 'Ghostty',
              projectPath: '/Users/song/projects',
            },
            context: { projectName: 'projects' },
          },
          {
            participantId: 'codex.main',
            alias: 'codex',
            kind: 'agent',
            tool: 'codex',
            metadata: {
              terminalApp: 'Ghostty',
              projectPath: '/Users/song/projects/hexdeck',
            },
            context: { projectName: 'hexdeck' },
          },
        ],
        workStates: [],
        events: [],
        approvals: [],
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(makeSeed()),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=activity-card&debugLive=1&project=hexdeck');

    render(<App />);

    await waitFor(() => {
      expect(brokerClientInstance.loadServiceSeed).toHaveBeenCalled();
    });
    expect(brokerClientInstance.loadProjectSeed).not.toHaveBeenCalled();
  });
});
