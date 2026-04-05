import type { AttentionItemProjection } from '../../lib/projections/types';

export function AttentionList({ items }: { items: AttentionItemProjection[] }) {
  return (
    <section className="panel-section" aria-labelledby="attention-title">
      <div className="panel-section-header">
        <h2 id="attention-title">Attention</h2>
      </div>
      {items.length === 0 ? (
        <p className="empty-state">Nothing needs attention right now.</p>
      ) : (
        <ul className="stack-list">
          {items.map((item, index) => (
            <li key={`${item.kind}-${index}`} className={`stack-card stack-card--${item.priority}`}>
              <span className="stack-card__badge">{item.kind}</span>
              <p className="stack-card__summary">{item.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
