import type { ReactElement } from 'react';

export interface Pair {
  key: string;
  value: string;
}

interface Props {
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export default function KeyValueEditor({
  pairs,
  onChange,
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
}: Props): ReactElement {
  const update = (index: number, patch: Partial<Pair>): void => {
    const next = pairs.map((p, i) => (i === index ? { ...p, ...patch } : p));
    onChange(next);
  };

  const remove = (index: number): void => {
    onChange(pairs.filter((_, i) => i !== index));
  };

  const add = (): void => {
    onChange([...pairs, { key: '', value: '' }]);
  };

  return (
    <div className="space-y-2">
      {pairs.length === 0 && <p className="text-sm text-muted-foreground">No entries.</p>}
      {pairs.map((pair, i) => (
        <div className="grid grid-cols-[1fr_2fr_auto] gap-2" key={i}>
          <input
            className="input"
            placeholder={keyPlaceholder}
            value={pair.key}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <input
            className="input"
            placeholder={valuePlaceholder}
            value={pair.value}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <button
            type="button"
            className="btn btn-ghost px-2 text-error-600 hover:bg-error-50"
            onClick={() => remove(i)}
            aria-label="Remove row"
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
        + Add row
      </button>
    </div>
  );
}
