import type { RecentItemProjection } from '../../lib/projections/types';

export function RecentList({ items }: { items: RecentItemProjection[] }) {
  return (
    <section className="panel-section" aria-labelledby="recent-title">
      <div className="panel-section-header">
        <h2 id="recent-title">Recent</h2>
      </div>
      {items.length === 0 ? (
        <p className="empty-state">Recent activity will show up here.</p>
      ) : (
        <ul className="stack-list">
          {items.map((item) => (
            <li key={item.id} className={`stack-card stack-card--${item.priority}`}>
              <p className="stack-card__summary">{item.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
