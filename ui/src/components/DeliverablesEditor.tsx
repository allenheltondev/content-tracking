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
    <div className="space-y-2">
      {deliverables.length === 0 && (
        <p className="text-sm text-muted-foreground">No deliverables. Add one to track scope.</p>
      )}
      {deliverables.map((d, i) => (
        <div className="grid grid-cols-[1.3fr_1.3fr_0.5fr_2fr_auto] gap-2" key={i}>
          <input
            className="input"
            placeholder="platform (instagram, youtube, ...)"
            value={d.platform}
            onChange={(e) => update(i, { platform: e.target.value })}
          />
          <input
            className="input"
            placeholder="type (reel, post, ...)"
            value={d.type}
            onChange={(e) => update(i, { type: e.target.value })}
          />
          <input
            className="input"
            type="number"
            min={1}
            value={d.count ?? 1}
            onChange={(e) => update(i, { count: Math.max(1, Number(e.target.value) || 1) })}
          />
          <input
            className="input"
            placeholder="notes"
            value={d.notes ?? ''}
            onChange={(e) => update(i, { notes: e.target.value })}
          />
          <button
            type="button"
            className="btn-ghost px-2 text-error-600 hover:bg-error-50"
            onClick={() => remove(i)}
            aria-label="Remove deliverable"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-sm border border-dashed border-border text-muted-foreground hover:bg-muted hover:text-foreground rounded-md px-3 py-1.5"
        onClick={add}
      >
        + Add deliverable
      </button>
    </div>
  );
}
