import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App shell', () => {
  it('renders only the settings control in the top toolbar', () => {
    render(<App />);

    expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'HexDeck' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All agents' })).not.toBeInTheDocument();
  });
});
