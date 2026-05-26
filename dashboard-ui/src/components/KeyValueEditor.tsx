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
    <div className="kv-editor">
      {pairs.length === 0 && <p className="kv-empty">No entries.</p>}
      {pairs.map((pair, i) => (
        <div className="kv-row" key={i}>
          <input
            className="kv-key"
            placeholder={keyPlaceholder}
            value={pair.key}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <input
            className="kv-value"
            placeholder={valuePlaceholder}
            value={pair.value}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <button type="button" className="kv-remove" onClick={() => remove(i)} aria-label="Remove row">
            ×
          </button>
        </div>
      ))}
      <button type="button" className="kv-add" onClick={add}>
        + Add row
      </button>
    </div>
  );
}
