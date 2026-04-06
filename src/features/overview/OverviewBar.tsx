import type { OverviewProjection } from '../../lib/projections/types';

export function OverviewBar({ overview }: { overview: OverviewProjection }) {
  return (
    <section className="panel-section panel-overview" aria-labelledby="broker-status-title">
      <div className="panel-section-header">
        <div>
          <h2 id="broker-status-title">Broker status</h2>
          <p className="section-kicker">Live broker health and workload snapshot</p>
        </div>
        <span className={`health-pill ${overview.brokerHealthy ? 'health-pill--good' : 'health-pill--bad'}`}>
          {overview.brokerHealthy ? 'Healthy' : 'Degraded'}
        </span>
      </div>
      <dl className="overview-grid">
        <div>
          <dt>Agents online</dt>
          <dd>{overview.onlineCount}</dd>
        </div>
        <div>
          <dt>Busy</dt>
          <dd>{overview.busyCount}</dd>
        </div>
        <div>
          <dt>Blocked</dt>
          <dd>{overview.blockedCount}</dd>
        </div>
        <div>
          <dt>Pending approvals</dt>
          <dd>{overview.pendingApprovalCount}</dd>
        </div>
      </dl>
    </section>
  );
}
