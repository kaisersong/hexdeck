import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExpandedRoute } from '../../../src/app/routes/expanded';

describe('ExpandedRoute', () => {
  it('renders settings content without overview/settings tabs', () => {
    render(
      <ExpandedRoute
        globalShortcut="CommandOrControl+Shift+H"
        runtimeStatus={{
          installed: true,
          running: true,
          healthy: true,
          version: '0.3.1-local',
          path: '/tmp/intent-broker',
          heartbeatPath: '/tmp/intent-broker/heartbeat.json',
          stdoutPath: '/tmp/intent-broker/stdout.log',
          stderrPath: '/tmp/intent-broker/stderr.log',
          lastError: null,
        }}
        onSaveSettings={() => undefined}
        onRefreshBroker={() => undefined}
        onRestartBroker={() => undefined}
      />
    );

    expect(screen.getByRole('heading', { name: 'Broker Runtime' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  });
});
