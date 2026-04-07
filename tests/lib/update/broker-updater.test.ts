import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureBrokerReady } from '../../../src/lib/update/broker-updater';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

describe('ensureBrokerReady', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('delegates bootstrap to the tauri ensure command', async () => {
    invokeMock
      .mockResolvedValueOnce({
        ready: true,
        already_running: false,
        pid: 1234,
        installed_path: '/tmp/intent-broker-0.1.3',
        heartbeat_path: '/tmp/intent-broker-0.1.3/.tmp/broker.heartbeat.json',
        stdout_path: '/tmp/intent-broker-0.1.3/.tmp/broker.stdout.log',
        stderr_path: '/tmp/intent-broker-0.1.3/.tmp/broker.stderr.log',
        log_path: '/tmp/kernel/hexdeck-bootstrap.log',
        node_path: '/opt/homebrew/bin/node',
        last_error: null,
      });

    const result = await ensureBrokerReady();

    expect(invokeMock.mock.calls).toEqual([
      ['ensure_broker_ready', { brokerUrl: 'http://127.0.0.1:4318', timeoutMs: 15000 }],
    ]);
    expect(result.ready).toBe(true);
  });

  it('returns bootstrap diagnostics when broker startup fails', async () => {
    invokeMock
      .mockResolvedValueOnce({
        ready: false,
        already_running: false,
        pid: null,
        installed_path: '',
        heartbeat_path: '',
        stdout_path: '',
        stderr_path: '',
        log_path: '/tmp/kernel/hexdeck-bootstrap.log',
        node_path: null,
        last_error: 'failed_to_locate_node_binary',
      });

    const result = await ensureBrokerReady();

    expect(invokeMock.mock.calls).toEqual([
      ['ensure_broker_ready', { brokerUrl: 'http://127.0.0.1:4318', timeoutMs: 15000 }],
    ]);
    expect(result.last_error).toBe('failed_to_locate_node_binary');
  });
});
