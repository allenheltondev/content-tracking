import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import type { Suggestion, SuggestionType } from '../../api/review';

// Per-type highlight styling. Kept subtle (tinted background + dotted underline)
// so the text stays readable; the active suggestion gets a solid ring.
const TYPE_STYLES: Record<SuggestionType, string> = {
  grammar: 'bg-emerald-100 decoration-emerald-500',
  spelling: 'bg-rose-100 decoration-rose-500',
  llm: 'bg-sky-100 decoration-sky-500',
  brand: 'bg-violet-100 decoration-violet-500',
  fact: 'bg-amber-100 decoration-amber-500',
};

interface Segment {
  text: string;
  suggestion?: Suggestion;
}

// Splits the raw body into plain-text and highlighted segments, in order. Later-
// starting suggestions that overlap one already placed are skipped (they can't
// be rendered as a clean span), matching the offset engine's non-overlap
// invariant.
function buildSegments(content: string, suggestions: Suggestion[]): Segment[] {
  const ordered = [...suggestions]
    .filter((s) => s.startOffset >= 0 && s.endOffset <= content.length && s.startOffset < s.endOffset)
    .sort((a, b) => a.startOffset - b.startOffset);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const s of ordered) {
    if (s.startOffset < cursor) continue; // overlaps a placed span — skip
    if (s.startOffset > cursor) segments.push({ text: content.slice(cursor, s.startOffset) });
    segments.push({ text: content.slice(s.startOffset, s.endOffset), suggestion: s });
    cursor = s.endOffset;
  }
  if (cursor < content.length) segments.push({ text: content.slice(cursor) });
  return segments;
}

interface Props {
  content: string;
  suggestions: Suggestion[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

// Renders the raw draft (markdown source) with the suggestion spans highlighted
// and clickable. Offsets index into the source text, so this shows the source —
// not rendered markdown — which is what the author edits.
export default function SuggestionHighlights({ content, suggestions, activeId, onSelect }: Props): ReactElement {
  const activeRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeId]);

  const segments = buildSegments(content, suggestions);

  return (
    <div className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground">
      {segments.map((seg, i) => {
        if (!seg.suggestion) return <span key={i}>{seg.text}</span>;
        const s = seg.suggestion;
        const active = s.id === activeId;
        return (
          <mark
            key={s.id}
            ref={active ? activeRef : null}
            data-suggestion-id={s.id}
            onClick={() => onSelect(s.id)}
            title={s.reason}
            className={`cursor-pointer rounded-sm px-0.5 underline decoration-dotted underline-offset-2 ${TYPE_STYLES[s.type]} ${
              active ? 'ring-2 ring-offset-1 ring-primary-500' : ''
            }`}
          >
            {seg.text}
          </mark>
        );
      })}
    </div>
  );
}
