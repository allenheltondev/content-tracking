import type { FormEvent, ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApiFetch } from '../auth/useApiFetch';
import {
  askContent,
  attachContentCampaign,
  createContentSponsorship,
  deleteContent,
  detachContentCampaign,
  getContent,
  updateContent,
} from '../api/content';
import { createVoiceSample } from '../api/voice';
import type { Content, ContentAnswer, ContentStatus } from '../api/types';
import Markdown from '../components/MarkdownLazy';

const CONTENT_STATUSES: ContentStatus[] = ['draft', 'scheduled', 'published', 'archived'];

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

  return (
    <section className="space-y-6 max-w-3xl">
      <div>
        <Link to="/content" className="btn-link text-sm">← All content</Link>
      </div>

      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">{content.title}</h1>
        <p className="text-xs text-muted-foreground">
          {content.slug} · created {fmtDate(content.created_at)}
          {content.updated_at && content.updated_at !== content.created_at && ` · updated ${fmtDate(content.updated_at)}`}
        </p>
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
        </div>
        <div className="flex flex-wrap gap-3 text-sm pt-1">
          {content.canonical_url && (
            <a href={content.canonical_url} target="_blank" rel="noreferrer noopener" className="btn-link">Canonical ↗</a>
          )}
          {content.campaign_id && (
            <Link to={`/campaigns/${content.campaign_id}`} className="btn-link">Sponsorship ↗</Link>
          )}
        </div>
      </header>

      <SponsorshipRow content={content} apiFetch={apiFetch} onChanged={setContent} />

      <ActionsRow
        content={content}
        apiFetch={apiFetch}
        onChanged={setContent}
        onDeleted={() => navigate('/content')}
      />

      {content.content_markdown ? (
        <article className="card card-body text-sm">
          <Markdown>{content.content_markdown}</Markdown>
        </article>
      ) : (
        <p className="text-sm text-muted-foreground">This piece has no stored body.</p>
      )}

      <AskPanel contentId={content.content_id} apiFetch={apiFetch} />
    </section>
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
  content, apiFetch, onChanged, onDeleted,
}: {
  content: Content;
  apiFetch: ReturnType<typeof useApiFetch>;
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
