import { useMemo } from 'react';
import { createAppStore } from './app-store';

export function useAppStore() {
  return useMemo(() => createAppStore(), []);
}
