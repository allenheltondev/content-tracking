import type { FormEvent, ReactElement } from 'react';
import { useState } from 'react';
import { useApiFetch } from '../auth/useApiFetch';
import { useAuth } from '../auth/useAuth';
import { askBlog } from '../api/blogs';
import { streamGenerate, streamingEnabled } from '../api/stream';
import type { BlogAnswerConfidence, BlogAnswerSource } from '../api/types';
import CopyButton from '../components/CopyButton';
import Markdown from '../components/MarkdownLazy';

// Confidence pill styling. High = the excerpts directly answered the question;
// low = they barely touched it (or the catalog had nothing relevant). Only the
// buffered REST path returns a confidence; the streaming path omits it.
const CONFIDENCE_CLASS: Record<BlogAnswerConfidence, string> = {
  high: 'bg-success-100 text-success-700',
  medium: 'bg-primary-100 text-primary-700',
  low: 'bg-muted text-muted-foreground',
};

export default function Ask(): ReactElement {
  const apiFetch = useApiFetch();
  const { getAccessToken } = useAuth();

  const [question, setQuestion] = useState('');
  const [answerText, setAnswerText] = useState('');
  const [sources, setSources] = useState<BlogAnswerSource[]>([]);
  const [confidence, setConfidence] = useState<BlogAnswerConfidence | null>(null);
  const [hasAnswer, setHasAnswer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = question.trim();

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setSources([]);
    setConfidence(null);
    setAnswerText('');
    try {
      if (streamingEnabled()) {
        setHasAnswer(true); // show the card and fill it live
        const token = await getAccessToken();
        let acc = '';
        const result = await streamGenerate(token, { mode: 'ask', question: trimmed }, (text) => {
          acc += text;
          setAnswerText(acc);
        });
        setSources(result.sources ?? []);
        if (acc.length === 0) setHasAnswer(false);
      } else {
        const res = await askBlog(apiFetch, { question: trimmed });
        setAnswerText(res.answer);
        setSources(res.sources);
        setConfidence(res.confidence);
        setHasAnswer(true);
      }
    } catch (err) {
      setError((err as Error).message);
      setHasAnswer(false);
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

      {hasAnswer && (
        <div className="card card-body space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-foreground">Answer</h2>
            <div className="flex items-center gap-2">
              {confidence && (
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${CONFIDENCE_CLASS[confidence]}`}>
                  {confidence} confidence
                </span>
              )}
              {!busy && answerText.length > 0 && <CopyButton text={answerText} />}
            </div>
          </div>

          {busy ? (
            <p className="text-foreground whitespace-pre-wrap">
              {answerText}
              <span className="inline-block w-1.5 h-4 align-text-bottom bg-muted-foreground/70 animate-pulse ml-0.5" />
            </p>
          ) : (
            <div className="text-sm"><Markdown>{answerText}</Markdown></div>
          )}

          {sources.length > 0 && (
            <div className="space-y-2 border-t border-border pt-3">
              <h3 className="field-label">Sources</h3>
              <ul className="space-y-1">
                {sources.map((s) => (
                  <li key={s.blog_id} className="text-sm text-foreground">
                    {s.title ?? s.slug ?? s.blog_id}
                    {s.title && s.slug && <span className="text-muted-foreground"> · {s.slug}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
