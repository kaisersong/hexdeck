import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const { getCurrentWindowMock, hideWindowMock, onFocusChangedMock } = vi.hoisted(() => ({
  getCurrentWindowMock: vi.fn(),
  hideWindowMock: vi.fn(),
  onFocusChangedMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: getCurrentWindowMock,
}));

describe('App shell', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/');
    hideWindowMock.mockReset();
    getCurrentWindowMock.mockReset();
    onFocusChangedMock.mockReset();
    getCurrentWindowMock.mockReturnValue({
      hide: hideWindowMock,
      onFocusChanged: onFocusChangedMock,
    });
    onFocusChangedMock.mockResolvedValue(() => undefined);
  });

  it('renders the compact dropdown shell without the removed main-panel CTA', () => {
    render(<App />);

    expect(screen.getByText('HEXDECK PRO')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Main Panel' })).not.toBeInTheDocument();
  });

  it('hides the panel window when clicking outside the dropdown', async () => {
    render(<App />);

    await waitFor(() => {
      expect(onFocusChangedMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.mouseDown(document.body);

    await waitFor(() => {
      expect(hideWindowMock).toHaveBeenCalledTimes(1);
    });
  });

  it('hides the panel window when the panel loses focus', async () => {
    let focusListener: ((event: { payload: boolean }) => void) | null = null;
    onFocusChangedMock.mockImplementation(async (listener: (event: { payload: boolean }) => void) => {
      focusListener = listener;
      return () => undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(onFocusChangedMock).toHaveBeenCalledTimes(1);
    });

    const registeredFocusListener = focusListener;
    if (!registeredFocusListener) {
      throw new Error('expected focus listener');
    }

    (registeredFocusListener as (event: { payload: boolean }) => void)({ payload: false });

    await waitFor(() => {
      expect(hideWindowMock).toHaveBeenCalledTimes(1);
    });
  });
});
