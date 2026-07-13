import type { FormEvent, ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApiFetch } from '../auth/useApiFetch';
import {
  addPublishVariant,
  askContent,
  attachContentCampaign,
  createContentSponsorship,
  crosspostContent,
  deleteContent,
  detachContentCampaign,
  getContent,
  getContentAnalytics,
  recordContentStats,
  updateContent,
} from '../api/content';
import type { CrosspostContentResult } from '../api/content';
import { createVoiceSample } from '../api/voice';
import { CROSSPOST_PLATFORMS, crosspostBlog, getCrosspostStatus } from '../api/blogs';
import KeyValueEditor, { type Pair } from '../components/KeyValueEditor';
import type {
  Content,
  ContentAnalyticsResponse,
  ContentAnswer,
  ContentSource,
  ContentStatus,
  ContentType,
  CrosspostPlatform,
  CrosspostStatus,
  UpdateContentParams,
} from '../api/types';
import Markdown from '../components/MarkdownLazy';
import CampaignDetail from './CampaignDetail';

const CONTENT_STATUSES: ContentStatus[] = ['draft', 'scheduled', 'published', 'archived'];
const CONTENT_TYPES: ContentType[] = ['blog', 'social', 'video'];
const CONTENT_SOURCES: ContentSource[] = ['owned', 'sponsored'];

