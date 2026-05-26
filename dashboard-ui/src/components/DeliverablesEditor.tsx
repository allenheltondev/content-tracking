import type { ReactElement } from 'react';
import type { Deliverable } from '../api/types';

interface Props {
  deliverables: Deliverable[];
  onChange: (deliverables: Deliverable[]) => void;
}

export default function DeliverablesEditor({ deliverables, onChange }: Props): ReactElement {
  const update = (index: number, patch: Partial<Deliverable>): void => {
    onChange(deliverables.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };

  const remove = (index: number): void => {
    onChange(deliverables.filter((_, i) => i !== index));
  };

  const add = (): void => {
    onChange([...deliverables, { platform: '', type: '', count: 1, notes: '' }]);
  };

  return (
    <div className="deliverables-editor">
      {deliverables.length === 0 && (
        <p className="kv-empty">No deliverables. Add one to track scope.</p>
      )}
      {deliverables.map((d, i) => (
        <div className="deliverable-row" key={i}>
          <input
            className="deliverable-platform"
            placeholder="platform (instagram, youtube, ...)"
            value={d.platform}
            onChange={(e) => update(i, { platform: e.target.value })}
          />
          <input
            className="deliverable-type"
            placeholder="type (reel, post, ...)"
            value={d.type}
            onChange={(e) => update(i, { type: e.target.value })}
          />
          <input
            className="deliverable-count"
            type="number"
            min={1}
            value={d.count ?? 1}
            onChange={(e) => update(i, { count: Math.max(1, Number(e.target.value) || 1) })}
          />
          <input
            className="deliverable-notes"
            placeholder="notes"
            value={d.notes ?? ''}
            onChange={(e) => update(i, { notes: e.target.value })}
          />
          <button
            type="button"
            className="deliverable-remove"
            onClick={() => remove(i)}
            aria-label="Remove deliverable"
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="kv-add" onClick={add}>
        + Add deliverable
      </button>
    </div>
  );
}
