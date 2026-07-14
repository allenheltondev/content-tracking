import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useApiFetch } from '../auth/useApiFetch';
import { useAuth } from '../auth/useAuth';
import { askBlog } from '../api/blogs';
import { streamGenerate, streamingEnabled } from '../api/stream';
import type { BlogAnswerSource } from '../api/types';
import CopyButton from './CopyButton';
import Markdown from './MarkdownLazy';

// App-wide "Ask your blog" assistant. Mounted once in the App shell so it's
// reachable from every page, and — because the shell never unmounts on
// client-side navigation — the conversation survives moving between routes.
// It's also mirrored to sessionStorage so a reload within the tab keeps the
// thread. Each turn is answered independently against the blog RAG endpoint
// (same contract the retired /ask page used); the history here is the visual
// thread, not conversation context sent to the model.

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources?: BlogAnswerSource[];
}

const STORAGE_KEY = 'booked-chat-history';

function loadHistory(): ChatMessage[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function ChatWidget(): ReactElement {
  const apiFetch = useApiFetch();
  const { getAccessToken } = useAuth();

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadHistory());
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Persist across reloads (navigation persistence is free — the shell stays
  // mounted). Storage can be unavailable/full; a failure just means the thread
  // won't survive a reload, which is non-fatal.
  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      /* ignore */
    }
  }, [messages]);

  // Keep the newest content in view as the thread grows and streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (open && el) el.scrollTop = el.scrollHeight;
  }, [messages, open, busy]);

  const trimmed = question.trim();

  const runQuestion = async (): Promise<void> => {
    if (trimmed.length === 0 || busy) return;

    const assistantId = newId();
    setMessages((prev) => [
      ...prev,
      { id: newId(), role: 'user', text: trimmed },
      { id: assistantId, role: 'assistant', text: '' },
    ]);
    setQuestion('');
    setBusy(true);
    setError(null);

    const patchAssistant = (patch: Partial<ChatMessage>): void => {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, ...patch } : m)));
    };

    try {
      if (streamingEnabled()) {
        const token = await getAccessToken();
        let acc = '';
        const result = await streamGenerate(token, { mode: 'ask', question: trimmed }, (text) => {
          acc += text;
          patchAssistant({ text: acc });
        });
        patchAssistant({
          text: acc.length > 0 ? acc : "I couldn't find anything in your blog catalog relevant to that question.",
          sources: result.sources ?? [],
        });
      } else {
        const res = await askBlog(apiFetch, { question: trimmed });
        patchAssistant({ text: res.answer, sources: res.sources });
      }
    } catch (err) {
      setError((err as Error).message);
      // Drop the empty placeholder so a failed turn doesn't leave a blank bubble.
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    void runQuestion();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter inserts a newline (chat convention).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void runQuestion();
    }
  };

  const clear = (): void => {
    setMessages([]);
    setError(null);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open blog assistant"
        className="btn btn-primary fixed bottom-4 right-4 z-40 h-12 w-12 rounded-full p-0 text-xl shadow-lg"
      >
        <span aria-hidden>💬</span>
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Ask your blog"
      className="fixed bottom-4 right-4 z-40 flex w-[min(22rem,calc(100vw-2rem))] max-h-[min(70vh,34rem)] flex-col rounded-xl border border-border bg-surface shadow-xl"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Ask your blog</h2>
          <p className="truncate text-xs text-muted-foreground">Answers grounded in your published posts</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {messages.length > 0 && (
            <button type="button" className="btn-link text-xs" onClick={clear} disabled={busy}>
              Clear
            </button>
          )}
          <button
            type="button"
            aria-label="Close blog assistant"
            className="btn btn-ghost btn-sm px-2"
            onClick={() => setOpen(false)}
          >
            <span aria-hidden>✕</span>
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Ask a question and get an answer grounded in your own published posts, with the sources it drew on.
          </p>
        ) : (
          messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary-600 px-3 py-2 text-sm text-white">
                  {m.text}
                </p>
              </div>
            ) : (
              <div key={m.id} className="space-y-1">
                <div className="max-w-[95%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm text-foreground">
                  {m.text.length > 0 ? (
                    <Markdown>{m.text}</Markdown>
                  ) : (
                    <span className="inline-block h-4 w-1.5 animate-pulse bg-muted-foreground/70 align-text-bottom" />
                  )}
                </div>
                {m.sources && m.sources.length > 0 && (
                  <ul className="space-y-0.5 pl-1 text-xs text-muted-foreground">
                    {m.sources.map((s) => (
                      <li key={s.blog_id}>· {s.title ?? s.slug ?? s.blog_id}</li>
                    ))}
                  </ul>
                )}
                {m.text.length > 0 && <CopyButton text={m.text} className="btn-link text-xs" />}
              </div>
            ),
          )
        )}
      </div>

      {error && <p className="form-error px-4 pb-1 text-xs">Could not get an answer: {error}</p>}

      <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-border p-3">
        <textarea
          className="input flex-1 resize-none py-1.5"
          rows={1}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about your posts…"
          disabled={busy}
        />
        <button type="submit" className="btn btn-primary btn-sm shrink-0" disabled={busy || trimmed.length === 0}>
          {busy ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}
