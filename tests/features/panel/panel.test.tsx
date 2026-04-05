import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../../src/app/App';
import { PanelRoute } from '../../../src/app/routes/panel';

describe('PanelRoute', () => {
  it('renders overview, now, attention, and recent sections', () => {
    render(
      <PanelRoute
        snapshot={{
          overview: {
            brokerHealthy: true,
            onlineCount: 2,
            busyCount: 1,
            blockedCount: 1,
            pendingApprovalCount: 1,
          },
          now: [],
          attention: [],
          recent: [],
        }}
      />
    );

    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Now')).toBeInTheDocument();
    expect(screen.getByText('Attention')).toBeInTheDocument();
    expect(screen.getByText('Recent')).toBeInTheDocument();
  });
});

describe('App integration', () => {
  it('shows onboarding when broker data has not loaded yet', () => {
    render(<App />);

    expect(screen.getByText('Broker connection')).toBeInTheDocument();
  });
});
