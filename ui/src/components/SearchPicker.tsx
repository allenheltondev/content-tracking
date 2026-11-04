import type { KeyboardEvent, ReactElement, ReactNode, Ref } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

export interface PickerOption {
  id: string;
  label: string;
  detail?: string;
  badge?: ReactNode;
}

interface Props {
  // Already filtered and in display order. The caller owns matching, so each
  // picker can search the fields that make sense for it.
  options: PickerOption[];
  // Shown under their own heading but can't be chosen.
  unavailable: PickerOption[];
  unavailableLabel: string;
  search: string;
  onSearchChange: (search: string) => void;
  value: string | null;
  onChange: (id: string) => void;
  // Enter on the option that's already selected.
  onConfirm: () => void;
  searchLabel: string;
  listLabel: string;
  placeholder: string;
  loadingMessage: string;
  emptyMessage: string;
  loading?: boolean;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

// Searchable list following the ARIA combobox pattern: focus stays in the input
// while the arrow keys move the highlighted option. Presentational, so the
// caller owns loading and the search text.
export default function SearchPicker({
  options,
  unavailable,
  unavailableLabel,
  search,
  onSearchChange,
  value,
  onChange,
  onConfirm,
  searchLabel,
  listLabel,
  placeholder,
  loadingMessage,
  emptyMessage,
  loading,
  disabled,
  inputRef,
}: Props): ReactElement {
  const listId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((i) => Math.min(Math.max(i + step, 0), Math.max(options.length - 1, 0)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const option = options[activeIndex];
      if (!option) return;
      if (option.id === value) onConfirm();
      else onChange(option.id);
    }
  };

  const isEmpty = options.length === 0 && unavailable.length === 0;
  const active = options[activeIndex];

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="search"
        className="input"
        role="combobox"
        aria-label={searchLabel}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active ? `${listId}-${active.id}` : undefined}
        placeholder={placeholder}
        value={search}
        disabled={disabled}
        onChange={(e) => {
          onSearchChange(e.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
      />

      <ul
        id={listId}
        role="listbox"
        aria-label={listLabel}
        className="h-72 space-y-1 overflow-y-auto rounded-lg border border-border p-1.5"
      >
        {isEmpty && (
          <li role="presentation" className="px-3 py-8 text-center text-sm text-muted-foreground">
            {loading ? loadingMessage : emptyMessage}
          </li>
        )}

        {options.map((option, i) => {
          const selected = option.id === value;
          const highlighted = i === activeIndex;
          const stateClasses = selected
            ? 'bg-muted ring-2 ring-inset ring-primary-500'
            : highlighted
              ? 'bg-muted'
              : 'hover:bg-muted';
          return (
            <li
              key={option.id}
              id={`${listId}-${option.id}`}
              ref={highlighted ? activeRef : undefined}
              role="option"
              aria-selected={selected}
              className={`cursor-pointer rounded-md px-3 py-2 transition-colors ${stateClasses}`}
              onClick={() => {
                if (disabled) return;
                setActiveIndex(i);
                onChange(option.id);
              }}
            >
              <OptionBody option={option} />
            </li>
          );
        })}

        {unavailable.length > 0 && (
          <li role="presentation" className="px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground">
            {unavailableLabel}
          </li>
        )}
        {unavailable.map((option) => (
          <li
            key={option.id}
            role="option"
            aria-selected={false}
            aria-disabled="true"
            className="cursor-not-allowed rounded-md px-3 py-2 opacity-60"
          >
            <OptionBody option={option} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function OptionBody({ option }: { option: PickerOption }): ReactElement {
  return (
    <>
      <span className="flex items-center justify-between gap-3">
        <span className="truncate text-sm font-medium text-foreground">{option.label}</span>
        {option.badge}
      </span>
      {option.detail && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{option.detail}</span>}
    </>
  );
}
