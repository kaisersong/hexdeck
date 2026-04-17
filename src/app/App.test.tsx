import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const { getCurrentWindowMock, hideWindowMock } = vi.hoisted(() => ({
  getCurrentWindowMock: vi.fn(),
  hideWindowMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: getCurrentWindowMock,
}));

describe('App shell', () => {
  beforeEach(() => {
    hideWindowMock.mockReset();
    getCurrentWindowMock.mockReset();
    getCurrentWindowMock.mockReturnValue({
      hide: hideWindowMock,
    });
  });

  it('renders the compact dropdown shell without the removed main-panel CTA', () => {
    render(<App />);

    expect(screen.getByText('HEXDECK PRO')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Main Panel' })).not.toBeInTheDocument();
  });

  it('hides the panel window when clicking outside the dropdown', async () => {
    const { container } = render(<App />);
    const trayShell = container.querySelector('main.panel-shell--dropdown');

    if (!trayShell) {
      throw new Error('expected tray shell');
    }

    fireEvent.mouseDown(trayShell);

    await waitFor(() => {
      expect(hideWindowMock).toHaveBeenCalledTimes(1);
    });
  });
});
