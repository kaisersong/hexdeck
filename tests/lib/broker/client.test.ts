import { describe, expect, it, vi } from 'vitest';
import { BrokerClient } from '../../../src/lib/broker/client';

describe('BrokerClient', () => {
  it('loads health, participants, work-state, and replay slices for a project', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ alias: 'codex4', context: { projectName: 'intent-broker' } }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ participantId: 'codex-session-aa59e6ef', status: 'implementing' }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1282, type: 'report_progress' }]), { status: 200 }));

    const client = new BrokerClient({
      brokerUrl: 'http://127.0.0.1:4318',
      fetchImpl: fetchMock as typeof fetch,
      websocketFactory: () => {
        throw new Error('not used in this test');
      }
    });

    const snapshot = await client.loadProjectSeed('intent-broker');

    expect(snapshot.health.ok).toBe(true);
    expect(snapshot.participants[0].alias).toBe('codex4');
    expect(snapshot.workStates[0].status).toBe('implementing');
    expect(snapshot.events[0].id).toBe(1282);
  });

  it('normalizes websocket messages into typed broker events', async () => {
    const sent: string[] = [];
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const fakeSocket = {
      addEventListener: (type: string, handler: (event: MessageEvent<string>) => void) => listeners.set(type, handler),
      send: (payload: string) => sent.push(payload),
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
      data: JSON.stringify({ id: 1282, type: 'report_progress' })
    } as MessageEvent<string>);

    expect(received).toEqual([{ id: 1282, type: 'report_progress' }]);
  });
});
