import { useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

async function startJsDragging(
  setStatus: (value: string) => void,
  source: 'mouse' | 'pointer'
): Promise<void> {
  setStatus(`Trying JS startDragging via ${source}...`);

  try {
    await getCurrentWindow().startDragging();
    setStatus(`JS startDragging fired from ${source}. If the window did not move, this path is not usable here.`);
  } catch (error) {
    setStatus(`JS startDragging failed from ${source}: ${String(error)}`);
  }
}

export function DragDemoRoute({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState('No drag test attempted yet.');

  return (
    <main className="drag-demo-shell">
      <header className="drag-demo-header">
        <div>
          <p className="drag-demo-kicker">HexDeck Drag Lab</p>
          <h1>Window Drag Demos</h1>
          <p className="drag-demo-subtitle">
            Drag each highlighted area. We only merge the working mechanism back into the product shell.
          </p>
        </div>
        <button type="button" className="settings-btn" onClick={onClose}>
          Close
        </button>
      </header>

      <section className="drag-demo-status">
        <strong>Last Result</strong>
        <p>{status}</p>
      </section>

      <section className="drag-demo-card">
        <div className="drag-demo-card__copy">
          <p className="compact-section-title">Demo A</p>
          <h2>Native Drag Region Strip</h2>
          <p>Try dragging the blue strip below. This uses `data-tauri-drag-region` on a plain block.</p>
        </div>
        <div
          className="drag-demo-zone drag-demo-zone--native"
          data-tauri-drag-region
          onMouseDown={() => setStatus('Trying native drag region strip...')}
        >
          Native drag region strip
        </div>
      </section>

      <section className="drag-demo-card">
        <div className="drag-demo-card__copy">
          <p className="compact-section-title">Demo B</p>
          <h2>Nested Native Drag Region</h2>
          <p>Try dragging the title block. Every nested text node also has `data-tauri-drag-region`.</p>
        </div>
        <div className="drag-demo-zone drag-demo-zone--nested" data-tauri-drag-region>
          <div data-tauri-drag-region>
            <strong data-tauri-drag-region>Nested drag title</strong>
            <p data-tauri-drag-region>Subtitle inside the same native drag region</p>
          </div>
          <span data-tauri-drag-region className="drag-demo-pill">
            Drag me
          </span>
        </div>
      </section>

      <section className="drag-demo-card">
        <div className="drag-demo-card__copy">
          <p className="compact-section-title">Demo C</p>
          <h2>JS startDragging</h2>
          <p>Try the orange block. This uses `getCurrentWindow().startDragging()` from web code.</p>
        </div>
        <div
          className="drag-demo-zone drag-demo-zone--js"
          onMouseDown={() => void startJsDragging(setStatus, 'mouse')}
          onPointerDown={() => setStatus('Pointer down received for JS drag demo.')}
        >
          JS startDragging zone
        </div>
      </section>

      <section className="drag-demo-notes">
        <h2>How to report back</h2>
        <p>Tell me which demo can actually move the window: A, B, C, or none.</p>
        <p>The standard Windows title bar is intentionally enabled on this demo window. If only the title bar can drag, that is also useful signal.</p>
      </section>
    </main>
  );
}
