import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import {
  generateMediaKit,
  listMediaKits,
  getPublishState,
  publishMediaKit,
  unpublishMediaKit,
} from '../api/mediaKit';
import type { MediaKitListItem, MediaKitPublishState, MediaKitStats } from '../api/types';

const intFmt = new Intl.NumberFormat('en-US');

function fmtCompact(n: number | null | undefined): string {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(Math.round((n / 1e6) * 10) / 10).toString()}M`;
  if (abs >= 1e3) return `${(Math.round((n / 1e3) * 10) / 10).toString()}K`;
  return intFmt.format(n);
}

function fmtPercent(rate: number | null | undefined): string {
  if (typeof rate !== 'number' || !isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

export default function MediaKit(): ReactElement {
  const apiFetch = useApiFetch();

  const [kits, setKits] = useState<MediaKitListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [latest, setLatest] = useState<{ url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [publishState, setPublishState] = useState<MediaKitPublishState | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    setLoading(true);
    try {
      const [list, pub] = await Promise.all([listMediaKits(apiFetch), getPublishState(apiFetch)]);
      setKits(list.media_kits);
      setPublishState(pub);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async (): Promise<void> => {
    setGenError(null);
    setGenerating(true);
    setCopied(false);
    try {
      const res = await generateMediaKit(apiFetch);
      setLatest({ url: res.url });
      await load();
    } catch (err) {
      setGenError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  // Share the signed CloudFront URL directly. The minted shortlink wraps it
  // via a newsletter-service redirect that mangles the signed query string, so
  // the short link 403s — the long URL is the one that actually works.
  const shareUrl = latest?.url ?? '';
  const copy = (): void => {
    if (!shareUrl) return;
    void navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const stats = kits[0]?.stats ?? null;

  return (
    <section className="space-y-6 max-w-4xl">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Media kit</h1>
          <p className="text-sm text-muted-foreground">
            A one-pager for brands, built from your{' '}
            <Link to="/profile" className="text-primary-700 hover:underline">
              profile
            </Link>{' '}
            and live campaign performance. Generate a private link to send a specific brand, or
            publish a public page for your bio.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => void generate()} disabled={generating}>
          {generating ? 'Generating…' : 'Generate media kit'}
        </button>
      </header>

      {genError && <p className="form-error">{genError}</p>}

      {latest && (
        <div className="card card-body space-y-3">
          <h2 className="text-lg font-semibold text-foreground">Your shareable link</h2>
          <p className="text-sm text-muted-foreground">
            Anyone with this link can view your media kit — no sign-in required.
          </p>
          <div className="flex items-center gap-2">
            <input type="text" readOnly value={shareUrl} className="input flex-1 font-mono text-xs" />
            <button type="button" className="btn btn-secondary shrink-0" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <a
              href={latest.url}
              target="_blank"
              rel="noreferrer noopener"
              className="btn btn-secondary shrink-0"
            >
              Open
            </a>
          </div>
        </div>
      )}

      <PublicKitPanel state={publishState} onChange={setPublishState} />

      {stats && <StatsOverview stats={stats} />}

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">History</h2>
        {loadError && <p className="form-error">Could not load media kits: {loadError}</p>}
        {loading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : kits.length === 0 ? (
          <p className="text-muted-foreground">
            No media kits yet. Generate one to get a shareable link.
          </p>
        ) : (
          <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Generated</th>
                <th>Followers</th>
                <th>Reach</th>
                <th>Engagement</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {kits.map((kit) => (
                <tr key={kit.reportId}>
                  <td className="text-muted-foreground">
                    {new Date(kit.generatedAt).toLocaleDateString()}
                  </td>
                  <td>{fmtCompact(kit.stats?.totalFollowers)}</td>
                  <td>{fmtCompact(kit.stats?.totalReach)}</td>
                  <td>{fmtPercent(kit.stats?.engagementRate)}</td>
                  <td className="text-muted-foreground">{kit.expiresAt.slice(0, 10)}</td>
                  <td className="text-right">
                    <a
                      href={kit.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="btn-link"
                    >
                      Open
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </section>
  );
}

// The public, brand-facing teaser published to a stable vanity URL — the
// inbound front door. Distinct from the private signed link above: this is
// permanent, indexable, and intentionally omits your rate card.
function PublicKitPanel({
  state,
  onChange,
}: {
  state: MediaKitPublishState | null;
  onChange: (s: MediaKitPublishState) => void;
}): ReactElement | null {
  const apiFetch = useApiFetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Still loading the initial publish state.
  if (!state) return null;

  const hasSlug = Boolean(state.slug);
  const url = state.url ?? '';

  const publish = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      onChange(await publishMediaKit(apiFetch));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await unpublishMediaKit(apiFetch);
      onChange({ ...state, published: false, url: null, published_at: null });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = (): void => {
    if (!url) return;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="card card-body space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-semibold text-foreground">Public page</h2>
        {state.published ? (
          <span className="status-pill status-active">Published</span>
        ) : (
          <span className="status-pill status-draft">Not published</span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        A permanent, search-engine–indexable page for your link-in-bio. It shows your highlights and
        a contact button, but <span className="font-medium text-foreground">hides your rate card</span> —
        keep pricing for the private link above, which you send to specific brands.
      </p>

      {!hasSlug ? (
        <p className="text-sm text-muted-foreground">
          Set a{' '}
          <Link to="/profile" className="text-primary-700 hover:underline">
            public media-kit URL
          </Link>{' '}
          in your profile first, then publish here.
        </p>
      ) : (
        <>
          {state.published && url && (
            <div className="flex items-center gap-2">
              <input type="text" readOnly value={url} className="input flex-1 font-mono text-xs" />
              <button type="button" className="btn btn-secondary shrink-0" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <a href={url} target="_blank" rel="noreferrer noopener" className="btn btn-secondary shrink-0">
                Open
              </a>
            </div>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary" onClick={() => void publish()} disabled={busy}>
              {busy ? 'Working…' : state.published ? 'Republish (refresh data)' : 'Publish'}
            </button>
            {state.published && (
              <button type="button" className="btn btn-secondary" onClick={() => void unpublish()} disabled={busy}>
                Unpublish
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatsOverview({ stats }: { stats: MediaKitStats }): ReactElement {
  const cards: { label: string; value: string }[] = [
    { label: 'Total followers', value: fmtCompact(stats.totalFollowers) },
    { label: 'Total reach', value: fmtCompact(stats.totalReach) },
    { label: 'Engagement rate', value: fmtPercent(stats.engagementRate) },
    { label: 'Campaigns delivered', value: intFmt.format(stats.campaignsCompleted) },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="card card-body">
          <p className="text-sm text-muted-foreground">{c.label}</p>
          <p className="text-2xl font-semibold text-foreground tabular-nums">{c.value}</p>
        </div>
      ))}
    </div>
  );
}
