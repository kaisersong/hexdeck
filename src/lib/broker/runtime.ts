import { invoke } from '@tauri-apps/api/core';

export const INTERNAL_BROKER_URL = 'http://127.0.0.1:4318';

export interface BrokerRuntimeStatus {
  installed: boolean;
  running: boolean;
  healthy: boolean;
  version: string | null;
  path: string | null;
  heartbeatPath: string | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  lastError: string | null;
}

export async function getBrokerRuntimeStatus(): Promise<BrokerRuntimeStatus> {
  return invoke<BrokerRuntimeStatus>('get_broker_runtime_status');
}

export async function ensureBrokerRunning(): Promise<BrokerRuntimeStatus> {
  return invoke<BrokerRuntimeStatus>('ensure_broker_running');
}

export async function restartBrokerRuntime(): Promise<BrokerRuntimeStatus> {
  return invoke<BrokerRuntimeStatus>('restart_broker_runtime');
}
