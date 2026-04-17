import type { RecentItemProjection } from '../../lib/projections/types';

export function RecentList({ items }: { items: RecentItemProjection[] }) {
  return (
    <section className="panel-section" aria-labelledby="recent-activity-title">
      <div className="panel-section-header">
        <div>
          <h2 id="recent-activity-title">Recent activity</h2>
          <p className="section-kicker">Latest broker events across the selected project</p>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="empty-state">Recent activity will show up here.</p>
      ) : (
        <ul className="stack-list">
          {items.map((item) => (
            <li key={item.id} className={`stack-card stack-card--${item.priority}`}>
              {item.actorLabel || item.projectLabel ? (
                <div className="stack-card__topline">
                  <strong>{item.actorLabel ?? 'Broker event'}</strong>
                  {item.projectLabel ? <span>{item.projectLabel}</span> : <span />}
                </div>
              ) : null}
              <p className="stack-card__summary">{item.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
