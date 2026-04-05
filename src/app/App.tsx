import { PanelRoute } from './routes/panel';
import type { ProjectSnapshotProjection } from '../lib/projections/types';
import '../styles/tokens.css';
import '../styles/panel.css';

const bootstrapSnapshot: ProjectSnapshotProjection = {
  overview: {
    brokerHealthy: true,
    onlineCount: 0,
    busyCount: 0,
    blockedCount: 0,
    pendingApprovalCount: 0,
  },
  now: [],
  attention: [],
  recent: [],
};

export function App() {
  return (
    <main className="panel-shell">
      <header className="panel-hero">
        <h1>HexDeck</h1>
        <p>Menu bar companion bootstrap complete.</p>
      </header>
      <PanelRoute snapshot={bootstrapSnapshot} />
    </main>
  );
}
