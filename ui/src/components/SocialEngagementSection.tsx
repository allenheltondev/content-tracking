import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getSocialPostSnapshots } from '../api/campaigns';
import type {
  SocialPost,
  SocialPostSnapshot,
  SocialPlatform,
} from '../api/types';
import type { ApiFetch } from '../auth/useApiFetch';

interface Props {
  apiFetch: ApiFetch;
  campaignId: string;
  posts: SocialPost[];
}

type ChartMode = 'cumulative' | 'delta';

// Posts whose last_fetched is older than this are flagged stale so the user
// knows the extension hasn't recently captured them.
const STALE_AFTER_DAYS = 2;

// Recharts cycles through these for metric lines. Resolved at render time
// via CSS variables so they track the active theme.
const SERIES_COLORS = [
  'rgb(var(--primary-600))',
  'rgb(var(--success-600))',
  'rgb(var(--warning-600))',
  'rgb(var(--error-600))',
  'rgb(var(--secondary-600))',
  'rgb(var(--primary-400))',
];

export default function SocialEngagementSection({
  apiFetch,
  campaignId,
  posts,
}: Props): ReactElement {
  const [snapshots, setSnapshots] = useState<Record<string, SocialPostSnapshot[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ChartMode>('cumulative');

  // Refetch whenever the post set changes. Personal-scale: a handful of
  // posts per campaign, so a parallel fan-out is fine. If a per-post call
  // fails we surface a single error and continue with what we got.
  useEffect(() => {
    if (posts.length === 0) {
      setSnapshots({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all(
      posts.map((p) =>
        getSocialPostSnapshots(apiFetch, campaignId, p.post_id)
          .then((res) => ({ id: p.post_id, snapshots: res.snapshots }))
          .catch((err: Error) => ({ id: p.post_id, snapshots: [], err })),
      ),
    ).then((results) => {
      if (cancelled) return;
      const map: Record<string, SocialPostSnapshot[]> = {};
      const failed: string[] = [];
      for (const r of results) {
        map[r.id] = r.snapshots;
        if ('err' in r && r.err) failed.push(r.id);
      }
      setSnapshots(map);
      if (failed.length > 0) {
        setError(`Couldn't load engagement history for ${failed.length} post(s).`);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, campaignId, posts]);

  const totals = useMemo(() => computeCurrentTotals(posts), [posts]);
  const platformTotals = useMemo(() => computePlatformTotals(posts), [posts]);
  const topPosts = useMemo(() => rankPosts(posts), [posts]);
  const chartData = useMemo(
    () => buildDailySeries(snapshots, mode),
    [snapshots, mode],
  );
  const metricKeys = useMemo(() => collectMetricKeys(snapshots), [snapshots]);
  const lastFetched = useMemo(() => latestFetched(posts), [posts]);

  if (posts.length === 0) {
    return (
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Social engagement</h2>
        <p className="text-sm text-muted-foreground">
          No social posts tracked yet. Add posts from the Promotion tab to chart
          engagement over time.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">Social engagement</h2>
      {error && <p className="form-error">{error}</p>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="Total engagement" value={totals.total.toLocaleString()} />
        <Tile label="Posts tracked" value={String(posts.length)} />
        <Tile
          label="Stale captures"
          value={String(totals.staleCount)}
          tone={totals.staleCount > 0 ? 'warning' : 'default'}
          sublabel={totals.staleCount > 0 ? `>${STALE_AFTER_DAYS}d since refresh` : 'All fresh'}
        />
        <Tile
          label="Last refresh"
          value={lastFetched ? relativeTime(lastFetched) : '—'}
          sublabel={lastFetched ? lastFetched.toLocaleString() : 'Never'}
        />
      </div>

      {platformTotals.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {platformTotals.map(({ platform, total, postCount }) => (
            <Tile
              key={platform}
              label={titleCase(platform)}
              value={total.toLocaleString()}
              sublabel={`${postCount} post${postCount === 1 ? '' : 's'}`}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 mt-2">
        <h3 className="text-sm font-medium text-foreground">Engagement per day</h3>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      {loading && Object.keys(snapshots).length === 0 ? (
        <p className="rounded-md bg-muted text-muted-foreground text-sm text-center py-6">
          Loading engagement history...
        </p>
      ) : chartData.length === 0 ? (
        <p className="rounded-md bg-muted text-muted-foreground text-sm text-center py-6">
          No engagement history yet. The extension writes a snapshot each time
          it captures a post.
        </p>
      ) : (
        <div className="card card-body">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border))" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 12, fill: 'rgb(var(--muted-foreground))' }}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 12, fill: 'rgb(var(--muted-foreground))' }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'rgb(var(--surface))',
                  border: '1px solid rgb(var(--border))',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {metricKeys.map((key, i) => (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <h3 className="text-sm font-medium text-foreground mt-2">Top posts</h3>
      <TopPostsTable posts={topPosts} />
    </section>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: ChartMode;
  onChange: (m: ChartMode) => void;
}): ReactElement {
  const buttons: { value: ChartMode; label: string }[] = [
    { value: 'cumulative', label: 'Cumulative' },
    { value: 'delta', label: 'Daily change' },
  ];
  return (
    <div
      role="tablist"
      aria-label="Engagement chart mode"
      className="inline-flex rounded-md border border-border overflow-hidden text-xs"
    >
      {buttons.map((b) => (
        <button
          key={b.value}
          type="button"
          role="tab"
          aria-selected={mode === b.value}
          onClick={() => onChange(b.value)}
          className={`px-3 py-1 transition-colors ${
            mode === b.value
              ? 'bg-primary-600 text-white'
              : 'bg-surface text-muted-foreground hover:text-foreground'
          }`}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

function Tile({
  label,
  value,
  sublabel,
  tone = 'default',
}: {
  label: string;
  value: string;
  sublabel?: string;
  tone?: 'default' | 'warning';
}): ReactElement {
  const toneClass =
    tone === 'warning' ? 'text-warning-700' : 'text-foreground';
  return (
    <div className="card card-body !py-3">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-2xl font-semibold ${toneClass} mt-1 block`}>{value}</span>
      {sublabel && (
        <span className="text-xs text-muted-foreground mt-0.5 block truncate">{sublabel}</span>
      )}
    </div>
  );
}

interface RankedPost {
  post: SocialPost;
  total: number;
  topMetric: string | null;
  topMetricValue: number;
  stale: boolean;
}

function TopPostsTable({ posts }: { posts: RankedPost[] }): ReactElement {
  if (posts.length === 0) {
    return (
      <p className="rounded-md bg-muted text-muted-foreground text-sm text-center py-4">
        No engagement captured yet.
      </p>
    );
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Platform</th>
          <th>Post</th>
          <th>Total engagement</th>
          <th>Top metric</th>
          <th>Last fetched</th>
        </tr>
      </thead>
      <tbody>
        {posts.map(({ post, total, topMetric, topMetricValue, stale }) => (
          <tr key={post.post_id}>
            <td>{post.platform}</td>
            <td>
              <a
                href={post.url}
                target="_blank"
                rel="noreferrer"
                className="text-primary-600 hover:underline"
              >
                {truncate(post.url, 50)}
              </a>
            </td>
            <td className="text-foreground font-medium">{total.toLocaleString()}</td>
            <td className="text-muted-foreground">
              {topMetric ? `${topMetric}: ${topMetricValue.toLocaleString()}` : '—'}
            </td>
            <td className="text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                {post.last_fetched ? new Date(post.last_fetched).toLocaleString() : 'never'}
                {stale && (
                  <span className="status-pill bg-warning-100 text-warning-800">stale</span>
                )}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function computeCurrentTotals(posts: SocialPost[]): {
  total: number;
  staleCount: number;
} {
  let total = 0;
  let staleCount = 0;
  const cutoff = Date.now() - STALE_AFTER_DAYS * 86_400_000;
  for (const p of posts) {
    if (p.analytics) {
      for (const v of Object.values(p.analytics)) total += v;
    }
    if (p.last_fetched && new Date(p.last_fetched).getTime() < cutoff) staleCount++;
  }
  return { total, staleCount };
}

function computePlatformTotals(
  posts: SocialPost[],
): { platform: SocialPlatform; total: number; postCount: number }[] {
  const map = new Map<SocialPlatform, { total: number; postCount: number }>();
  for (const p of posts) {
    const entry = map.get(p.platform) ?? { total: 0, postCount: 0 };
    entry.postCount++;
    if (p.analytics) {
      for (const v of Object.values(p.analytics)) entry.total += v;
    }
    map.set(p.platform, entry);
  }
  return Array.from(map.entries())
    .map(([platform, v]) => ({ platform, ...v }))
    .sort((a, b) => b.total - a.total);
}

function rankPosts(posts: SocialPost[]): RankedPost[] {
  const cutoff = Date.now() - STALE_AFTER_DAYS * 86_400_000;
  return posts
    .map((post): RankedPost => {
      let total = 0;
      let topMetric: string | null = null;
      let topMetricValue = 0;
      if (post.analytics) {
        for (const [k, v] of Object.entries(post.analytics)) {
          total += v;
          if (v > topMetricValue) {
            topMetric = k;
            topMetricValue = v;
          }
        }
      }
      const stale =
        post.last_fetched !== null && new Date(post.last_fetched).getTime() < cutoff;
      return { post, total, topMetric, topMetricValue, stale };
    })
    .sort((a, b) => b.total - a.total);
}

function collectMetricKeys(
  snapshots: Record<string, SocialPostSnapshot[]>,
): string[] {
  const set = new Set<string>();
  for (const list of Object.values(snapshots)) {
    for (const snap of list) {
      for (const key of Object.keys(snap.metrics)) set.add(key);
    }
  }
  return Array.from(set).sort();
}

// Builds the rechart-ready series. For each calendar day between the first
// and last snapshot we sum every post's most-recent-on-or-before metric
// values; days without any captured-yet posts are filled with zero so the
// x-axis is continuous. In "delta" mode we then subtract the previous
// day's value per metric to surface daily change (clamped at 0 to avoid
// negative dips when a metric is later removed by the platform).
function buildDailySeries(
  snapshots: Record<string, SocialPostSnapshot[]>,
  mode: ChartMode,
): Record<string, number | string>[] {
  const postIds = Object.keys(snapshots).filter((id) => snapshots[id].length > 0);
  if (postIds.length === 0) return [];

  let minDate: string | null = null;
  let maxDate: string | null = null;
  for (const id of postIds) {
    for (const s of snapshots[id]) {
      if (!minDate || s.snapshot_date < minDate) minDate = s.snapshot_date;
      if (!maxDate || s.snapshot_date > maxDate) maxDate = s.snapshot_date;
    }
  }
  if (!minDate || !maxDate) return [];

  const sortedPerPost: Record<string, SocialPostSnapshot[]> = {};
  for (const id of postIds) {
    sortedPerPost[id] = [...snapshots[id]].sort((a, b) =>
      a.snapshot_date.localeCompare(b.snapshot_date),
    );
  }

  const allKeys = collectMetricKeys(snapshots);
  const days = enumerateDays(minDate, maxDate);

  const cumulative = days.map((day) => {
    const row: Record<string, number | string> = { date: day };
    for (const key of allKeys) row[key] = 0;
    for (const id of postIds) {
      const list = sortedPerPost[id];
      let mostRecent: SocialPostSnapshot | null = null;
      for (const s of list) {
        if (s.snapshot_date <= day) mostRecent = s;
        else break;
      }
      if (!mostRecent) continue;
      for (const key of allKeys) {
        row[key] = (row[key] as number) + (mostRecent.metrics[key] ?? 0);
      }
    }
    return row;
  });

  if (mode === 'cumulative') return cumulative;

  return cumulative.map((row, i) => {
    const out: Record<string, number | string> = { date: row.date };
    const prev = cumulative[i - 1];
    for (const key of allKeys) {
      const curr = (row[key] as number) ?? 0;
      const before = prev ? (prev[key] as number) ?? 0 : 0;
      out[key] = Math.max(0, curr - before);
    }
    return out;
  });
}

function enumerateDays(start: string, end: string): string[] {
  const days: string[] = [];
  const startDate = new Date(start + 'T00:00:00Z');
  const endDate = new Date(end + 'T00:00:00Z');
  for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function latestFetched(posts: SocialPost[]): Date | null {
  let latest: number | null = null;
  for (const p of posts) {
    if (!p.last_fetched) continue;
    const t = new Date(p.last_fetched).getTime();
    if (latest === null || t > latest) latest = t;
  }
  return latest === null ? null : new Date(latest);
}

function relativeTime(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function titleCase(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
