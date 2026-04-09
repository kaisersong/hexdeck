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
  getCapabilityStatusMock,
  loadLocalSettingsMock,
  ensureBrokerReadyMock,
} = vi.hoisted(() => ({
  brokerClientConstructorMock: vi.fn(),
  expandedRouteSpy: vi.fn(),
  getBrokerRuntimeStatusMock: vi.fn(),
  getCapabilityStatusMock: vi.fn(),
  loadLocalSettingsMock: vi.fn(),
  ensureBrokerReadyMock: vi.fn(),
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

function makeApprovalCard(): ActivityCardApprovalProjection {
  return {
    cardId: 'approval:1',
    kind: 'approval',
    priority: 'critical',
    summary: 'Deploy approval needed',
    actorLabel: '@codex4',
    approvalId: 'approval-1',
    actionMode: 'action',
    decision: 'pending',
    taskId: 'task-1',
  };
}

function makeQuestionCard(): ActivityCardQuestionProjection {
  return {
    cardId: 'question:1',
    kind: 'question',
    priority: 'attention',
    summary: 'Which target should I use?',
    actorLabel: '@codex4',
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
    subscribe: vi.fn(() => () => undefined),
    connectRealtime: vi.fn(() => () => undefined),
    respondToApproval: vi.fn().mockResolvedValue(undefined),
    answerClarification: vi.fn().mockResolvedValue(undefined),
  };
}

let brokerClientInstance = makeBrokerClientMock();

beforeEach(() => {
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

    const article = screen.getByText('Deploy approval needed').closest('article');
    if (!article) {
      throw new Error('expected floating card article');
    }

    fireEvent.mouseEnter(article);
    fireEvent.mouseLeave(article);

    expect(onHoverChange).toHaveBeenNthCalledWith(1, true);
    expect(onHoverChange).toHaveBeenNthCalledWith(2, false);
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

    expect(screen.getByText('Completed rollout tracking slice.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(onJump).toHaveBeenCalledWith(completionCard.jumpTarget);
  });
});

describe('ActivityCardRoute', () => {
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

    const article = screen.getByText('Deploy approval needed').closest('article');
    if (!article) {
      throw new Error('expected floating card article');
    }

    fireEvent.mouseEnter(article);
    fireEvent.mouseLeave(article);

    expect(onHoverChange).toHaveBeenNthCalledWith(1, true);
    expect(onHoverChange).toHaveBeenNthCalledWith(2, false);
  });
});

describe('activity-card window routing', () => {
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
  });
});
