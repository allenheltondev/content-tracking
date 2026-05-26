import type { KeyboardEvent, ReactElement } from 'react';
import { useState } from 'react';

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}

// Chip-style tag editor. Comma or Enter commits the buffer to a tag;
// Backspace on an empty buffer removes the last chip.
export default function TagsInput({
  tags,
  onChange,
  placeholder = 'Add tags',
  disabled = false,
}: Props): ReactElement {
  const [buffer, setBuffer] = useState('');

  const commit = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    if (tags.includes(trimmed)) {
      setBuffer('');
      return;
    }
    onChange([...tags, trimmed]);
    setBuffer('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(buffer);
    } else if (e.key === 'Backspace' && buffer.length === 0 && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-wrap gap-1 border border-border rounded-lg p-1.5 bg-surface min-h-[2.5rem]">
      {tags.map((tag, i) => (
        <span className="tag-chip" key={`${tag}-${i}`}>
          {tag}
          <button
            type="button"
            className="text-primary-700 hover:text-error-600 leading-none"
            onClick={() => onChange(tags.filter((_, j) => j !== i))}
            aria-label={`Remove tag ${tag}`}
            disabled={disabled}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        className="flex-1 min-w-[100px] bg-transparent outline-none text-sm px-1"
        value={buffer}
        onChange={(e) => setBuffer(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => commit(buffer)}
        placeholder={tags.length === 0 ? placeholder : ''}
        disabled={disabled}
      />
    </div>
  );
}
