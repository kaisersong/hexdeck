import { describe, expect, it, vi } from 'vitest';
import { BrokerClient } from '../../../src/lib/broker/client';
import type { BrokerEvent } from '../../../src/lib/broker/types';

// @ts-expect-error legacy replay field should not be part of the public contract
const legacyBrokerEvent: BrokerEvent = { id: 1, type: 'report_progress', kind: 'report_progress' };

void legacyBrokerEvent;

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
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 1282, type: 'report_progress', payload: { participantId: 'codex-session-aa59e6ef' } },
          ]),
          { status: 200 }
        )
      )
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

  it('filters project replay events down to the project participants', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            participants: [{ participantId: 'agent-a', alias: 'codex4', context: { projectName: 'intent-broker' } }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ participantId: 'agent-a', status: 'implementing' }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            participants: [{ participantId: 'agent-a', status: 'online', metadata: { source: 'registration' } }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              { eventId: 1, type: 'ask_clarification', payload: { participantId: 'agent-a', summary: 'Project event' } },
              { eventId: 2, type: 'ask_clarification', payload: { participantId: 'agent-b', summary: 'Other project event' } },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => {
        throw new Error('not used in this test');
      }
    });

    const snapshot = await client.loadProjectSeed('intent-broker');

    expect(snapshot.events).toEqual([
      { id: 1, type: 'ask_clarification', payload: { participantId: 'agent-a', summary: 'Project event' } },
    ]);
  });

  it('keeps human approval responses that resolve project participant approvals', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            participants: [{ participantId: 'agent-a', alias: 'codex4', context: { projectName: 'intent-broker' } }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ participantId: 'agent-a', status: 'implementing' }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            participants: [{ participantId: 'agent-a', status: 'online', metadata: { source: 'registration' } }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                eventId: 1,
                type: 'request_approval',
                taskId: 'task-a',
                payload: { approvalId: 'approval-a', participantId: 'agent-a' },
              },
              {
                eventId: 2,
                type: 'respond_approval',
                taskId: 'task-a',
                payload: { approvalId: 'approval-a', participantId: 'human.local', decision: 'approved' },
              },
              {
                eventId: 3,
                type: 'request_approval',
                taskId: 'task-b',
                payload: { approvalId: 'approval-b', participantId: 'agent-b' },
              },
              {
                eventId: 4,
                type: 'respond_approval',
                taskId: 'task-b',
                payload: { approvalId: 'approval-b', participantId: 'human.local', decision: 'approved' },
              },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => {
        throw new Error('not used in this test');
      }
    });

    const snapshot = await client.loadProjectSeed('intent-broker');

    expect(snapshot.events).toEqual([
      {
        id: 1,
        type: 'request_approval',
        taskId: 'task-a',
        payload: { approvalId: 'approval-a', participantId: 'agent-a' },
      },
      {
        id: 2,
        type: 'respond_approval',
        taskId: 'task-a',
        payload: { approvalId: 'approval-a', participantId: 'human.local', decision: 'approved' },
      },
    ]);
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

  it('paginates replay pages so service seed includes the newest events', async () => {
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
            items: Array.from({ length: 100 }, (_, index) => ({ eventId: index + 1, kind: 'report_progress' })),
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ eventId: 101, kind: 'ask_clarification', payload: { summary: 'Latest question' } }],
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

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:4318/health',
      'http://127.0.0.1:4318/participants',
      'http://127.0.0.1:4318/work-state',
      'http://127.0.0.1:4318/presence',
      'http://127.0.0.1:4318/events/replay?after=0',
      'http://127.0.0.1:4318/events/replay?after=100',
    ]);
    expect(snapshot.events.at(-1)).toMatchObject({
      id: 101,
      type: 'ask_clarification',
      payload: { summary: 'Latest question' },
    });
  });

  it('normalizes replay events that use kind instead of type', async () => {
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
            items: [{ id: 2001, kind: 'report_progress' }],
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

  it('normalizes replay events that use eventId instead of id', async () => {
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
            items: [{ eventId: 2974, type: 'ask_clarification', taskId: 'smoke-task-1' }],
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

    expect(snapshot.events).toEqual([{ id: 2974, type: 'ask_clarification', taskId: 'smoke-task-1' }]);
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

  it('surfaces malformed presence payloads instead of collapsing them into empty data', async () => {
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ participants: { participantId: 'a' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 2001, type: 'report_progress' }] }), { status: 200 }));

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => {
        throw new Error('not used in this test');
      }
    });

    await expect(client.loadServiceSeed()).rejects.toThrow(/broker_response_malformed/);
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
    expect(websocketFactory).toHaveBeenCalledWith('wss://broker.example.com/root/ws?participantId=human.local');

    listeners.get('message')?.({
      data: JSON.stringify({ id: 1282, type: 'report_progress' })
    } as MessageEvent<string>);

    expect(received).toEqual([{ id: 1282, type: 'report_progress' }]);

    cleanup();
    expect(fakeSocket.close).toHaveBeenCalledTimes(1);
  });

  it('opens the broker websocket inside the Tauri desktop app', () => {
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const fakeSocket = {
      addEventListener: (type: string, handler: (event: MessageEvent<string>) => void) => listeners.set(type, handler),
      removeEventListener: vi.fn(),
      close: vi.fn()
    };
    const websocketFactory = vi.fn(() => fakeSocket as never);

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    try {
      const client = new BrokerClient({
        brokerUrl: 'http://127.0.0.1:4318',
        fetchImpl: vi.fn() as typeof fetch,
        websocketFactory
      });

      const received: Array<{ id: number; type: string }> = [];
      client.subscribe((event) => received.push({ id: event.id, type: event.type }));
      const cleanup = client.connectRealtime();

      expect(websocketFactory).toHaveBeenCalledTimes(1);
      expect(websocketFactory).toHaveBeenCalledWith('ws://127.0.0.1:4318/ws?participantId=human.local');

      listeners.get('message')?.({
        data: JSON.stringify({ type: 'new_intent', event: { eventId: 3901, kind: 'report_progress' } }),
      } as MessageEvent<string>);

      expect(received).toEqual([{ id: 3901, type: 'report_progress' }]);

      cleanup();
      expect(fakeSocket.close).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it('registers the local UI participant so broker broadcasts can reach the websocket', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ participantId: 'human.local' }), { status: 200 }));
    const fakeSocket = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn()
    };

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => fakeSocket as never
    });

    client.connectRealtime();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4318/participants/register',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: expect.any(String),
      })
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
      participantId: 'human.local',
      alias: 'human',
      kind: 'human',
      roles: ['approver'],
      capabilities: ['activity-card'],
    });
  });

  it('uses Tauri invoke to register the local UI participant inside the desktop app', () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce(undefined);
    const fetchMock = vi.fn();
    const fakeSocket = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn()
    };

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    try {
      const client = new BrokerClient({
        brokerUrl: 'http://127.0.0.1:4318',
        fetchImpl: fetchMock as typeof fetch,
        websocketFactory: () => fakeSocket as never
      });

      client.connectRealtime();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith('register_broker_ui_participant', {
        brokerUrl: 'http://127.0.0.1:4318',
      });
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
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

  it('unwraps broker websocket new_intent envelopes before notifying subscribers', () => {
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const fakeSocket = {
      addEventListener: (type: string, handler: (event: MessageEvent<string>) => void) => listeners.set(type, handler),
      removeEventListener: vi.fn(),
      close: vi.fn()
    };

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: vi.fn() as typeof fetch,
      websocketFactory: () => fakeSocket as never
    });

    const received: Array<{ id: number; type: string }> = [];
    client.subscribe((event) => received.push({ id: event.id, type: event.type }));
    client.connectRealtime();

    listeners.get('message')?.({
      data: JSON.stringify({
        type: 'new_intent',
        event: {
          eventId: 2743,
          kind: 'request_approval',
        },
      }),
    } as MessageEvent<string>);

    expect(received).toEqual([{ id: 2743, type: 'request_approval' }]);
  });

  it.each(['close', 'error'] as const)('clears the cached realtime handle after websocket %s and reconnects', (eventType) => {
    const sockets: Array<{
      addEventListener: (type: string, handler: (event: Event) => void) => void;
      removeEventListener: (type: string, handler: (event: Event) => void) => void;
      close: ReturnType<typeof vi.fn>;
      listeners: Map<string, (event: Event) => void>;
    }> = [];

    const websocketFactory = vi.fn(() => {
      const listeners = new Map<string, (event: Event) => void>();
      const socket = {
        addEventListener: (type: string, handler: (event: Event) => void) => listeners.set(type, handler),
        removeEventListener: (type: string, handler: (event: Event) => void) => {
          if (listeners.get(type) === handler) {
            listeners.delete(type);
          }
        },
        close: vi.fn(),
        listeners,
      };

      sockets.push(socket);
      return socket as never;
    });

    const client = new BrokerClient({
      brokerUrl: 'https://broker.example.com/root',
      fetchImpl: vi.fn() as typeof fetch,
      websocketFactory,
    });

    const firstCleanup = client.connectRealtime();

    expect(websocketFactory).toHaveBeenCalledTimes(1);
    sockets[0].listeners.get(eventType)?.({} as Event);

    const secondCleanup = client.connectRealtime();

    expect(websocketFactory).toHaveBeenCalledTimes(2);
    expect(secondCleanup).not.toBe(firstCleanup);
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

  it('throws when the pending approvals payload is malformed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: { approvalId: 'approval-1' } }), { status: 200 })
    );

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => {
        throw new Error('not used');
      },
    });

    await expect(client.loadPendingApprovals('intent-broker')).rejects.toThrow(/broker_response_malformed/);
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

  it('carries decisionMode metadata when responding to an approval', async () => {
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
      decisionMode: 'always',
    } as Parameters<BrokerClient['respondToApproval']>[0]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4318/approvals/approval-1/respond',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId: 'task-1',
          fromParticipantId: 'human.local',
          decision: 'approved',
          decisionMode: 'always',
        }),
      })
    );
  });

  it('submits clarification answers through broker intents', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 202 })
    );

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => {
        throw new Error('not used');
      },
    });

    await (client as unknown as {
      answerClarification: (input: {
        fromParticipantId: string;
        toParticipantId: string;
        taskId?: string;
        threadId?: string;
        summary: string;
      }) => Promise<void>;
    }).answerClarification({
      fromParticipantId: 'human.local',
      toParticipantId: 'codex.main',
      taskId: 'task-1',
      threadId: 'thread-1',
      summary: 'Use the compact layout',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4318/intents',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: expect.any(String),
      })
    );

    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
      intentId: expect.any(String),
      kind: 'answer_clarification',
      fromParticipantId: 'human.local',
      taskId: 'task-1',
      threadId: 'thread-1',
      to: { mode: 'participant', participants: ['codex.main'] },
      payload: {
        body: { summary: 'Use the compact layout' },
      },
    });
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

  it('routes mirrored local Codex approvals through the broker approval command inside the desktop app', async () => {
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
        approvalId: 'hexdeck-local-codex-host-codex-session-019db354-call_abc123',
        taskId: 'local-host-approval-codex-session-019db354-call_abc123',
        fromParticipantId: 'human.local',
        decision: 'approved',
        decisionMode: 'yes',
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith('respond_to_broker_approval', {
        brokerUrl: 'http://127.0.0.1:4318',
        input: {
          approvalId: 'hexdeck-local-codex-host-codex-session-019db354-call_abc123',
          taskId: 'local-host-approval-codex-session-019db354-call_abc123',
          fromParticipantId: 'human.local',
          decision: 'approved',
          decisionMode: 'yes',
        },
      });
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});
