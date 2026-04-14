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
  loadLocalSettings: loadLocalSettingsMock,
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

function makeApprovalCard(approvalId = 'approval-1'): ActivityCardApprovalProjection {
  return {
    cardId: `approval:${approvalId}`,
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
      { label: 'Yes', decisionMode: 'yes' },
      { label: 'Always', decisionMode: 'always' },
      { label: 'No', decisionMode: 'no' },
    ],
    detailText: '需要你立即确认这个 agent 意图',
  };
}

function makeQuestionCard(): ActivityCardQuestionProjection {
  return {
    cardId: 'question:1',
    kind: 'question',
    priority: 'attention',
    summary: 'Which target should I use?',
    actorLabel: '@codex4',
    projectLabel: 'HexDeck',
    toolLabel: 'Claude Code',
    terminalLabel: 'Ghostty',
    questionId: 'question-1',
    prompt: 'Choose a target',
    selectionMode: 'single-select',
    options: [
      { label: 'Staging', value: 'staging' },
      { label: 'Production', value: 'prod' },
    ],
    participantId: 'codex.main',
    taskId: 'task-1',
    threadId: 'thread-1',
  };
}

function makeCompletionCard(): ActivityCardCompletionProjection {
  return {
    cardId: 'completion:1',
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
  showWindowMock.mockReset();
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

  it('passes callable approval handlers to ExpandedRoute', async () => {
    const { App } = await import('../../../src/app/App');
    window.history.pushState({}, '', '/?view=expanded');

    render(<App />);

    await waitFor(() => {
      expect(expandedRouteSpy).toHaveBeenCalled();
    });

    const props = expandedRouteSpy.mock.calls.at(-1)?.[0] as {
      onApprove?: unknown;
      onDeny?: unknown;
    };

    expect(typeof props.onApprove).toBe('function');
    expect(typeof props.onDeny).toBe('function');
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
  it('renders approval actions as Yes, Always, and No buttons', () => {
    const onApprovalDecision = vi.fn();

    render(
      <FloatingActivityCard
        card={makeApprovalCard()}
        onApprovalDecision={onApprovalDecision}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Always' }));
    fireEvent.click(screen.getByRole('button', { name: 'No' }));

    expect(onApprovalDecision).toHaveBeenNthCalledWith(1, 'yes');
    expect(onApprovalDecision).toHaveBeenNthCalledWith(2, 'always');
    expect(onApprovalDecision).toHaveBeenNthCalledWith(3, 'no');
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

    expect(onApprovalDecision).toHaveBeenNthCalledWith(1, 'yes');
    expect(onApprovalDecision).toHaveBeenNthCalledWith(2, 'always');
    expect(onApprovalDecision).toHaveBeenNthCalledWith(3, 'no');
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

  it('submits question options immediately on click', () => {
    const onQuestionSelect = vi.fn();

    render(
      <FloatingActivityCard
        card={makeQuestionCard()}
        onQuestionSelect={onQuestionSelect}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Staging' }));

    expect(onQuestionSelect).toHaveBeenCalledWith({ label: 'Staging', value: 'staging' });
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
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

  it('maps y, a, and n keyboard shortcuts onto approval decisions', () => {
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

    expect(onApprovalDecision).toHaveBeenNthCalledWith(1, 'yes');
    expect(onApprovalDecision).toHaveBeenNthCalledWith(2, 'always');
    expect(onApprovalDecision).toHaveBeenNthCalledWith(3, 'no');
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
      { label: 'Staging', value: 'staging' }
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

  it('renders live debug activity card measurement diagnostics', async () => {
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
        const metrics = screen.getByLabelText('activity card debug measurements');
        expect(metrics).toHaveTextContent('card 224px');
        expect(metrics).toHaveTextContent('inner 226px');
        expect(metrics).toHaveTextContent('outer 226px');
        expect(metrics).not.toHaveTextContent('shell');
        expect(metrics).not.toHaveTextContent('target');
        expect(metrics).not.toHaveTextContent('scale');
      });
    } finally {
      scrollHeightSpy.mockRestore();
      rectSpy.mockRestore();
    }
  });

  it('keeps live debug diagnostics compact before native measurement completes', () => {
    window.history.pushState({}, '', '/?view=activity-card&debugLive=1&project=hexdeck');
    invokeMock.mockImplementation(() => new Promise(() => undefined));

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

    const metrics = screen.getByLabelText('activity card debug measurements');
    expect(metrics).toHaveTextContent('card pending');
    expect(metrics).toHaveTextContent('inner pending');
    expect(metrics).toHaveTextContent('outer pending');
    expect(metrics).not.toHaveTextContent('project hexdeck');
    expect(metrics).not.toHaveTextContent('latest 2796');
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
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });
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
    const initialProjectSeed = {
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
      loadServiceSeed: vi.fn().mockResolvedValue({
        ...makeSeed(),
        participants: projectParticipants,
      }),
      loadProjectSeed: vi.fn().mockResolvedValue(initialProjectSeed),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    });
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
    const initialProjectSeed = {
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
    const nextProjectSeed = {
      ...initialProjectSeed,
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
      loadServiceSeed: vi.fn().mockResolvedValue({
        ...makeSeed(),
        participants: projectParticipants,
      }),
      loadProjectSeed: vi.fn().mockResolvedValueOnce(initialProjectSeed).mockResolvedValueOnce(nextProjectSeed),
      subscribe: vi.fn(() => () => undefined),
      connectRealtime: vi.fn(() => () => undefined),
      respondToApproval: vi.fn().mockResolvedValue(undefined),
      answerClarification: vi.fn().mockResolvedValue(undefined),
    };
    brokerClientConstructorMock.mockImplementation(() => brokerClientInstance as never);

    const { App } = await import('../../../src/app/App');
    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });

    window.dispatchEvent(new Event('focus'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('show_activity_card_window');
    });
  });

  it('hides the floating activity-card window when broker data has no active card', async () => {
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
      expect(invokeMock).toHaveBeenCalledWith('hide_activity_card_window');
    });
  });

  it('renders the floating activity card route when view=activity-card', async () => {
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
    expect(invokeMock).not.toHaveBeenCalledWith('show_activity_card_window');
    expect(invokeMock).not.toHaveBeenCalledWith('hide_activity_card_window');
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
        events: [],
        approvals: [],
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
      expect(screen.getByText('@codex4 · Newest approval')).toBeInTheDocument();
    });

    expect(screen.queryByText('Old approval')).not.toBeInTheDocument();
    expect(screen.queryByText('Old question')).not.toBeInTheDocument();
  });

  it('scopes floating activity cards to the preferred project instead of the whole service replay', async () => {
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
            approvalId: 'approval-old',
            taskId: 'task-old',
            summary: 'Old service-wide approval',
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
      expect(screen.getByText('Project-scoped approval')).toBeInTheDocument();
    });

    expect(screen.queryByText('Old service-wide approval')).not.toBeInTheDocument();
    expect(brokerClientInstance.loadProjectSeed).toHaveBeenCalledWith('HexDeck');
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

  it('normalizes the preferred project name to the live participant casing before loading the project seed', async () => {
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
    window.history.pushState({}, '', '/?view=activity-card');

    render(<App />);

    await waitFor(() => {
      expect(brokerClientInstance.loadProjectSeed).toHaveBeenCalledWith('hexdeck');
    });
  });

  it('uses the activity-card project query override when running live debug', async () => {
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
      expect(brokerClientInstance.loadProjectSeed).toHaveBeenCalledWith('hexdeck');
    });
    expect(brokerClientInstance.loadProjectSeed).not.toHaveBeenCalledWith('projects');
  });
});
