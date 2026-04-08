import { describe, expect, it, vi } from 'vitest';
import { BrokerClient } from '../../../src/lib/broker/client';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

describe('BrokerClient', () => {
  it('loads health, participants, work-state, and replay slices for a project', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            participants: [{ participantId: 'codex-session-aa59e6ef', alias: 'codex4', context: { projectName: 'intent-broker' } }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ participantId: 'codex-session-aa59e6ef', status: 'implementing' }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            participants: [{ participantId: 'codex-session-aa59e6ef', status: 'online', metadata: { source: 'registration' } }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1282, type: 'report_progress' }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ approvalId: 'approval-1', taskId: 'task-1' }] }), { status: 200 }));

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => {
        throw new Error('not used in this test');
      }
    });

    const snapshot = await client.loadProjectSeed('intent-broker');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:4318/health',
      'http://127.0.0.1:4318/participants?projectName=intent-broker',
      'http://127.0.0.1:4318/work-state?projectName=intent-broker',
      'http://127.0.0.1:4318/presence',
      'http://127.0.0.1:4318/events/replay?after=0',
      'http://127.0.0.1:4318/projects/intent-broker/approvals?status=pending'
    ]);
    expect(snapshot.health.ok).toBe(true);
    expect(snapshot.participants[0].alias).toBe('codex4');
    expect(snapshot.participants[0].presence).toBe('online');
    expect(snapshot.participants[0].presenceMetadata).toEqual({ source: 'registration' });
    expect(snapshot.workStates[0].status).toBe('implementing');
    expect(snapshot.events[0].id).toBe(1282);
    expect(snapshot.approvals[0].approvalId).toBe('approval-1');
  });

  it('loads the full broker service view without project filtering', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            participants: [{ participantId: 'codex-session-019d671b', alias: 'codex16', kind: 'agent', context: { projectName: 'projects' } }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ participantId: 'codex-session-019d671b', status: 'implementing', projectName: 'projects' }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            participants: [{ participantId: 'codex-session-019d671b', status: 'online', metadata: { source: 'registration' } }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2001, type: 'report_progress' }]), { status: 200 }));

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => {
        throw new Error('not used in this test');
      }
    });

    const snapshot = await client.loadServiceSeed();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:4318/health',
      'http://127.0.0.1:4318/participants',
      'http://127.0.0.1:4318/work-state',
      'http://127.0.0.1:4318/presence',
      'http://127.0.0.1:4318/events/replay?after=0',
    ]);
    expect(snapshot.participants[0].alias).toBe('codex16');
    expect(snapshot.participants[0].presence).toBe('online');
    expect(snapshot.participants[0].presenceMetadata).toEqual({ source: 'registration' });
    expect(snapshot.workStates[0].status).toBe('implementing');
    expect(snapshot.approvals).toEqual([]);
  });

  it('accepts replay payloads wrapped in an items array', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            participants: [{ participantId: 'codex-session-019d671b', alias: 'codex16', kind: 'agent', context: { projectName: 'projects' } }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ participantId: 'codex-session-019d671b', status: 'implementing', projectName: 'projects' }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            participants: [{ participantId: 'codex-session-019d671b', status: 'online', metadata: { source: 'registration' } }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ id: 2001, type: 'report_progress' }],
          }),
          { status: 200 }
        )
      );

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => {
        throw new Error('not used in this test');
      }
    });

    const snapshot = await client.loadServiceSeed();

    expect(snapshot.events).toEqual([{ id: 2001, type: 'report_progress' }]);
  });

  it('keeps loading participants when presence lookup is unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            participants: [{ participantId: 'a', alias: 'codex16', kind: 'agent', context: { projectName: 'projects' } }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ participantId: 'a', status: 'implementing', projectName: 'projects' }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 2001, type: 'report_progress' }] }), { status: 200 }));

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => {
        throw new Error('not used in this test');
      }
    });

    const snapshot = await client.loadServiceSeed();

    expect(snapshot.participants[0].presence).toBeUndefined();
    expect(snapshot.events).toEqual([{ id: 2001, type: 'report_progress' }]);
  });

  it('binds the default global fetch implementation before using it', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];

    const fetchOwner = {
      fetch(input: RequestInfo | URL): Promise<Response> {
        if (this !== globalThis) {
          throw new TypeError('unbound fetch');
        }

        fetchCalls.push(String(input));
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      },
    };

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchOwner.fetch,
    });

    try {
      const client = new BrokerClient({
        brokerUrl: 'http://127.0.0.1:4318',
        websocketFactory: () => {
          throw new Error('not used in this test');
        },
      });

      const health = await client['request']<{ ok: boolean }>('/health');

      expect(health.ok).toBe(true);
      expect(fetchCalls).toEqual(['http://127.0.0.1:4318/health']);
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }
  });

  it('converts broker urls to websocket urls and returns a cleanup handle', () => {
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const fakeSocket = {
      addEventListener: (type: string, handler: (event: MessageEvent<string>) => void) => listeners.set(type, handler),
      removeEventListener: (type: string, handler: (event: MessageEvent<string>) => void) => {
        if (listeners.get(type) === handler) {
          listeners.delete(type);
        }
      },
      close: vi.fn()
    };

    const websocketFactory = vi.fn(() => fakeSocket as never);
    const client = new BrokerClient({
      brokerUrl: 'https://broker.example.com/root',
      fetchImpl: vi.fn() as typeof fetch,
      websocketFactory
    });

    const received: Array<{ id: number; type: string }> = [];
    client.subscribe((event) => received.push({ id: event.id, type: event.type }));
    const cleanup = client.connectRealtime();

    expect(websocketFactory).toHaveBeenCalledTimes(1);
    expect(websocketFactory).toHaveBeenCalledWith('wss://broker.example.com/root');

    listeners.get('message')?.({
      data: JSON.stringify({ id: 1282, type: 'report_progress' })
    } as MessageEvent<string>);

    expect(received).toEqual([{ id: 1282, type: 'report_progress' }]);

    cleanup();
    expect(fakeSocket.close).toHaveBeenCalledTimes(1);
  });

  it('does not create duplicate live sockets when connectRealtime is called repeatedly', () => {
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const fakeSocket = {
      addEventListener: (type: string, handler: (event: MessageEvent<string>) => void) => listeners.set(type, handler),
      removeEventListener: (type: string, handler: (event: MessageEvent<string>) => void) => {
        if (listeners.get(type) === handler) {
          listeners.delete(type);
        }
      },
      close: vi.fn()
    };

    const websocketFactory = vi.fn(() => fakeSocket as never);
    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: vi.fn() as typeof fetch,
      websocketFactory
    });

    const firstCleanup = client.connectRealtime();
    const secondCleanup = client.connectRealtime();

    expect(websocketFactory).toHaveBeenCalledTimes(1);
    expect(secondCleanup).toBe(firstCleanup);
  });

  it('ignores malformed websocket payloads and stops delivery after cleanup', () => {
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const fakeSocket = {
      addEventListener: (type: string, handler: (event: MessageEvent<string>) => void) => listeners.set(type, handler),
      removeEventListener: (type: string, handler: (event: MessageEvent<string>) => void) => {
        if (listeners.get(type) === handler) {
          listeners.delete(type);
        }
      },
      close: vi.fn()
    };

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: vi.fn() as typeof fetch,
      websocketFactory: () => fakeSocket as never
    });

    const received: Array<{ id: number; type: string }> = [];
    client.subscribe((event) => received.push({ id: event.id, type: event.type }));
    const cleanup = client.connectRealtime();

    expect(() => listeners.get('message')?.({ data: 'not-json' } as MessageEvent<string>)).not.toThrow();
    expect(() => listeners.get('message')?.({ data: JSON.stringify(null) } as MessageEvent<string>)).not.toThrow();
    expect(() => listeners.get('message')?.({ data: JSON.stringify([]) } as MessageEvent<string>)).not.toThrow();
    expect(() => listeners.get('message')?.({ data: JSON.stringify({ id: 'bad', type: 1282 }) } as MessageEvent<string>)).not.toThrow();

    listeners.get('message')?.({
      data: JSON.stringify({ id: 1282, type: 'report_progress' })
    } as MessageEvent<string>);

    expect(received).toEqual([{ id: 1282, type: 'report_progress' }]);

    cleanup();

    listeners.get('message')?.({
      data: JSON.stringify({ id: 1283, type: 'report_progress' })
    } as MessageEvent<string>);

    expect(received).toEqual([{ id: 1282, type: 'report_progress' }]);
    expect(fakeSocket.close).toHaveBeenCalledTimes(1);
  });

  it('loads pending approvals for a project', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [{ approvalId: 'approval-1', taskId: 'task-1', summary: 'Deploy approval needed' }],
        }),
        { status: 200 }
      )
    );

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => {
        throw new Error('not used');
      },
    });

    const approvals = await client.loadPendingApprovals('intent-broker');

    expect(approvals[0].approvalId).toBe('approval-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4318/projects/intent-broker/approvals?status=pending'
    );
  });

  it('responds to an approval through the broker API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ approval: { approvalId: 'approval-1' } }), { status: 200 })
    );

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => {
        throw new Error('not used');
      },
    });

    await client.respondToApproval({
      approvalId: 'approval-1',
      taskId: 'task-1',
      fromParticipantId: 'human.local',
      decision: 'approved',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4318/approvals/approval-1/respond',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId: 'task-1',
          fromParticipantId: 'human.local',
          decision: 'approved',
        }),
      })
    );
  });

  it('uses Tauri invoke to load the broker service seed inside the desktop app', async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce({
      health: { ok: true },
      participants: [{ participantId: 'a', alias: 'codex6', presence: 'online', context: { projectName: 'projects' } }],
      workStates: [{ participantId: 'a', status: 'implementing', projectName: 'projects' }],
      events: [{ id: 1, type: 'report_progress' }],
      approvals: [],
    });

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    try {
      const client = new BrokerClient({
        brokerUrl: 'http://127.0.0.1:4318',
        fetchImpl: vi.fn() as typeof fetch,
        websocketFactory: () => {
          throw new Error('not used in this test');
        },
      });

      const snapshot = await client.loadServiceSeed();

      expect(invokeMock).toHaveBeenCalledWith('load_broker_service_seed', {
        brokerUrl: 'http://127.0.0.1:4318',
      });
      expect(snapshot.participants[0].alias).toBe('codex6');
      expect(snapshot.participants[0].presence).toBe('online');
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it('uses Tauri invoke to respond to approvals inside the desktop app', async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce(undefined);

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    try {
      const fetchMock = vi.fn();
      const client = new BrokerClient({
        brokerUrl: 'http://127.0.0.1:4318',
        fetchImpl: fetchMock as typeof fetch,
        websocketFactory: () => {
          throw new Error('not used in this test');
        },
      });

      await client.respondToApproval({
        approvalId: 'approval-1',
        taskId: 'task-1',
        fromParticipantId: 'human.local',
        decision: 'approved',
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith('respond_to_broker_approval', {
        brokerUrl: 'http://127.0.0.1:4318',
        input: {
          approvalId: 'approval-1',
          taskId: 'task-1',
          fromParticipantId: 'human.local',
          decision: 'approved',
        },
      });
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});
