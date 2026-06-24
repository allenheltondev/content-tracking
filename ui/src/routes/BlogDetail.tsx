import type { FormEvent, ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApiFetch } from '../auth/useApiFetch';
import {
  CROSSPOST_PLATFORMS,
  askBlog,
  crosspostBlog,
  deleteBlogPost,
  getBlogPost,
  getCrosspostStatus,
} from '../api/blogs';
import { createVoiceSample } from '../api/voice';
import type { Blog, BlogAnswer, CrosspostPlatform, CrosspostStatus } from '../api/types';
import Markdown from '../components/MarkdownLazy';

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function BlogDetail(): ReactElement {
  const { blogId = '' } = useParams();
  const apiFetch = useApiFetch();
  const navigate = useNavigate();

  const [blog, setBlog] = useState<Blog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getBlogPost(apiFetch, blogId)
      .then((b) => { if (active) setBlog(b); })
      .catch((err) => { if (active) setError((err as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [apiFetch, blogId]);

  if (loading) return <p className="text-muted-foreground">Loading…</p>;
  if (error) return <p className="form-error">Could not load post: {error}</p>;
  if (!blog) return <p className="text-muted-foreground">Not found.</p>;

  return (
    <section className="space-y-6 max-w-3xl">
      <div>
        <Link to="/blogs" className="btn-link text-sm">← All posts</Link>
      </div>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">{blog.title}</h1>
        <p className="text-xs text-muted-foreground">
          {blog.slug} · created {fmtDate(blog.created_at)}
          {blog.updated_at && blog.updated_at !== blog.created_at && ` · updated ${fmtDate(blog.updated_at)}`}
        </p>
        <div className="flex flex-wrap gap-3 text-sm pt-1">
          {blog.canonical_url && (
            <a href={blog.canonical_url} target="_blank" rel="noreferrer noopener" className="btn-link">Canonical ↗</a>
          )}
          {blog.campaign_id && (
            <Link to={`/campaigns/${blog.campaign_id}`} className="btn-link">Linked campaign</Link>
          )}
        </div>
      </header>

      <ActionsRow blog={blog} apiFetch={apiFetch} onDeleted={() => navigate('/blogs')} />

      {blog.content_markdown ? (
        <article className="card card-body text-sm">
          <Markdown>{blog.content_markdown}</Markdown>
        </article>
      ) : (
        <p className="text-sm text-muted-foreground">This post has no stored content.</p>
      )}

      <CrosspostPanel blogId={blog.blog_id} apiFetch={apiFetch} />
      <AskPanel blogId={blog.blog_id} apiFetch={apiFetch} />
    </section>
  );
}

function ActionsRow({
  blog, apiFetch, onDeleted,
}: {
  blog: Blog;
  apiFetch: ReturnType<typeof useApiFetch>;
  onDeleted: () => void;
}): ReactElement {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveToVoice = async (): Promise<void> => {
    setSaveState('saving');
    setError(null);
    try {
      const text = blog.content_markdown ? `${blog.title}\n\n${blog.content_markdown}` : blog.title;
      await createVoiceSample(apiFetch, { text, platform: 'blog', format: 'blog', source: 'manual' });
      setSaveState('saved');
    } catch (err) {
      setError((err as Error).message);
      setSaveState('idle');
    }
  };

  const doDelete = async (): Promise<void> => {
    setDeleting(true);
    setError(null);
    try {
      await deleteBlogPost(apiFetch, blog.blog_id);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary btn-sm" onClick={() => void saveToVoice()} disabled={saveState !== 'idle'}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved to voice ✓' : 'Save to blog voice'}
        </button>
        {confirming ? (
          <>
            <button type="button" className="btn-destructive btn-sm" onClick={() => void doDelete()} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirming(false)} disabled={deleting}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirming(true)}>Delete</button>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

function CrosspostPanel({ blogId, apiFetch }: { blogId: string; apiFetch: ReturnType<typeof useApiFetch> }): ReactElement {
  const [selected, setSelected] = useState<Set<CrosspostPlatform>>(new Set());
  const [staggerDays, setStaggerDays] = useState('');
  const [status, setStatus] = useState<CrosspostStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await getCrosspostStatus(apiFetch, blogId));
    } catch {
      // No run yet / not found — leave status null.
    }
  }, [apiFetch, blogId]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const toggle = (p: CrosspostPlatform): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const days = staggerDays.trim() ? Number(staggerDays) : undefined;
      await crosspostBlog(apiFetch, blogId, [...selected], days);
      await loadStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-body space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">Cross-post</h2>
        <button type="button" className="btn-link text-xs" onClick={() => void loadStatus()}>Refresh status</button>
      </div>

      <form onSubmit={submit} className="space-y-3">
        <div className="flex flex-wrap gap-3">
          {CROSSPOST_PLATFORMS.map((p) => (
            <label key={p} className="flex items-center gap-1.5 text-sm capitalize">
              <input type="checkbox" checked={selected.has(p)} onChange={() => toggle(p)} disabled={busy} />
              {p === 'dev' ? 'DEV' : p}
            </label>
          ))}
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            stagger
            <input
              type="number" min={0} max={28} className="input w-16 py-1"
              value={staggerDays} onChange={(e) => setStaggerDays(e.target.value)} placeholder="0" disabled={busy}
            />
            days
          </label>
          <button type="submit" className="btn-secondary btn-sm" disabled={busy || selected.size === 0}>
            {busy ? 'Starting…' : 'Cross-post'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Requires platform credentials configured in Settings. Staggering spaces the publishes apart.
        </p>
      </form>

      {error && <p className="form-error">{error}</p>}

      {status?.platforms && status.platforms.length > 0 && (
        <div className="space-y-1 border-t border-border pt-3">
          <h3 className="field-label">Status{status.run ? ` · ${status.run.status}` : ''}</h3>
          <ul className="space-y-1 text-sm">
            {status.platforms.map((c) => (
              <li key={c.platform} className="flex items-center justify-between gap-3">
                <span className="capitalize text-foreground">{c.platform}</span>
                <span className="text-muted-foreground">
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer noopener" className="btn-link">{c.status} ↗</a>
                  ) : (
                    c.error ? `error: ${c.error}` : c.status
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AskPanel({ blogId, apiFetch }: { blogId: string; apiFetch: ReturnType<typeof useApiFetch> }): ReactElement {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<BlogAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || question.trim().length === 0) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await askBlog(apiFetch, { question: question.trim(), blogId }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card card-body space-y-3">
      <h2 className="text-lg font-semibold text-foreground">Ask about this post</h2>
      <div className="flex gap-2">
        <input
          className="input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. What's the main takeaway?"
          disabled={busy}
        />
        <button type="submit" className="btn-secondary shrink-0" disabled={busy || !question.trim()}>
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {answer && (
        <div className="border-t border-border pt-3 text-sm">
          <Markdown>{answer.answer}</Markdown>
        </div>
      )}
    </form>
  );
}
