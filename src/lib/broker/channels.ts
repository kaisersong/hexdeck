import { invoke } from '@tauri-apps/api/core';

export interface BrokerChannelConfig {
  enabled: boolean;
  sendUrl?: string | null;
  webhookUrl?: string | null;
  [key: string]: unknown;
}

export interface BrokerChannelSettings {
  installed: boolean;
  configPath: string | null;
  channels: Record<string, BrokerChannelConfig>;
}

export async function getBrokerChannelSettings(): Promise<BrokerChannelSettings> {
  return invoke<BrokerChannelSettings>('get_broker_channel_settings');
}

export async function saveBrokerChannelSettings(
  channels: Record<string, BrokerChannelConfig>
): Promise<BrokerChannelSettings> {
  return invoke<BrokerChannelSettings>('save_broker_channel_settings', { channels });
}
