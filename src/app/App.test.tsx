import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App shell', () => {
  it('renders the compact dropdown shell without the removed main-panel CTA', () => {
    render(<App />);

    expect(screen.getByText('HEXDECK PRO')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Main Panel' })).not.toBeInTheDocument();
  });
});
