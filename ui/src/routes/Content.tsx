import type { FormEvent, ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApiFetch } from '../auth/useApiFetch';
import { createContent, listContent } from '../api/content';
import { parseList, slugify } from '../lib/text';
import type {
  ContentSource,
  ContentStatus,
  ContentSummary,
  ContentType,
} from '../api/types';

const CONTENT_TYPES: ContentType[] = ['blog', 'social', 'video'];
const CONTENT_SOURCES: ContentSource[] = ['owned', 'sponsored'];
const CONTENT_STATUSES: ContentStatus[] = ['draft', 'scheduled', 'published', 'archived'];

type TypeFilter = ContentType | 'all';
type SourceFilter = ContentSource | 'all';
type StatusFilter = ContentStatus | 'all';

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export default function Content(): ReactElement {
  const apiFetch = useApiFetch();

  const [content, setContent] = useState<ContentSummary[]>([]);
  const [nextStartKey, setNextStartKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const load = useCallback(async (startKey?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await listContent(apiFetch, {
        type: typeFilter === 'all' ? undefined : typeFilter,
        source: sourceFilter === 'all' ? undefined : sourceFilter,
        status: statusFilter === 'all' ? undefined : statusFilter,
        startKey,
      });
      setContent((prev) => (startKey ? [...prev, ...res.content] : res.content));
      setNextStartKey(res.nextStartKey);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, typeFilter, sourceFilter, statusFilter]);

  // Reload from the top whenever a filter changes (load identity tracks them).
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Content</h1>
          <p className="text-sm text-muted-foreground">
            Your unified content catalog — blogs, social, and video. Each piece is embedded for Ask
            and feeds your content voice. Create one with “Add content” below.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Close' : 'Add content'}
        </button>
      </header>

      {adding && <AddContentForm apiFetch={apiFetch} onCreated={() => { setAdding(false); void load(); }} />}

      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Type</span>
          <select
            className="input w-auto py-1.5"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
          >
            <option value="all">All</option>
            {CONTENT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Source</span>
          <select
            className="input w-auto py-1.5"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
          >
            <option value="all">All</option>
            {CONTENT_SOURCES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Status</span>
          <select
            className="input w-auto py-1.5"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            <option value="all">All</option>
            {CONTENT_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="form-error">Could not load content: {error}</p>}

      {loading && content.length === 0 ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : content.length === 0 ? (
        <div className="card card-body text-center text-muted-foreground py-10">
          <p className="text-foreground font-medium">No content yet</p>
          <p className="text-sm mt-1">
            Use “Add content” above to create your first piece. Once it’s here it’s vectorized
            automatically for Ask and the content voice.
          </p>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {content.map((c) => (
              <li key={c.content_id}>
                <Link
                  to={`/content/${c.content_id}`}
                  className="card card-body block hover:bg-muted transition-colors"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-foreground truncate">{c.title}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{fmtDate(c.created_at)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 mt-1">
                    {c.type && (
                      <span className="px-2 py-0.5 rounded-full text-xs bg-primary-100 text-primary-700">{c.type}</span>
                    )}
                    {c.status && (
                      <span className="px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">{c.status}</span>
                    )}
                    {c.source && (
                      <span className="px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">{c.source}</span>
                    )}
                  </div>
                  {c.description && (
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{c.description}</p>
                  )}
                  {c.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {c.tags.slice(0, 6).map((t) => (
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

function AddContentForm({
  apiFetch,
  onCreated,
}: {
  apiFetch: ReturnType<typeof useApiFetch>;
  onCreated: () => void;
}): ReactElement {
  const [type, setType] = useState<ContentType>('blog');
  const [source, setSource] = useState<ContentSource>('owned');
  const [status, setStatus] = useState<ContentStatus>('draft');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [categories, setCategories] = useState('');
  const [canonicalUrl, setCanonicalUrl] = useState('');
  const [publishDate, setPublishDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugTouched ? slug : slugify(title);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || title.trim().length === 0 || content.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const tagList = parseList(tags);
      const categoryList = parseList(categories);
      await createContent(apiFetch, {
        type,
        source,
        status,
        title: title.trim(),
        slug: effectiveSlug,
        content_markdown: content,
        description: description.trim() || undefined,
        tags: tagList.length > 0 ? tagList : undefined,
        categories: categoryList.length > 0 ? categoryList : undefined,
        canonical_url: canonicalUrl.trim() || undefined,
        publish_date: publishDate.trim() || undefined,
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
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="field-label">Type</span>
          <select className="input" value={type} onChange={(e) => setType(e.target.value as ContentType)} disabled={busy}>
            {CONTENT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">Source</span>
          <select className="input" value={source} onChange={(e) => setSource(e.target.value as ContentSource)} disabled={busy}>
            {CONTENT_SOURCES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">Status</span>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as ContentStatus)} disabled={busy}>
            {CONTENT_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
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
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Tags (optional, comma-separated)</span>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="react, typescript" disabled={busy} />
        </label>
        <label className="block">
          <span className="field-label">Categories (optional, comma-separated)</span>
          <input className="input" value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="engineering" disabled={busy} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Canonical URL (optional)</span>
          <input className="input" value={canonicalUrl} onChange={(e) => setCanonicalUrl(e.target.value)} placeholder="https://…" disabled={busy} />
        </label>
        <label className="block">
          <span className="field-label">Publish date (optional)</span>
          <input type="date" className="input" value={publishDate} onChange={(e) => setPublishDate(e.target.value)} disabled={busy} />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Creating an unsponsored piece. Add a sponsorship (campaign) later from the content’s page.
      </p>
      {error && <p className="form-error">{error}</p>}
      <button type="submit" className="btn-primary" disabled={busy || !title.trim() || !content.trim()}>
        {busy ? 'Saving…' : 'Save content'}
      </button>
    </form>
  );
}
