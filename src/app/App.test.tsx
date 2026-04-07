import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App shell', () => {
  it('renders the compact dropdown shell header and primary action', () => {
    render(<App />);

    expect(screen.getByText('HEXDECK PRO')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Main Panel' })).toBeInTheDocument();
  });
});
