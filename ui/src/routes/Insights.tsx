import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useApiFetch } from '../auth/useApiFetch';
import { getInsights } from '../api/insights';
import type {
  InsightsResponse,
  InsightsTimeseriesPoint,
  InsightsTopPost,
} from '../api/types';

const intFmt = new Intl.NumberFormat('en-US');

function fmtInt(n: number | null | undefined): string {
  return typeof n === 'number' && isFinite(n) ? intFmt.format(n) : '—';
}

function fmtPercent(rate: number | null | undefined): string {
  if (typeof rate !== 'number' || !isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

// Signed percentage for period-over-period deltas. Null renders as a neutral
// dash (no prior period to compare against).
function fmtDelta(pct: number | null): { text: string; cls: string } {
  if (pct === null || !isFinite(pct)) return { text: '—', cls: 'text-muted-foreground' };
  const sign = pct > 0 ? '+' : '';
  const cls = pct > 0 ? 'text-success-700' : pct < 0 ? 'text-error-600' : 'text-muted-foreground';
  return { text: `${sign}${(pct * 100).toFixed(0)}%`, cls };
}

type Metric = 'engagements' | 'views' | 'impressions';
type Mode = 'cumulative' | 'daily';

const RANGES: { label: string; days: number }[] = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '6m', days: 182 },
  { label: '1y', days: 365 },
];

const METRICS: { key: Metric; label: string }[] = [
  { key: 'engagements', label: 'Engagements' },
  { key: 'views', label: 'Views' },
  { key: 'impressions', label: 'Impressions' },
];

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

// Converts the cumulative-level series into daily deltas (new activity per
// day). The first point's delta is unknowable from the window alone, so it
// stays 0; clamped at 0 so a re-counted drop never shows negative.
function toDaily(series: InsightsTimeseriesPoint[], metric: Metric): { date: string; value: number }[] {
  return series.map((pt, i) => {
    if (i === 0) return { date: pt.date, value: 0 };
    return { date: pt.date, value: Math.max(0, pt[metric] - series[i - 1][metric]) };
  });
}

export default function Insights(): ReactElement {
  const apiFetch = useApiFetch();

  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [rangeDays, setRangeDays] = useState(90);
  const [metric, setMetric] = useState<Metric>('engagements');
  const [mode, setMode] = useState<Mode>('cumulative');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getInsights(apiFetch, {
        startDate: isoDaysAgo(rangeDays),
        endDate: new Date().toISOString().slice(0, 10),
      });
      setData(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, rangeDays]);

  useEffect(() => {
    void load();
  }, [load]);

  const chartData = useMemo(() => {
    if (!data) return [];
    if (mode === 'daily') return toDaily(data.timeseries, metric);
    return data.timeseries.map((pt) => ({ date: pt.date, value: pt[metric] }));
  }, [data, metric, mode]);

  const hasAnyData = (data?.totals.postsTracked ?? 0) > 0;

  return (
    <section className="space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Trends &amp; insights</h1>
          <p className="text-sm text-muted-foreground">
            Engagement across all your tracked content over time, with your top performers.
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              onClick={() => setRangeDays(r.days)}
              aria-pressed={rangeDays === r.days}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                rangeDays === r.days
                  ? 'bg-primary-100 text-primary-700'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {error && <p className="form-error">Could not load insights: {error}</p>}

      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !hasAnyData ? (
        <div className="card card-body text-center text-muted-foreground py-10">
          <p className="text-foreground font-medium">No tracked content yet</p>
          <p className="text-sm mt-1">
            Register social or content posts on a campaign and capture their engagement with the
            Booked extension. Trends appear here once there's data.
          </p>
        </div>
      ) : (
        <>
          {data && <StatRow data={data} />}

          <div className="card card-body space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex gap-1" role="group" aria-label="Metric">
                {METRICS.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setMetric(m.key)}
                    aria-pressed={metric === m.key}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      metric === m.key
                        ? 'bg-primary-100 text-primary-700'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-1" role="group" aria-label="Series mode">
                <ModeButton label="Cumulative" active={mode === 'cumulative'} onClick={() => setMode('cumulative')} />
                <ModeButton label="Per day" active={mode === 'daily'} onClick={() => setMode('daily')} />
              </div>
            </div>

            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 12, fill: 'rgb(var(--muted-foreground))' }} />
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
                <Line
                  type="monotone"
                  dataKey="value"
                  name={mode === 'daily' ? `${metric}/day` : metric}
                  stroke="rgb(var(--primary-600))"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
            <p className="text-xs text-muted-foreground">
              {mode === 'cumulative'
                ? 'Cumulative totals across your tracked content. Flat stretches mean no new capture in that span — engagement only updates when the extension reads a post.'
                : 'New activity per day, derived from the cumulative series. Irregular capture can bunch several days into one.'}
            </p>
          </div>

          {data && data.topPosts.length > 0 && <TopPosts posts={data.topPosts} />}
        </>
      )}
    </section>
  );
}

function ModeButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
        active ? 'bg-primary-100 text-primary-700' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      {label}
    </button>
  );
}

function StatRow({ data }: { data: InsightsResponse }): ReactElement {
  const { totals, deltas } = data;
  const cards: { label: string; value: string; pct: number | null }[] = [
    { label: 'Engagements', value: fmtInt(totals.engagements), pct: deltas.changePct.engagements },
    { label: 'Views', value: fmtInt(totals.views), pct: deltas.changePct.views },
    { label: 'Impressions', value: fmtInt(totals.impressions), pct: deltas.changePct.impressions },
    { label: 'Engagement rate', value: fmtPercent(totals.engagementRate), pct: null },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {cards.map((c) => {
        const delta = fmtDelta(c.pct);
        return (
          <div key={c.label} className="card card-body">
            <p className="text-sm text-muted-foreground">{c.label}</p>
            <p className="text-2xl font-semibold text-foreground tabular-nums">{c.value}</p>
            {c.pct !== null && (
              <p className={`text-xs mt-1 ${delta.cls}`}>{delta.text} vs. prior period</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TopPosts({ posts }: { posts: InsightsTopPost[] }): ReactElement {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">Top performing content</h2>
      <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Post</th>
            <th>Platform</th>
            <th>Campaign</th>
            <th className="text-right">Engagements</th>
            <th className="text-right">Reach</th>
            <th>Last captured</th>
          </tr>
        </thead>
        <tbody>
          {posts.map((p, i) => (
            <tr key={`${p.campaignId}-${p.url ?? i}`}>
              <td className="max-w-[20rem] truncate">
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noreferrer noopener" className="btn-link">
                    {p.url}
                  </a>
                ) : (
                  '—'
                )}
              </td>
              <td className="capitalize">{p.platform ?? '—'}</td>
              <td className="text-muted-foreground">{p.campaignName ?? '—'}</td>
              <td className="text-right tabular-nums">{fmtInt(p.engagements)}</td>
              <td className="text-right tabular-nums">{fmtInt(p.views + p.impressions)}</td>
              <td className="text-muted-foreground">{p.lastCaptured ?? 'never'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
