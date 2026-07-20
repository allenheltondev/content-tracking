import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import type { Suggestion, SuggestionType } from '../../api/review';

const TYPE_LABEL: Record<SuggestionType, string> = {
  grammar: 'Grammar & clarity',
  spelling: 'Spelling',
  llm: 'Sounds AI-generated',
  brand: 'Off your voice',
  fact: 'Fact check',
};

const TYPE_DOT: Record<SuggestionType, string> = {
  grammar: 'bg-emerald-500',
  spelling: 'bg-rose-500',
  llm: 'bg-sky-500',
  brand: 'bg-violet-500',
  fact: 'bg-amber-500',
};

interface Props {
  suggestion: Suggestion;
  index: number;
  total: number;
  busy: boolean;
  // Accept the suggestion. Pass an edited replacement to apply that instead of
  // the suggested text (inline edit-before-accept).
  onAccept: (edited?: string) => void;
  onReject: () => void;
  onDismiss: () => void;
  onPrev: () => void;
  onNext: () => void;
}

// The active-suggestion card: what the lens found, the exact before → after, and
// the accept / reject / dismiss actions — plus inline edit, so the author can
// tweak the replacement before accepting — and navigation through the set.
export default function SuggestionCard({
  suggestion,
  index,
  total,
  busy,
  onAccept,
  onReject,
  onDismiss,
  onPrev,
  onNext,
}: Props): ReactElement {
  const s = suggestion;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.replaceWith);

  // Reset the edit state whenever the active suggestion changes (navigation,
  // accept/reject shifting the list), so the draft never leaks between cards.
  useEffect(() => {
    setEditing(false);
    setDraft(s.replaceWith);
  }, [s.id, s.replaceWith]);

  return (
    <div className="border border-border rounded-lg bg-surface p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          <span className={`h-2 w-2 rounded-full ${TYPE_DOT[s.type]}`} />
          {TYPE_LABEL[s.type]}
          <span className="text-xs text-muted-foreground">· {s.priority}</span>
        </span>
        <span className="text-xs text-muted-foreground">
          {index + 1} / {total}
        </span>
      </div>

      <p className="text-sm text-foreground">{s.reason}</p>

      <div className="space-y-1 text-sm">
        <div className="bg-rose-50 rounded px-2 py-1 font-mono text-xs break-words line-through decoration-rose-400">
          {s.textToReplace}
        </div>
        {editing ? (
          <textarea
            className="input w-full font-mono text-xs"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            aria-label="Edit replacement text"
          />
        ) : (
          <div className="bg-emerald-50 rounded px-2 py-1 font-mono text-xs break-words">
            {s.replaceWith || <span className="italic text-muted-foreground">(delete)</span>}
          </div>
        )}
      </div>

      {editing ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onAccept(draft)} disabled={busy}>
            Accept edit
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => { setEditing(false); setDraft(s.replaceWith); }}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onAccept()} disabled={busy}>
            Accept
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onReject} disabled={busy}>
            Reject
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)} disabled={busy}>
            Edit
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss} disabled={busy}>
            Dismiss
          </button>
          <span className="ml-auto flex gap-1">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onPrev} disabled={busy || total <= 1} aria-label="Previous suggestion">
              ‹
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onNext} disabled={busy || total <= 1} aria-label="Next suggestion">
              ›
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
