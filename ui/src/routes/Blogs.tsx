import type { FormEvent, ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApiFetch } from '../auth/useApiFetch';
import { createBlogPost, listBlogs } from '../api/blogs';
import type { BlogSummary } from '../api/types';

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

// Server requires kebab-case; offer a sensible default derived from the title.
function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export default function Blogs(): ReactElement {
  const apiFetch = useApiFetch();

  const [blogs, setBlogs] = useState<BlogSummary[]>([]);
  const [nextStartKey, setNextStartKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (startKey?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await listBlogs(apiFetch, startKey);
      setBlogs((prev) => (startKey ? [...prev, ...res.blogs] : res.blogs));
      setNextStartKey(res.nextStartKey);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Blog posts</h1>
          <p className="text-sm text-muted-foreground">
            Your tracked catalog. Each post is embedded for Ask and feeds your blog voice. Bulk-import
            from your repo with scripts/import-blogs.mjs; add one-offs here.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Close' : 'Add post'}
        </button>
      </header>

      {adding && <AddPostForm apiFetch={apiFetch} onCreated={() => { setAdding(false); void load(); }} />}

      {error && <p className="form-error">Could not load posts: {error}</p>}

      {loading && blogs.length === 0 ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : blogs.length === 0 ? (
        <div className="card card-body text-center text-muted-foreground py-10">
          <p className="text-foreground font-medium">No blog posts tracked yet</p>
          <p className="text-sm mt-1">
            Run scripts/import-blogs.mjs to bring in your catalog, or use “Add post” above. Once a post
            is here it’s vectorized automatically for Ask and the blog voice.
          </p>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {blogs.map((b) => (
              <li key={b.blog_id}>
                <Link
                  to={`/blogs/${b.blog_id}`}
                  className="card card-body block hover:bg-muted transition-colors"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-foreground truncate">{b.title}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{fmtDate(b.created_at)}</span>
                  </div>
                  {b.description && (
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{b.description}</p>
                  )}
                  {b.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {b.tags.slice(0, 6).map((t) => (
                        <span key={t} className="px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">{t}</span>
                      ))}
                    </div>
                  )}
                </Link>
              </li>
            ))}
          </ul>

          {nextStartKey && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void load(nextStartKey)}
              disabled={loading}
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function AddPostForm({
  apiFetch,
  onCreated,
}: {
  apiFetch: ReturnType<typeof useApiFetch>;
  onCreated: () => void;
}): ReactElement {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugTouched ? slug : slugify(title);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || title.trim().length === 0 || content.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await createBlogPost(apiFetch, {
        title: title.trim(),
        slug: effectiveSlug,
        content_markdown: content,
        description: description.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card card-body space-y-3">
      <label className="block">
        <span className="field-label">Title</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
      </label>
      <label className="block">
        <span className="field-label">Slug</span>
        <input
          className="input"
          value={effectiveSlug}
          onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }}
          placeholder="kebab-case"
          disabled={busy}
        />
      </label>
      <label className="block">
        <span className="field-label">Description (optional)</span>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
      </label>
      <label className="block">
        <span className="field-label">Content (markdown)</span>
        <textarea className="input" rows={8} value={content} onChange={(e) => setContent(e.target.value)} disabled={busy} />
      </label>
      {error && <p className="form-error">{error}</p>}
      <button type="submit" className="btn-primary" disabled={busy || !title.trim() || !content.trim()}>
        {busy ? 'Saving…' : 'Save post'}
      </button>
    </form>
  );
}
