import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useApiFetch } from '../auth/useApiFetch';
import { VOICE_PLATFORMS, platformLabel } from '../api/voice';
import {
  addFeedSource,
  deleteFeedSource,
  generateContentIdeas,
  listFeedSources,
  updateFeedSource,
} from '../api/contentRadar';
import type {
  ContentAngle,
  ContentIdeas,
  FeedItem,
  FeedSource,
} from '../api/types';

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

// Content Radar: curate a set of RSS/Atom feeds, then hit "Inspire me" to get
// content angles written in your voice and backed by the real articles driving
// them. The feed itself is read live server-side; nothing here is stored.
export default function ContentRadar(): ReactElement {
  const apiFetch = useApiFetch();
  const [feeds, setFeeds] = useState<FeedSource[]>([]);
  const [feedsLoading, setFeedsLoading] = useState(true);
  const [feedsError, setFeedsError] = useState<string | null>(null);

  const [platform, setPlatform] = useState<string>('');
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState(false);
  const [ideasError, setIdeasError] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<ContentIdeas | null>(null);

  const loadFeeds = useCallback(async () => {
    setFeedsLoading(true);
    setFeedsError(null);
    try {
      setFeeds(await listFeedSources(apiFetch));
    } catch (err) {
      setFeedsError((err as Error).message);
    } finally {
      setFeedsLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { void loadFeeds(); }, [loadFeeds]);

  const activeCount = feeds.filter((f) => !f.muted).length;

  const inspire = async (): Promise<void> => {
    setBusy(true);
    setIdeasError(null);
    try {
      const res = await generateContentIdeas(apiFetch, {
        ...(platform ? { platform } : {}),
        ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
      });
      setIdeas(res);
      // Health is stamped server-side during generation — refresh so any newly
      // broken feed surfaces in the manager below.
      void loadFeeds();
    } catch (err) {
      setIdeasError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6 max-w-3xl">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">Content Radar</h1>
        <p className="text-sm text-muted-foreground">
          Follow the feeds you care about, then let the radar surface content angles in your voice —
          each one backed by the real articles it's drawn from.
        </p>
      </header>

      {/* The star of the page: generate angles from the live feed. */}
      <div className="card card-body space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <label className="text-sm">
            <span className="field-label">For platform (optional)</span>
            <select
              className="input"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              disabled={busy}
            >
              <option value="">Any / all</option>
              {VOICE_PLATFORMS.map((p) => (
                <option key={p} value={p}>{platformLabel(p)}</option>
              ))}
            </select>
          </label>
          <label className="text-sm flex-1 min-w-0">
            <span className="field-label">Steer it (optional)</span>
            <input
              className="input"
              placeholder="e.g. contrarian takes, beginner-friendly, tie back to serverless"
              value={guidance}
              maxLength={1000}
              onChange={(e) => setGuidance(e.target.value)}
              disabled={busy}
            />
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="btn-primary"
            onClick={() => void inspire()}
            disabled={busy || activeCount === 0}
          >
            {busy ? 'Finding your angles…' : '✨ Inspire me'}
          </button>
          {activeCount === 0 && !feedsLoading && (
            <span className="text-xs text-muted-foreground">Add a feed below to get started.</span>
          )}
          {activeCount > 0 && (
            <span className="text-xs text-muted-foreground">
              Reading {activeCount} {activeCount === 1 ? 'feed' : 'feeds'}
            </span>
          )}
        </div>

        {ideasError && <p className="form-error">{ideasError}</p>}
      </div>

      {busy && !ideas && (
        <p className="text-muted-foreground">Scanning your feeds and matching them to your voice…</p>
      )}

      {ideas && <IdeasView ideas={ideas} />}

      <FeedManager
        feeds={feeds}
        loading={feedsLoading}
        error={feedsError}
        onChanged={loadFeeds}
      />
    </section>
  );
}

const MOMENTUM_STYLE: Record<string, string> = {
  surging: 'bg-success-100 text-success-800',
  steady: 'bg-primary-100 text-primary-800',
  emerging: 'bg-warning-100 text-warning-800',
  fading: 'bg-secondary-100 text-secondary-700',
};

// The generated ideas: a read on what's trending, the themes with momentum,
// and the angles — each backed by the real feed items it cites.
function IdeasView({ ideas }: { ideas: ContentIdeas }): ReactElement {
  if (ideas.angles.length === 0) {
    return (
      <div className="card card-body text-center text-muted-foreground py-8">
        <p className="text-foreground font-medium">No angles this time</p>
        <p className="text-sm mt-1">{ideas.summary ?? 'The feeds were quiet — try again once there’s fresh material.'}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {ideas.summary && (
        <div className="card card-body">
          <p className="text-sm text-foreground">{ideas.summary}</p>
          {ideas.themes.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {ideas.themes.map((t) => (
                <span
                  key={t.theme}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs ${
                    t.momentum ? MOMENTUM_STYLE[t.momentum] ?? 'bg-muted text-foreground' : 'bg-muted text-foreground'
                  }`}
                  title={t.why_it_fits ?? undefined}
                >
                  {t.theme}
                  {t.momentum && <span className="opacity-70">· {t.momentum}</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <ol className="space-y-3">
        {ideas.angles.map((angle, i) => (
          <AngleCard key={`${angle.title}-${i}`} angle={angle} items={ideas.items} />
        ))}
      </ol>

      <FailedSources ideas={ideas} />
    </div>
  );
}

// One content angle, with the real resources backing it. `angle.sources` are
// 1-indexed into `items`, so each citation resolves to the actual article.
function AngleCard({ angle, items }: { angle: ContentAngle; items: FeedItem[] }): ReactElement {
  const backing = angle.sources
    .map((n) => items[n - 1])
    .filter((it): it is FeedItem => Boolean(it));

  return (
    <li className="card card-body space-y-2">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold text-foreground">{angle.title}</h3>
        {angle.format && (
          <span className="shrink-0 inline-flex items-center rounded-full bg-primary-50 text-primary-700 px-2.5 py-0.5 text-xs">
            {angle.format}
          </span>
        )}
      </div>

      <p className="text-sm text-foreground">{angle.angle}</p>

      {angle.rationale && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Why now:</span> {angle.rationale}
        </p>
      )}
      {angle.on_voice_note && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Keep it you:</span> {angle.on_voice_note}
        </p>
      )}

      <div className="border-t border-border pt-2">
        {backing.length > 0 ? (
          <>
            <span className="field-label">Backed by</span>
            <ul className="space-y-1">
              {backing.map((it, idx) => (
                <li key={`${it.link ?? it.title ?? idx}`} className="text-sm">
                  {it.link ? (
                    <a
                      href={it.link}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-link"
                    >
                      {it.title ?? it.link}
                    </a>
                  ) : (
                    <span className="text-foreground">{it.title ?? '(untitled)'}</span>
                  )}
                  {it.feed_title && (
                    <span className="text-muted-foreground"> — {it.feed_title}</span>
                  )}
                  {it.published_at && (
                    <span className="text-muted-foreground"> · {fmtDate(it.published_at)}</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-xs text-muted-foreground italic">
            A fresh connection — not tied to a single story in your feeds.
          </p>
        )}
      </div>
    </li>
  );
}

// Surfaces feeds that failed during this generation, so a broken source doesn't
// silently narrow the ideas.
function FailedSources({ ideas }: { ideas: ContentIdeas }): ReactElement | null {
  const failed = ideas.sources.filter((s) => !s.ok);
  if (failed.length === 0) return null;
  return (
    <p className="text-xs text-warning-700">
      Couldn’t read {failed.length} {failed.length === 1 ? 'feed' : 'feeds'} this time
      {failed.some((f) => f.error) ? ` (${failed.find((f) => f.error)?.error})` : ''}. Check them below.
    </p>
  );
}

// Manage the feed sources: add, rename, mute, remove — with per-source health.
function FeedManager({
  feeds,
  loading,
  error,
  onChanged,
}: {
  feeds: FeedSource[];
  loading: boolean;
  error: string | null;
  onChanged: () => Promise<void>;
}): ReactElement {
  const apiFetch = useApiFetch();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const add = async (): Promise<void> => {
    setAdding(true);
    setAddError(null);
    try {
      await addFeedSource(apiFetch, url.trim(), title.trim() || undefined);
      setUrl('');
      setTitle('');
      await onChanged();
    } catch (err) {
      setAddError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const toggleMute = async (feed: FeedSource): Promise<void> => {
    setBusyId(feed.feed_id);
    try {
      await updateFeedSource(apiFetch, feed.feed_id, { muted: !feed.muted });
      await onChanged();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (feedId: string): Promise<void> => {
    setBusyId(feedId);
    try {
      await deleteFeedSource(apiFetch, feedId);
      await onChanged();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card card-body space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Your feeds</h2>
        <p className="text-sm text-muted-foreground">
          RSS or Atom feeds the radar reads. Mute one to keep it out of your recommendations without losing it.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
        <label className="text-sm flex-1 min-w-0">
          <span className="field-label">Feed URL</span>
          <input
            className="input"
            placeholder="https://blog.example.com/rss.xml"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={adding}
          />
        </label>
        <label className="text-sm sm:w-40">
          <span className="field-label">Label (optional)</span>
          <input
            className="input"
            placeholder="Example Blog"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            disabled={adding}
          />
        </label>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void add()}
          disabled={adding || url.trim().length === 0}
        >
          {adding ? 'Adding…' : 'Add feed'}
        </button>
      </div>
      {addError && <p className="form-error">{addError}</p>}
      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : feeds.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No feeds yet. Add a blog, newsletter, or news RSS feed to start your radar.
        </p>
      ) : (
        <ul className="space-y-2">
          {feeds.map((feed) => (
            <li
              key={feed.feed_id}
              className={`flex items-start justify-between gap-3 rounded-md p-2 ${feed.muted ? 'bg-muted/30 opacity-60' : 'bg-muted/60'}`}
            >
              <div className="min-w-0">
                <p className="text-sm text-foreground truncate">
                  {feed.title ?? feed.url}
                </p>
                <p className="text-xs text-muted-foreground truncate">{feed.url}</p>
                <FeedHealth feed={feed} />
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => void toggleMute(feed)}
                  disabled={busyId === feed.feed_id}
                >
                  {busyId === feed.feed_id ? '…' : feed.muted ? 'Unmute' : 'Mute'}
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-sm text-error-600"
                  onClick={() => void remove(feed.feed_id)}
                  disabled={busyId === feed.feed_id}
                  aria-label="Remove feed"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FeedHealth({ feed }: { feed: FeedSource }): ReactElement | null {
  if (!feed.last_status) return null;
  if (feed.last_status === 'ok') {
    return (
      <p className="text-xs text-success-700 mt-0.5">
        ✓ {feed.last_item_count ?? 0} items · checked {fmtDate(feed.last_fetched_at)}
      </p>
    );
  }
  return (
    <p className="text-xs text-error-600 mt-0.5">
      ✕ {feed.last_error ?? 'could not be read'} · checked {fmtDate(feed.last_fetched_at)}
    </p>
  );
}
