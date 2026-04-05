import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App shell', () => {
  it('renders the HexDeck header with project selector', () => {
    render(<App />);

    expect(screen.getByRole('heading', { level: 1, name: 'HexDeck' })).toBeInTheDocument();
    // The project selector button shows the current project name
    expect(screen.getByRole('button', { name: 'intent-broker' })).toBeInTheDocument();
  });
});
