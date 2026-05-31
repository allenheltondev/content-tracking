import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import { generateMediaKit, listMediaKits } from '../api/mediaKit';
import type { MediaKitListItem, MediaKitStats } from '../api/types';

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
  const [latest, setLatest] = useState<{ url: string; shortUrl: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    setLoading(true);
    try {
      const res = await listMediaKits(apiFetch);
      setKits(res.media_kits);
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
      setLatest({ url: res.url, shortUrl: res.shortUrl ?? null });
      await load();
    } catch (err) {
      setGenError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const shareUrl = latest?.shortUrl ?? latest?.url ?? '';
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
            A shareable one-pager for brands, built from your{' '}
            <Link to="/settings" className="text-primary-700 hover:underline">
              profile
            </Link>{' '}
            and live campaign performance.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => void generate()} disabled={generating}>
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
            <button type="button" className="btn-secondary shrink-0" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <a
              href={latest.url}
              target="_blank"
              rel="noreferrer noopener"
              className="btn-secondary shrink-0"
            >
              Open
            </a>
          </div>
        </div>
      )}

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
        )}
      </div>
    </section>
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
