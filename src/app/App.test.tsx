import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App shell', () => {
  it('renders the HexDeck bootstrap copy', () => {
    render(<App />);

    expect(screen.getByRole('heading', { level: 1, name: 'HexDeck' })).toBeTruthy();
    expect(screen.getByText('Menu bar companion bootstrap complete.')).toBeTruthy();
  });
});