// Splits a comma-separated input into a trimmed, de-empty'd list.
function parseList(raw: string): string[] {
  return raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// Detail view for a single piece of content — the app's central object. Shows
// the rendered body, its metadata, the sponsorship (campaign) hanging off it
// if any, and a per-piece Ask panel. Mirrors BlogDetail so the two catalogs
// feel like one hub as the Blog→Content unification lands.
export default function ContentDetail(): ReactElement {
  const { contentId = '' } = useParams();
  const apiFetch = useApiFetch();
  const navigate = useNavigate();

  const [content, setContent] = useState<Content | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getContent(apiFetch, contentId)
      .then((c) => { if (active) setContent(c); })
      .catch((err) => { if (active) setError((err as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [apiFetch, contentId]);

  if (loading) return <p className="text-muted-foreground">Loading…</p>;
  if (error) return <p className="form-error">Could not load content: {error}</p>;
  if (!content) return <p className="text-muted-foreground">Not found.</p>;

  // A legacy Blog-only row surfaced in the unified catalog has no Content row,
  // so Content-only controls (status, sponsorship) don't apply. Cross-post
  // reads the Blog entity, so it's only offered when a Blog row backs the piece.
  const contentBacked = content.content_backed !== false;
  const blogBacked = Boolean(content.blog_backed);

  // Mutation responses (PATCH, attach/detach) come from formatContent and don't
  // carry the backing flags that only GET /content/:id adds, so preserve them
  // from the current state — a metadata edit never changes what backs a piece.
  const applyContent = (c: Content): void =>
    setContent((prev) => ({
      ...c,
      content_backed: c.content_backed ?? prev?.content_backed,
      blog_backed: c.blog_backed ?? prev?.blog_backed,
    }));

  return (
    <section className="space-y-8">
      {/* The content itself reads best in a narrow column; the embedded
          sponsorship workspace below gets full width for its tables/charts. */}
      <div className="max-w-3xl space-y-6">
        <div>
          <Link to="/content" className="btn-link text-sm">← All content</Link>
        </div>

        {editing ? (
          <EditContentForm
            content={content}
            apiFetch={apiFetch}
            onSaved={(c) => { applyContent(c); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <header className="space-y-2">
              <h1 className="text-2xl font-semibold text-foreground">{content.title}</h1>
              <p className="text-xs text-muted-foreground">
                {content.slug} · created {fmtDate(content.created_at)}
                {content.updated_at && content.updated_at !== content.created_at && ` · updated ${fmtDate(content.updated_at)}`}
              </p>
              {content.description && (
                <p className="text-sm text-muted-foreground">{content.description}</p>
              )}
              <div className="flex flex-wrap items-center gap-1">
                {content.type && (
                  <span className="px-2 py-0.5 rounded-full text-xs bg-primary-100 text-primary-700">{content.type}</span>
                )}
                {content.status && (
                  <span className="px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">{content.status}</span>
                )}
                {content.source && (
                  <span className="px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">{content.source}</span>
                )}
                {content.tags.map((t) => (
                  <span key={t} className="px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">{t}</span>
                ))}
              </div>
              {content.canonical_url && (
                <div className="flex flex-wrap gap-3 text-sm pt-1">
                  <a href={content.canonical_url} target="_blank" rel="noreferrer noopener" className="btn-link">Canonical ↗</a>
                </div>
              )}
            </header>

            <ActionsRow
              content={content}
              apiFetch={apiFetch}
              canEditStatus={contentBacked}
              canEdit={contentBacked}
              onEdit={() => setEditing(true)}
              onChanged={applyContent}
              onDeleted={() => navigate('/content')}
            />

            {content.content_markdown ? (
              <article className="card card-body text-sm">
                <Markdown>{content.content_markdown}</Markdown>
              </article>
            ) : (
              <p className="text-sm text-muted-foreground">This piece has no stored body.</p>
            )}

            {/* Content-backed blog pieces cross-post off the Content row
                (works for content-native pieces too). Legacy Blog-only rows
                keep the durable /blogs crosspost path. */}
            {contentBacked && content.type === 'blog' && (
              <ContentCrosspostPanel contentId={content.content_id} apiFetch={apiFetch} />
            )}
            {!contentBacked && blogBacked && (
              <CrosspostPanel contentId={content.content_id} apiFetch={apiFetch} />
            )}

            {contentBacked && (
              <ContentAnalyticsSection contentId={content.content_id} apiFetch={apiFetch} />
            )}

            <AskPanel contentId={content.content_id} apiFetch={apiFetch} />
          </>
        )}
      </div>

      {/* Sponsorship: attach/create/detach, and — when attached — the full
          campaign workspace hangs off the content piece right here. Hidden for
          legacy Blog-only rows, whose /content mutation routes don't apply. */}
      {contentBacked && (
        <SponsorshipRow content={content} apiFetch={apiFetch} onChanged={applyContent} />
      )}

      {contentBacked && content.campaign_id && (
        <div className="border-t border-border pt-6">
          <CampaignDetail campaignId={content.campaign_id} />
        </div>
      )}
    </section>
  );
}

// Edit a piece of content's metadata and body. Reuses PATCH /content; only
// changed fields are sent, and cleared description/canonical are sent as null.
function EditContentForm({
  content, apiFetch, onSaved, onCancel,
}: {
  content: Content;
  apiFetch: ReturnType<typeof useApiFetch>;
  onSaved: (c: Content) => void;
  onCancel: () => void;
}): ReactElement {
  const [title, setTitle] = useState(content.title);
  const [slug, setSlug] = useState(content.slug);
  const [type, setType] = useState<ContentType>((content.type ?? 'blog') as ContentType);
  const [source, setSource] = useState<ContentSource>((content.source ?? 'owned') as ContentSource);
  const [description, setDescription] = useState(content.description ?? '');
  const [canonicalUrl, setCanonicalUrl] = useState(content.canonical_url ?? '');
  const [tags, setTags] = useState(content.tags.join(', '));
  const [categories, setCategories] = useState(content.categories.join(', '));
  const [publishDate, setPublishDate] = useState(content.publish_date ?? '');
  const [markdown, setMarkdown] = useState(content.content_markdown ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || title.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const params: UpdateContentParams = {
        title: title.trim(),
        slug: slug.trim(),
        type,
        source,
        description: description.trim() ? description.trim() : null,
        canonical_url: canonicalUrl.trim() ? canonicalUrl.trim() : null,
        publish_date: publishDate.trim() ? publishDate.trim() : null,
        tags: parseList(tags),
        categories: parseList(categories),
        ...(markdown.trim() ? { content_markdown: markdown } : {}),
      };
      onSaved(await updateContent(apiFetch, content.content_id, params));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card card-body space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Edit content</h2>
        <button type="button" className="btn-ghost btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Type</span>
          <select className="input" value={type} onChange={(e) => setType(e.target.value as ContentType)} disabled={busy}>
            {CONTENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="field-label">Source</span>
          <select className="input" value={source} onChange={(e) => setSource(e.target.value as ContentSource)} disabled={busy}>
            {CONTENT_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      <label className="block">
        <span className="field-label">Title</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
      </label>
      <label className="block">
        <span className="field-label">Slug</span>
        <input className="input" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="kebab-case" disabled={busy} />
      </label>
      <label className="block">
        <span className="field-label">Description</span>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
      </label>
      <label className="block">
        <span className="field-label">Content (markdown)</span>
        <textarea className="input" rows={10} value={markdown} onChange={(e) => setMarkdown(e.target.value)} disabled={busy} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Tags (comma-separated)</span>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} disabled={busy} />
        </label>
        <label className="block">
          <span className="field-label">Categories (comma-separated)</span>
          <input className="input" value={categories} onChange={(e) => setCategories(e.target.value)} disabled={busy} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Canonical URL</span>
          <input className="input" value={canonicalUrl} onChange={(e) => setCanonicalUrl(e.target.value)} placeholder="https://…" disabled={busy} />
        </label>
        <label className="block">
          <span className="field-label">Publish date</span>
          <input type="date" className="input" value={publishDate} onChange={(e) => setPublishDate(e.target.value)} disabled={busy} />
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <button type="submit" className="btn-primary" disabled={busy || !title.trim()}>
        {busy ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}

// The sponsorship (campaign) that hangs off this piece — 1:1, optional. When
// unsponsored, offers to create a campaign for the piece or attach an existing
// one. When sponsored, links to the campaign and offers to detach it.
function SponsorshipRow({
  content, apiFetch, onChanged,
}: {
  content: Content;
  apiFetch: ReturnType<typeof useApiFetch>;
  onChanged: (c: Content) => void;
}): ReactElement {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'idle' | 'create' | 'attach'>('idle');
  const [name, setName] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => { setMode('idle'); setName(''); setCampaignId(''); setError(null); };

  const doCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || name.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const campaign = await createContentSponsorship(apiFetch, content.content_id, { name: name.trim() });
      navigate(`/campaigns/${campaign.campaign_id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const doAttach = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || campaignId.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      onChanged(await attachContentCampaign(apiFetch, content.content_id, campaignId.trim()));
      reset();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const doDetach = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await detachContentCampaign(apiFetch, content.content_id);
      onChanged({ ...content, campaign_id: null });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-body space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Sponsorship</h2>
          <p className="text-sm text-muted-foreground">
            {content.campaign_id
              ? 'A campaign is attached to this piece.'
              : 'This is an unsponsored creation — no campaign attached.'}
          </p>
        </div>
        {content.campaign_id ? (
          <div className="flex items-center gap-2">
            <Link to={`/campaigns/${content.campaign_id}`} className="btn-secondary btn-sm">View campaign</Link>
            <button type="button" className="btn-ghost btn-sm" onClick={() => void doDetach()} disabled={busy}>
              {busy ? 'Detaching…' : 'Detach'}
            </button>
          </div>
        ) : mode === 'idle' ? (
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary btn-sm" onClick={() => setMode('create')}>Add sponsorship</button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('attach')}>Attach existing</button>
          </div>
        ) : (
          <button type="button" className="btn-ghost btn-sm" onClick={reset} disabled={busy}>Cancel</button>
        )}
      </div>

      {mode === 'create' && !content.campaign_id && (
        <form onSubmit={doCreate} className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <label className="flex-1 min-w-48">
            <span className="field-label">Campaign name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Q3 sponsorship" disabled={busy} />
          </label>
          <button type="submit" className="btn-primary btn-sm" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create & attach'}
          </button>
        </form>
      )}

      {mode === 'attach' && !content.campaign_id && (
        <form onSubmit={doAttach} className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <label className="flex-1 min-w-48">
            <span className="field-label">Existing campaign ID</span>
            <input className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="01H…" disabled={busy} />
          </label>
          <button type="submit" className="btn-primary btn-sm" disabled={busy || !campaignId.trim()}>
            {busy ? 'Attaching…' : 'Attach'}
          </button>
        </form>
      )}

      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

function ActionsRow({
  content, apiFetch, canEditStatus, canEdit, onEdit, onChanged, onDeleted,
}: {
  content: Content;
  apiFetch: ReturnType<typeof useApiFetch>;
  canEditStatus: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onChanged: (c: Content) => void;
  onDeleted: () => void;
}): ReactElement {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [statusBusy, setStatusBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeStatus = async (status: ContentStatus): Promise<void> => {
    if (status === content.status) return;
    setStatusBusy(true);
    setError(null);
    try {
      onChanged(await updateContent(apiFetch, content.content_id, { status }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStatusBusy(false);
    }
  };

  const saveToVoice = async (): Promise<void> => {
    setSaveState('saving');
    setError(null);
    try {
      const text = content.content_markdown
        ? `${content.title}\n\n${content.content_markdown}`
        : content.title;
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
      await deleteContent(apiFetch, content.content_id);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {canEditStatus && (
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            Status
            <select
              className="input w-auto py-1"
              value={content.status ?? 'draft'}
              onChange={(e) => void changeStatus(e.target.value as ContentStatus)}
              disabled={statusBusy}
            >
              {CONTENT_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        )}
        {canEdit && (
          <button type="button" className="btn-secondary btn-sm" onClick={onEdit}>Edit</button>
        )}
        <button type="button" className="btn-secondary btn-sm" onClick={() => void saveToVoice()} disabled={saveState !== 'idle'}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved to voice ✓' : 'Save to voice'}
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

// Cross-post a content-backed piece off the Content row (publishes immediately;
// each success is recorded as a publish variant and shows up in Analytics).
// Works for content-native pieces that have no Blog row.
function ContentCrosspostPanel({ contentId, apiFetch }: { contentId: string; apiFetch: ReturnType<typeof useApiFetch> }): ReactElement {
  const [selected, setSelected] = useState<Set<CrosspostPlatform>>(new Set());
  const [results, setResults] = useState<CrosspostContentResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setResults(null);
    try {
      const res = await crosspostContent(apiFetch, contentId, [...selected]);
      setResults(res.results);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-body space-y-3">
      <h2 className="text-lg font-semibold text-foreground">Cross-post</h2>
      <form onSubmit={submit} className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {CROSSPOST_PLATFORMS.map((p) => (
            <label key={p} className="flex items-center gap-1.5 text-sm capitalize">
              <input type="checkbox" checked={selected.has(p)} onChange={() => toggle(p)} disabled={busy} />
              {p === 'dev' ? 'DEV' : p}
            </label>
          ))}
          <button type="submit" className="btn-secondary btn-sm" disabled={busy || selected.size === 0}>
            {busy ? 'Publishing…' : 'Cross-post now'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Publishes immediately using the platform credentials in Settings. Platforms already
          published are skipped.
        </p>
      </form>

      {error && <p className="form-error">{error}</p>}

      {results && (
        <ul className="space-y-1 text-sm border-t border-border pt-3">
          {results.map((r) => (
            <li key={r.platform} className="flex items-center justify-between gap-3">
              <span className="capitalize text-foreground">{r.platform}</span>
              <span className="text-muted-foreground">
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noreferrer noopener" className="btn-link">{r.status} ↗</a>
                ) : (
                  r.error ? `failed: ${r.error}` : r.status
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Cross-post a blog-type piece to dev.to / Medium / Hashnode. Reuses the
// blog crosspost endpoints (keyed by id; a blog piece's content_id is its
// blog id), folded in here now that the standalone Blogs page is retired.
function CrosspostPanel({ contentId, apiFetch }: { contentId: string; apiFetch: ReturnType<typeof useApiFetch> }): ReactElement {
  const [selected, setSelected] = useState<Set<CrosspostPlatform>>(new Set());
  const [staggerDays, setStaggerDays] = useState('');
  const [status, setStatus] = useState<CrosspostStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await getCrosspostStatus(apiFetch, contentId));
    } catch {
      // No run yet / not found — leave status null.
    }
  }, [apiFetch, contentId]);

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
      await crosspostBlog(apiFetch, contentId, [...selected], days);
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

// Where a piece is published and how it's performing. Reads GET
// /content/:id/analytics; lets the creator record distribution (a publish
// variant) and log per-platform metric snapshots — content-level analytics
// independent of any campaign.
function ContentAnalyticsSection({ contentId, apiFetch }: { contentId: string; apiFetch: ReturnType<typeof useApiFetch> }): ReactElement {
  const [data, setData] = useState<ContentAnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [recording, setRecording] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getContentAnalytics(apiFetch, contentId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [apiFetch, contentId]);

  useEffect(() => { void load(); }, [load]);

  const latest = (platform: string): Record<string, number> | null => {
    const series = data?.stats.find((s) => s.platform === platform)?.snapshots ?? [];
    return series.length ? series[series.length - 1].metrics : null;
  };

  const platforms = data
    ? [...new Set([...data.publish_variants.map((v) => v.platform), ...data.stats.map((s) => s.platform)])].sort()
    : [];

  return (
    <div className="card card-body space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">Analytics</h2>
        <button type="button" className="btn-link text-xs" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Close' : '+ Publish location'}
        </button>
      </div>

      {adding && (
        <AddPublishForm
          apiFetch={apiFetch}
          contentId={contentId}
          onAdded={() => { setAdding(false); void load(); }}
        />
      )}

      {error && <p className="form-error">{error}</p>}

      {data && platforms.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No publish locations yet. Add where this piece went live to start tracking performance.
        </p>
      )}

      {platforms.map((platform) => {
        const variant = data?.publish_variants.find((v) => v.platform === platform);
        const metrics = latest(platform);
        return (
          <div key={platform} className="border-t border-border pt-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <span className="font-medium text-foreground capitalize">{platform}</span>
                {variant?.url && (
                  <a href={variant.url} target="_blank" rel="noreferrer noopener" className="btn-link text-sm ml-2">open ↗</a>
                )}
              </div>
              <button type="button" className="btn-link text-xs" onClick={() => setRecording(recording === platform ? null : platform)}>
                {recording === platform ? 'Close' : 'Record metrics'}
              </button>
            </div>
            {metrics ? (
              <div className="flex flex-wrap gap-3 text-sm">
                {Object.entries(metrics).map(([k, v]) => (
                  <span key={k} className="text-muted-foreground">
                    <span className="font-semibold text-foreground tabular-nums">{v.toLocaleString()}</span> {k}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No metrics recorded yet.</p>
            )}
            {recording === platform && (
              <RecordStatsForm
                apiFetch={apiFetch}
                contentId={contentId}
                platform={platform}
                onRecorded={() => { setRecording(null); void load(); }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function AddPublishForm({
  apiFetch, contentId, onAdded,
}: {
  apiFetch: ReturnType<typeof useApiFetch>;
  contentId: string;
  onAdded: () => void;
}): ReactElement {
  const [platform, setPlatform] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || !platform.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addPublishVariant(apiFetch, contentId, {
        platform: platform.trim(),
        ...(url.trim() ? { url: url.trim() } : {}),
      });
      onAdded();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <label className="flex-1 min-w-32">
        <span className="field-label">Platform</span>
        <input className="input" value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="devto, medium, youtube…" disabled={busy} />
      </label>
      <label className="flex-[2] min-w-48">
        <span className="field-label">URL (optional)</span>
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" disabled={busy} />
      </label>
      <button type="submit" className="btn-primary btn-sm" disabled={busy || !platform.trim()}>
        {busy ? 'Adding…' : 'Add'}
      </button>
      {error && <p className="form-error w-full">{error}</p>}
    </form>
  );
}

function RecordStatsForm({
  apiFetch, contentId, platform, onRecorded,
}: {
  apiFetch: ReturnType<typeof useApiFetch>;
  contentId: string;
  platform: string;
  onRecorded: () => void;
}): ReactElement {
  const [pairs, setPairs] = useState<Pair[]>([{ key: 'views', value: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const metrics: Record<string, number> = {};
      for (const { key, value } of pairs) {
        const k = key.trim();
        if (!k) continue;
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(`"${k}" must be a non-negative number`);
        }
        metrics[k] = n;
      }
      if (Object.keys(metrics).length === 0) {
        throw new Error('Add at least one metric');
      }
      await recordContentStats(apiFetch, contentId, platform, metrics);
      onRecorded();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md bg-muted/50 p-3">
      <KeyValueEditor pairs={pairs} onChange={setPairs} keyPlaceholder="metric (views)" valuePlaceholder="count" />
      {error && <p className="form-error">{error}</p>}
      <button type="button" className="btn-secondary btn-sm" onClick={() => void submit()} disabled={busy}>
        {busy ? 'Recording…' : 'Record today'}
      </button>
    </div>
  );
}

function AskPanel({ contentId, apiFetch }: { contentId: string; apiFetch: ReturnType<typeof useApiFetch> }): ReactElement {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<ContentAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || question.trim().length === 0) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await askContent(apiFetch, { question: question.trim(), contentId }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card card-body space-y-3">
      <h2 className="text-lg font-semibold text-foreground">Ask about this piece</h2>
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
