import { describe, expect, it, vi } from 'vitest';
import { BrokerClient } from '../../../src/lib/broker/client';

describe('BrokerClient', () => {
  it('loads health, participants, work-state, and replay slices for a project', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ alias: 'codex4', context: { projectName: 'intent-broker' } }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ participantId: 'codex-session-aa59e6ef', status: 'implementing' }]), { status: 200 }))
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
});
