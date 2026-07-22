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
import { getContentPostSnapshots, getSocialPostSnapshots } from '../api/campaigns';
import type { ContentPost, SocialPost } from '../api/types';
import type { ApiFetch } from '../auth/useApiFetch';
import Tile from './Tile';
import { relativeTime, titleCase, truncate } from '../lib/format';

// One engagement panel for both metric buckets. The buckets stay reportable
// independently (social posts vs cross-posted content), but the UX is
// identical — per-day cumulative or delta chart, platform totals, top-post
// table, staleness flagging — so the bucket only selects the copy and which
// snapshots endpoint is called.

type Bucket = 'social' | 'content';

// Both post types share the fields this panel reads; keep the component
// structural so either bucket's array type-checks.
type EngagementPost = SocialPost | ContentPost;

interface Snapshot {
  snapshot_date: string;
  metrics: Record<string, number>;
}

interface Props {
  apiFetch: ApiFetch;
  campaignId: string;
  posts: EngagementPost[];
  bucket: Bucket;
}

type ChartMode = 'cumulative' | 'delta';

const BUCKET_COPY: Record<Bucket, { title: string; empty: string }> = {
  social: {
    title: 'Social engagement',
    empty:
      'No social posts tracked yet. Add posts from the Promotion tab to chart engagement over time.',
  },
  content: {
    title: 'Content engagement',
    empty:
      'No content posts tracked yet. Add Medium or dev.to posts from the Promotion tab to chart engagement over time.',
  },
};

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

export default function EngagementSection({
  apiFetch,
  campaignId,
  posts,
  bucket,
}: Props): ReactElement {
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ChartMode>('cumulative');
  const copy = BUCKET_COPY[bucket];

  // Refetch whenever the post set changes. Personal-scale: a handful of
  // posts per campaign, so a parallel fan-out is fine. If a per-post call
  // fails we surface a single error and continue with what we got.
  useEffect(() => {
    if (posts.length === 0) {
      setSnapshots({});
      return;
    }
    const fetchSnapshots = bucket === 'social' ? getSocialPostSnapshots : getContentPostSnapshots;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all(
      posts.map((p) =>
        fetchSnapshots(apiFetch, campaignId, p.post_id)
          .then((res) => ({ id: p.post_id, snapshots: res.snapshots as Snapshot[] }))
          .catch((err: Error) => ({ id: p.post_id, snapshots: [] as Snapshot[], err })),
      ),
    ).then((results) => {
      if (cancelled) return;
      const map: Record<string, Snapshot[]> = {};
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
  }, [apiFetch, campaignId, posts, bucket]);

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
        <h2 className="text-lg font-semibold text-foreground">{copy.title}</h2>
        <p className="text-sm text-muted-foreground">{copy.empty}</p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">{copy.title}</h2>
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

interface RankedPost {
  post: EngagementPost;
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
    <div className="overflow-x-auto">
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
    </div>
  );
}

function computeCurrentTotals(posts: EngagementPost[]): {
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
  posts: EngagementPost[],
): { platform: string; total: number; postCount: number }[] {
  const map = new Map<string, { total: number; postCount: number }>();
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

function rankPosts(posts: EngagementPost[]): RankedPost[] {
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

function collectMetricKeys(snapshots: Record<string, Snapshot[]>): string[] {
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
  snapshots: Record<string, Snapshot[]>,
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

  const sortedPerPost: Record<string, Snapshot[]> = {};
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
      let mostRecent: Snapshot | null = null;
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

function latestFetched(posts: EngagementPost[]): Date | null {
  let latest: number | null = null;
  for (const p of posts) {
    if (!p.last_fetched) continue;
    const t = new Date(p.last_fetched).getTime();
    if (latest === null || t > latest) latest = t;
  }
  return latest === null ? null : new Date(latest);
}
