import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
