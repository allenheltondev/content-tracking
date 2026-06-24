import type { FormEvent, ReactElement } from 'react';
import { useState } from 'react';
import { useApiFetch } from '../auth/useApiFetch';
import { askBlog } from '../api/blogs';
import type { BlogAnswer, BlogAnswerConfidence } from '../api/types';
import CopyButton from '../components/CopyButton';

// Confidence pill styling. High = the excerpts directly answered the question;
// low = they barely touched it (or the catalog had nothing relevant).
const CONFIDENCE_CLASS: Record<BlogAnswerConfidence, string> = {
  high: 'bg-success-100 text-success-700',
  medium: 'bg-primary-100 text-primary-700',
  low: 'bg-muted text-muted-foreground',
};

export default function Ask(): ReactElement {
  const apiFetch = useApiFetch();

  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<BlogAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = question.trim();

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await askBlog(apiFetch, { question: trimmed });
      setAnswer(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6 max-w-3xl">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">Ask your blog</h1>
        <p className="text-sm text-muted-foreground">
          Ask a question and get an answer grounded in your own published posts, with the
          sources it drew on.
        </p>
      </header>

      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="field-label">Question</span>
          <textarea
            className="input"
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. What have I written about cutting build times?"
            disabled={busy}
            // Submit on Cmd/Ctrl+Enter, like a chat composer; plain Enter adds a
            // newline so multi-line questions are easy to type.
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
            }}
          />
        </label>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary" disabled={busy || trimmed.length === 0}>
            {busy ? 'Thinking…' : 'Ask'}
          </button>
          <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter</span>
        </div>
      </form>

      {error && <p className="form-error">Could not get an answer: {error}</p>}

      {answer && <AnswerCard answer={answer} />}
    </section>
  );
}

function AnswerCard({ answer }: { answer: BlogAnswer }): ReactElement {
  return (
    <div className="card card-body space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">Answer</h2>
        <div className="flex items-center gap-2">
          <span
            className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${CONFIDENCE_CLASS[answer.confidence]}`}
          >
            {answer.confidence} confidence
          </span>
          <CopyButton text={answer.answer} />
        </div>
      </div>

      <p className="text-foreground whitespace-pre-wrap">{answer.answer}</p>

      {answer.sources.length > 0 && (
        <div className="space-y-2 border-t border-border pt-3">
          <h3 className="field-label">Sources</h3>
          <ul className="space-y-1">
            {answer.sources.map((s) => (
              <li key={s.blog_id} className="text-sm text-foreground">
                {s.title ?? s.slug ?? s.blog_id}
                {s.title && s.slug && (
                  <span className="text-muted-foreground"> · {s.slug}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
