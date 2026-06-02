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
import { getContentPostSnapshots } from '../api/campaigns';
import type {
  ContentPlatform,
  ContentPost,
  ContentPostSnapshot,
} from '../api/types';
import type { ApiFetch } from '../auth/useApiFetch';

// Content-bucket counterpart to SocialEngagementSection. Same chart UX
// (per-day cumulative or delta, top-post table, staleness flagging) but
// reads from /content-posts/{id}/snapshots so the buckets stay reportable
// independently. Helpers are intentionally duplicated rather than shared
// because each bucket may grow bucket-specific metric semantics later.

interface Props {
  apiFetch: ApiFetch;
  campaignId: string;
  posts: ContentPost[];
}

type ChartMode = 'cumulative' | 'delta';

const STALE_AFTER_DAYS = 2;

const SERIES_COLORS = [
  'rgb(var(--primary-600))',
  'rgb(var(--success-600))',
  'rgb(var(--warning-600))',
  'rgb(var(--error-600))',
  'rgb(var(--secondary-600))',
  'rgb(var(--primary-400))',
];

export default function ContentEngagementSection({
  apiFetch,
  campaignId,
  posts,
}: Props): ReactElement {
  const [snapshots, setSnapshots] = useState<Record<string, ContentPostSnapshot[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ChartMode>('cumulative');

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
        getContentPostSnapshots(apiFetch, campaignId, p.post_id)
          .then((res) => ({ id: p.post_id, snapshots: res.snapshots }))
          .catch((err: Error) => ({ id: p.post_id, snapshots: [], err })),
      ),
    ).then((results) => {
      if (cancelled) return;
      const map: Record<string, ContentPostSnapshot[]> = {};
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
        <h2 className="text-lg font-semibold text-foreground">Content engagement</h2>
        <p className="text-sm text-muted-foreground">
          No content posts tracked yet. Add Medium or dev.to posts from the Promotion tab
          to chart engagement over time.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">Content engagement</h2>
      {error && <p className="form-error">{error}</p>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="Total engagement" value={totals.total.toLocaleString()} />
        <Tile label="Posts tracked" value={String(posts.length)} />
        <Tile
          label="Needs refresh"
          value={String(totals.staleCount)}
          tone={totals.staleCount > 0 ? 'warning' : 'default'}
          sublabel={
            totals.staleCount > 0 ? `Not captured in ${STALE_AFTER_DAYS}+ days` : 'All up to date'
          }
          hint={`Posts the Booked extension hasn't captured in over ${STALE_AFTER_DAYS} days. Open them, or hit the refresh icon (with the extension installed) to pull fresh numbers.`}
          slot="needs-refresh"
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
          No engagement history yet. The extension writes a snapshot each time it
          captures a post.
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
  hint,
  slot,
}: {
  label: string;
  value: string;
  sublabel?: string;
  tone?: 'default' | 'warning';
  hint?: string;
  slot?: string;
}): ReactElement {
  const toneClass = tone === 'warning' ? 'text-warning-700' : 'text-foreground';
  return (
    <div className={`card card-body !py-3${slot ? ' relative' : ''}`}>
      {slot && (
        <span
          data-booked-slot={slot}
          className="absolute top-2 right-2 flex items-center"
        />
      )}
      <span
        className={`text-xs uppercase tracking-wide text-muted-foreground${
          hint ? ' cursor-help' : ''
        }`}
        title={hint}
      >
        {label}
      </span>
      <span className={`text-2xl font-semibold ${toneClass} mt-1 block`}>{value}</span>
      {sublabel && (
        <span className="text-xs text-muted-foreground mt-0.5 block truncate">{sublabel}</span>
      )}
    </div>
  );
}

interface RankedPost {
  post: ContentPost;
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

function computeCurrentTotals(posts: ContentPost[]): {
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
  posts: ContentPost[],
): { platform: ContentPlatform; total: number; postCount: number }[] {
  const map = new Map<ContentPlatform, { total: number; postCount: number }>();
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

function rankPosts(posts: ContentPost[]): RankedPost[] {
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
  snapshots: Record<string, ContentPostSnapshot[]>,
): string[] {
  const set = new Set<string>();
  for (const list of Object.values(snapshots)) {
    for (const snap of list) {
      for (const key of Object.keys(snap.metrics)) set.add(key);
    }
  }
  return Array.from(set).sort();
}

function buildDailySeries(
  snapshots: Record<string, ContentPostSnapshot[]>,
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

  const sortedPerPost: Record<string, ContentPostSnapshot[]> = {};
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
      let mostRecent: ContentPostSnapshot | null = null;
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

function latestFetched(posts: ContentPost[]): Date | null {
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
