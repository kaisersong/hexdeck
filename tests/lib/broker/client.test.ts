import { describe, expect, it, vi } from 'vitest';
import { BrokerClient } from '../../../src/lib/broker/client';

describe('BrokerClient', () => {
  it('loads health, participants, work-state, and replay slices for a project', async () => {
    const responses = new Map<string, Response>([
      ['http://127.0.0.1:4318/health', new Response(JSON.stringify({ ok: true }), { status: 200 })],
      [
        'http://127.0.0.1:4318/participants?projectName=intent-broker',
        new Response(
          JSON.stringify([{ participantId: 'codex-session-aa59e6ef', alias: 'codex4', context: { projectName: 'intent-broker' } }]),
          { status: 200 }
        ),
      ],
      [
        'http://127.0.0.1:4318/work-state?projectName=intent-broker',
        new Response(JSON.stringify([{ participantId: 'codex-session-aa59e6ef', status: 'implementing' }]), { status: 200 }),
      ],
      [
        'http://127.0.0.1:4318/events/replay?after=0',
        new Response(JSON.stringify([{ id: 1282, type: 'report_progress' }]), { status: 200 }),
      ],
      [
        'http://127.0.0.1:4318/projects/intent-broker/approvals?status=pending',
        new Response(JSON.stringify({ items: [{ approvalId: 'approval-1', taskId: 'task-1' }] }), { status: 200 }),
      ],
    ]);
    const fetchMock = vi.fn(async (url: string) => responses.get(url));

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
      'http://127.0.0.1:4318/events/replay?after=0',
      'http://127.0.0.1:4318/projects/intent-broker/approvals?status=pending'
    ]);
    expect(snapshot.health.ok).toBe(true);
    expect(snapshot.participants[0].alias).toBe('codex4');
    expect(snapshot.workStates[0].status).toBe('implementing');
    expect(snapshot.events[0].id).toBe(1282);
    expect(snapshot.approvals[0].approvalId).toBe('approval-1');
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
    expect(websocketFactory).toHaveBeenCalledWith('wss://broker.example.com/root/ws?participantId=hexdeck.desktop');

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

  it('falls back to unscoped broker endpoints and normalizes wrapped payloads', async () => {
    const responses = new Map<string, Response>([
      ['http://127.0.0.1:4318/health', new Response(JSON.stringify({ status: 'healthy' }), { status: 200 })],
      ['http://127.0.0.1:4318/participants?projectName=HexDeck', new Response(JSON.stringify([]), { status: 200 })],
      [
        'http://127.0.0.1:4318/participants',
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'agent-1',
                name: 'codex4',
                projectName: 'HexDeck',
                metadata: { terminalApp: 'Ghostty', sessionHint: 'ghostty-1' },
              },
            ],
          }),
          { status: 200 }
        ),
      ],
      ['http://127.0.0.1:4318/work-state?projectName=HexDeck', new Response(JSON.stringify([]), { status: 200 })],
      [
        'http://127.0.0.1:4318/work-state',
        new Response(
          JSON.stringify({
            workStates: [{ participant_id: 'agent-1', state: 'working', message: 'Implementing settings' }],
          }),
          { status: 200 }
        ),
      ],
      [
        'http://127.0.0.1:4318/events/replay?after=0',
        new Response(JSON.stringify({ events: [{ id: '42', event: 'report_progress' }] }), { status: 200 }),
      ],
      ['http://127.0.0.1:4318/projects/HexDeck/approvals?status=pending', new Response('missing', { status: 404 })],
    ]);
    const fetchMock = vi.fn(async (url: string) => responses.get(url));

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => {
        throw new Error('not used');
      },
    });

    const snapshot = await client.loadProjectSeed('HexDeck');

    expect(snapshot.health.ok).toBe(true);
    expect(snapshot.participants).toEqual([
      expect.objectContaining({
        participantId: 'agent-1',
        alias: 'codex4',
        context: { projectName: 'HexDeck' },
      }),
    ]);
    expect(snapshot.workStates).toEqual([
      expect.objectContaining({
        participantId: 'agent-1',
        status: 'working',
        summary: 'Implementing settings',
      }),
    ]);
    expect(snapshot.events[0]).toEqual(expect.objectContaining({ id: 42, type: 'report_progress' }));
    expect(snapshot.approvals).toEqual([]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:4318/health',
      'http://127.0.0.1:4318/participants?projectName=HexDeck',
      'http://127.0.0.1:4318/participants',
      'http://127.0.0.1:4318/work-state?projectName=HexDeck',
      'http://127.0.0.1:4318/events/replay?after=0',
      'http://127.0.0.1:4318/projects/HexDeck/approvals?status=pending',
      'http://127.0.0.1:4318/work-state',
    ]);
  });

  it('loads an unscoped workspace snapshot and merges approvals across projects', async () => {
    const responses = new Map<string, Response>([
      ['http://127.0.0.1:4318/health', new Response(JSON.stringify({ ok: true }), { status: 200 })],
      [
        'http://127.0.0.1:4318/participants',
        new Response(
          JSON.stringify({
            participants: [
              { participantId: 'agent-1', alias: 'codex4', context: { projectName: 'HexDeck' } },
              { participantId: 'agent-2', alias: 'claude2', context: { projectName: 'BrokerOps' } },
            ],
          }),
          { status: 200 }
        ),
      ],
      [
        'http://127.0.0.1:4318/work-state',
        new Response(
          JSON.stringify({
            items: [
              { participantId: 'agent-1', status: 'implementing' },
              { participantId: 'agent-2', status: 'blocked' },
            ],
          }),
          { status: 200 }
        ),
      ],
      [
        'http://127.0.0.1:4318/events/replay?after=0',
        new Response(JSON.stringify({ items: [{ id: 7, type: 'report_progress' }] }), { status: 200 }),
      ],
      [
        'http://127.0.0.1:4318/projects/HexDeck/approvals?status=pending',
        new Response(JSON.stringify({ items: [{ approvalId: 'approval-1', taskId: 'task-1' }] }), { status: 200 }),
      ],
      [
        'http://127.0.0.1:4318/projects/BrokerOps/approvals?status=pending',
        new Response(JSON.stringify({ items: [{ approvalId: 'approval-2', taskId: 'task-2' }] }), { status: 200 }),
      ],
    ]);
    const fetchMock = vi.fn(async (url: string) => responses.get(url));

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => {
        throw new Error('not used');
      },
    });

    const snapshot = await client.loadProjectSeed();

    expect(snapshot.participants).toHaveLength(2);
    expect(snapshot.workStates).toHaveLength(2);
    expect(snapshot.approvals.map((item) => item.approvalId)).toEqual(['approval-1', 'approval-2']);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:4318/health',
      'http://127.0.0.1:4318/participants',
      'http://127.0.0.1:4318/work-state',
      'http://127.0.0.1:4318/events/replay?after=0',
      'http://127.0.0.1:4318/projects/HexDeck/approvals?status=pending',
      'http://127.0.0.1:4318/projects/BrokerOps/approvals?status=pending',
    ]);
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
});
