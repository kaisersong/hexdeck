import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';

const { getBrokerChannelSettingsMock, saveBrokerChannelSettingsMock } = vi.hoisted(() => ({
  getBrokerChannelSettingsMock: vi.fn(),
  saveBrokerChannelSettingsMock: vi.fn(),
}));

vi.mock('../../lib/broker/channels', () => ({
  getBrokerChannelSettings: getBrokerChannelSettingsMock,
  saveBrokerChannelSettings: saveBrokerChannelSettingsMock,
}));

vi.mock('../../lib/update/hexdeck-updater', () => ({
  checkHexDeckUpdate: vi.fn(),
  downloadAndInstallHexDeckUpdate: vi.fn(),
}));

describe('SettingsPanel', () => {
  beforeEach(() => {
    getBrokerChannelSettingsMock.mockReset();
    saveBrokerChannelSettingsMock.mockReset();
    getBrokerChannelSettingsMock.mockResolvedValue({
      installed: true,
      configPath: '/tmp/intent-broker.local.json',
      channels: {
        yunzhijia: {
          enabled: true,
          sendUrl: 'https://www.yunzhijia.com/old',
          preserved: 'yes',
        },
      },
    });
    saveBrokerChannelSettingsMock.mockImplementation(async (channels) => ({
      installed: true,
      configPath: '/tmp/intent-broker.local.json',
      channels,
    }));
  });

  it('loads yunzhijia webhook settings and saves channels before restarting broker', async () => {
    const onRestartBroker = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsPanel
        globalShortcut="CommandOrControl+Shift+H"
        runtimeStatus={{
          installed: true,
          running: true,
          healthy: true,
          version: '0.3.1',
          path: '/tmp/intent-broker',
          heartbeatPath: null,
          stdoutPath: null,
          stderrPath: null,
          lastError: null,
        }}
        onSaveSettings={vi.fn()}
        onRefreshBroker={vi.fn()}
        onRestartBroker={onRestartBroker}
      />
    );

    const webhookInputs = await screen.findAllByLabelText('Webhook URL');
    expect(webhookInputs[0]).toHaveValue('https://www.yunzhijia.com/old');
    expect(screen.getByLabelText('云之家')).toBeChecked();

    fireEvent.change(webhookInputs[0], {
      target: { value: 'https://www.yunzhijia.com/new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save and Restart Broker' }));

    await waitFor(() => {
      expect(saveBrokerChannelSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          yunzhijia: expect.objectContaining({
            enabled: true,
            sendUrl: 'https://www.yunzhijia.com/new',
            preserved: 'yes',
          }),
          feishu: expect.objectContaining({
            enabled: false,
            webhookUrl: '',
          }),
          dingtalk: expect.objectContaining({
            enabled: false,
            webhookUrl: '',
          }),
        })
      );
    });
    expect(onRestartBroker).toHaveBeenCalledTimes(1);
  });
});
