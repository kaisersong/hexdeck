import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';

function isActivityCardWindow(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return new URLSearchParams(window.location.search).get('view') === 'activity-card';
}

async function debugActivityCardStartup(message: string): Promise<void> {
  if (!isActivityCardWindow()) {
    return;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('debug_log_activity_card_frontend', {
      message: `[main] ${message}`,
    });
  } catch {
    // Swallow startup diagnostics failures.
  }
}

if (typeof window !== 'undefined' && isActivityCardWindow()) {
  void debugActivityCardStartup(`module-start href=${window.location.href}`);
  window.addEventListener('DOMContentLoaded', () => {
    void debugActivityCardStartup(`dom-content-loaded href=${window.location.href}`);
  });
  window.addEventListener('load', () => {
    void debugActivityCardStartup(`window-load href=${window.location.href}`);
  });
  window.addEventListener('error', (event) => {
    const target = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : 'unknown';
    void debugActivityCardStartup(`error ${target} ${String(event.message ?? '')}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    void debugActivityCardStartup(`unhandledrejection ${String(event.reason ?? '')}`);
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
