import type { ReactElement } from 'react';
import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface Props {
  byDay: Record<string, number>;
}

// Fills missing days with 0 between the earliest and latest date so the
// chart's x-axis is continuous instead of jumping from one click day to
// the next.
function densify(byDay: Record<string, number>): { date: string; clicks: number }[] {
  const entries = Object.entries(byDay)
    .map(([date, clicks]) => ({ date, clicks }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (entries.length === 0) return [];
  if (entries.length === 1) return entries;

  const first = new Date(entries[0].date + 'T00:00:00Z');
  const last = new Date(entries[entries.length - 1].date + 'T00:00:00Z');
  const dense: { date: string; clicks: number }[] = [];
  const map = new Map(entries.map((e) => [e.date, e.clicks]));
  for (let d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    dense.push({ date: iso, clicks: map.get(iso) ?? 0 });
  }
  return dense;
}

export default function ClicksChart({ byDay }: Props): ReactElement {
  const data = useMemo(() => densify(byDay), [byDay]);

  if (data.length === 0) {
    return <p className="chart-empty">No click data yet.</p>;
  }

  return (
    <div className="clicks-chart">
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e3e6eb" />
          <XAxis dataKey="date" tick={{ fontSize: 12 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
          <Tooltip />
          <Line type="monotone" dataKey="clicks" stroke="#0b66c2" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
