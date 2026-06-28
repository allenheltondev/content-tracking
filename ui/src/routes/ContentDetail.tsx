import type { FormEvent, ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApiFetch } from '../auth/useApiFetch';
import { askContent, deleteContent, getContent, updateContent } from '../api/content';
import { createVoiceSample } from '../api/voice';
import type {
  Content,
  ContentAnswer,
  ContentSource,
  ContentStatus,
  ContentType,
  UpdateContentParams,
  VoiceFormat,
} from '../api/types';
import Markdown from '../components/MarkdownLazy';
import Modal from '../components/Modal';
import TagsInput from '../components/TagsInput';

const CONTENT_TYPES: ContentType[] = ['blog', 'social', 'video'];
const CONTENT_SOURCES: ContentSource[] = ['owned', 'sponsored'];
const CONTENT_STATUSES: ContentStatus[] = ['draft', 'scheduled', 'published', 'archived'];

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// Content "blog" maps to the long-form blog voice; everything else is social.
function voiceTarget(type: ContentType | null): { platform: string; format: VoiceFormat } {
  return type === 'blog' ? { platform: 'blog', format: 'blog' } : { platform: 'x', format: 'social' };
}

export default function ContentDetail(): ReactElement {
  const { contentId = '' } = useParams();
  const apiFetch = useApiFetch();
  const navigate = useNavigate();

  const [content, setContent] = useState<Content | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setContent(await getContent(apiFetch, contentId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, contentId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <p className="text-muted-foreground">Loading…</p>;
  if (error) return <p className="form-error">Could not load content: {error}</p>;
  if (!content) return <p className="text-muted-foreground">Not found.</p>;

  return (
    <section className="space-y-6 max-w-3xl">
      <div>
        <Link to="/content" className="btn-link text-sm">← All content</Link>
      </div>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">{content.title}</h1>
        <p className="text-xs text-muted-foreground">
          {content.slug} · created {fmtDate(content.created_at)}
          {content.updated_at && content.updated_at !== content.created_at && ` · updated ${fmtDate(content.updated_at)}`}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {content.type && (
            <span className="px-2 py-0.5 rounded-full text-xs bg-primary-100 text-primary-700">{content.type}</span>
          )}
          {content.status && (
            <span className="px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">{content.status}</span>
          )}
          {content.source && (
            <span className="px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">{content.source}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-3 text-sm pt-1">
          {content.canonical_url && (
            <a href={content.canonical_url} target="_blank" rel="noreferrer noopener" className="btn-link">Canonical ↗</a>
          )}
          {content.campaign_id && (
            <Link to={`/campaigns/${content.campaign_id}`} className="btn-link">Linked campaign</Link>
          )}
        </div>
      </header>

      <ActionsRow
        content={content}
        apiFetch={apiFetch}
        editing={editing}
        onEdit={() => setEditing(true)}
        onDeleted={() => navigate('/content')}
      />

      {editing ? (
        <EditForm
          content={content}
          apiFetch={apiFetch}
          onCancel={() => setEditing(false)}
          onSaved={(updated) => { setContent(updated); setEditing(false); }}
        />
      ) : (
        <>
          {content.description && (
            <p className="text-sm text-muted-foreground">{content.description}</p>
          )}

          {(content.tags.length > 0 || content.categories.length > 0) && (
            <div className="space-y-2">
              {content.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {content.tags.map((t) => (
                    <span key={t} className="px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">{t}</span>
                  ))}
                </div>
              )}
              {content.categories.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {content.categories.map((c) => (
                    <span key={c} className="px-2 py-0.5 rounded-full text-xs border border-border text-muted-foreground">{c}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {content.content_markdown ? (
            <article className="card card-body text-sm">
              <Markdown>{content.content_markdown}</Markdown>
            </article>
          ) : (
            <p className="text-sm text-muted-foreground">This content has no stored body.</p>
          )}

          <CrosspostPanel />
          <AskPanel contentId={content.content_id} apiFetch={apiFetch} />
        </>
      )}
    </section>
  );
}

function ActionsRow({
  content, apiFetch, editing, onEdit, onDeleted,
}: {
  content: Content;
  apiFetch: ReturnType<typeof useApiFetch>;
  editing: boolean;
  onEdit: () => void;
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
      const text = content.content_markdown ? `${content.title}\n\n${content.content_markdown}` : content.title;
      const { platform, format } = voiceTarget(content.type);
      await createVoiceSample(apiFetch, { text, platform, format, source: 'manual' });
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

  const voiceLabel = content.type === 'blog' ? 'Save to blog voice' : 'Save to voice';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary btn-sm" onClick={onEdit} disabled={editing}>
          Edit
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => void saveToVoice()} disabled={saveState !== 'idle'}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved to voice ✓' : voiceLabel}
        </button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirming(true)} disabled={deleting}>
          Delete
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}

      <Modal open={confirming} title="Delete content" onClose={() => { if (!deleting) setConfirming(false); }}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Delete “{content.title}”? This removes the content and its embeddings. This can't be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirming(false)} disabled={deleting}>
              Cancel
            </button>
            <button type="button" className="btn-destructive btn-sm" onClick={() => void doDelete()} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Confirm delete'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// Native edit form. PATCHes only the fields that changed; clearable optional
// fields (description, canonical_url, tags, categories, campaign_id) send an
// explicit null to clear when emptied.
function EditForm({
  content, apiFetch, onCancel, onSaved,
}: {
  content: Content;
  apiFetch: ReturnType<typeof useApiFetch>;
  onCancel: () => void;
  onSaved: (updated: Content) => void;
}): ReactElement {
  const [type, setType] = useState<ContentType>(content.type ?? 'blog');
  const [source, setSource] = useState<ContentSource>(content.source ?? 'owned');
  const [status, setStatus] = useState<ContentStatus>(content.status ?? 'draft');
  const [title, setTitle] = useState(content.title);
  const [slug, setSlug] = useState(content.slug);
  const [description, setDescription] = useState(content.description ?? '');
  const [markdown, setMarkdown] = useState(content.content_markdown ?? '');
  const [tags, setTags] = useState<string[]>(content.tags);
  const [categories, setCategories] = useState<string[]>(content.categories);
  const [canonicalUrl, setCanonicalUrl] = useState(content.canonical_url ?? '');
  const [campaignId, setCampaignId] = useState(content.campaign_id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A clearable field: emit the new value when present, null when cleared,
  // or undefined (omit) when unchanged from the loaded content.
  const clearable = (
    next: string,
    original: string | null,
  ): string | null | undefined => {
    const trimmed = next.trim();
    if (trimmed === (original ?? '')) return undefined;
    return trimmed.length > 0 ? trimmed : null;
  };

  const clearableList = (
    next: string[],
    original: string[],
  ): string[] | null | undefined => {
    if (next.length === original.length && next.every((t, i) => t === original[i])) return undefined;
    return next.length > 0 ? next : null;
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || title.trim().length === 0 || slug.trim().length === 0 || markdown.trim().length === 0) return;
    setBusy(true);
    setError(null);

    const params: UpdateContentParams = {};
    if (type !== content.type) params.type = type;
    if (source !== content.source) params.source = source;
    if (status !== content.status) params.status = status;
    if (title.trim() !== content.title) params.title = title.trim();
    if (slug.trim() !== content.slug) params.slug = slug.trim();
    if (markdown !== (content.content_markdown ?? '')) params.content_markdown = markdown;

    const desc = clearable(description, content.description);
    if (desc !== undefined) params.description = desc;
    const canon = clearable(canonicalUrl, content.canonical_url);
    if (canon !== undefined) params.canonical_url = canon;
    const camp = clearable(campaignId, content.campaign_id);
    if (camp !== undefined) params.campaign_id = camp;
    const tagsOut = clearableList(tags, content.tags);
    if (tagsOut !== undefined) params.tags = tagsOut;
    const catsOut = clearableList(categories, content.categories);
    if (catsOut !== undefined) params.categories = catsOut;

    if (Object.keys(params).length === 0) {
      setBusy(false);
      onCancel();
      return;
    }

    try {
      const updated = await updateContent(apiFetch, content.content_id, params);
      onSaved(updated);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card card-body space-y-3">
      <h2 className="text-lg font-semibold text-foreground">Edit content</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="field-label">Type</span>
          <select className="input" value={type} onChange={(e) => setType(e.target.value as ContentType)} disabled={busy}>
            {CONTENT_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">Source</span>
          <select className="input" value={source} onChange={(e) => setSource(e.target.value as ContentSource)} disabled={busy}>
            {CONTENT_SOURCES.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">Status</span>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as ContentStatus)} disabled={busy}>
            {CONTENT_STATUSES.map((s) => (<option key={s} value={s}>{s}</option>))}
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
        <span className="field-label">Description (optional — empty clears it)</span>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
      </label>
      <label className="block">
        <span className="field-label">Content (markdown)</span>
        <textarea className="input" rows={10} value={markdown} onChange={(e) => setMarkdown(e.target.value)} disabled={busy} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="block">
          <span className="field-label">Tags (optional — empty clears them)</span>
          <TagsInput tags={tags} onChange={setTags} placeholder="react, typescript" disabled={busy} />
        </div>
        <div className="block">
          <span className="field-label">Categories (optional — empty clears them)</span>
          <TagsInput tags={categories} onChange={setCategories} placeholder="engineering" disabled={busy} />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Canonical URL (optional — empty clears it)</span>
          <input className="input" value={canonicalUrl} onChange={(e) => setCanonicalUrl(e.target.value)} placeholder="https://…" disabled={busy} />
        </label>
        <label className="block">
          <span className="field-label">Campaign ID (optional — empty clears it)</span>
          <input className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} disabled={busy} />
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" className="btn-primary" disabled={busy || !title.trim() || !slug.trim() || !markdown.trim()}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

// Cross-post is not yet available for the unified Content entity — the backend
// /content crosspost endpoints don't exist (only /blogs has them). Rendered in
// a disabled state so it's discoverable without making false API calls. See
// PR 2.3 for the backend work to wire this up.
function CrosspostPanel(): ReactElement {
  return (
    <div className="card card-body space-y-2 opacity-70">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">Cross-post</h2>
        <span className="px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">Coming soon</span>
      </div>
      <p className="text-sm text-muted-foreground">
        Cross-posting to DEV, Medium, and Hashnode isn't available for unified content yet. It's
        coming in a follow-up once the content publish endpoints land.
      </p>
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
      <h2 className="text-lg font-semibold text-foreground">Ask about this content</h2>
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
        <div className="border-t border-border pt-3 text-sm space-y-2">
          <Markdown>{answer.answer}</Markdown>
          <p className="text-xs text-muted-foreground">Confidence: {answer.confidence}</p>
        </div>
      )}
    </form>
  );
}
