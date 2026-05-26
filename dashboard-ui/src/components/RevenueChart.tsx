import type { ReactElement } from 'react';
import { useMemo } from 'react';
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
import type { RevenueGroup } from '../api/types';

interface Props {
  year: number;
  monthGroups: RevenueGroup[];
  currency: string;
}

// Fills the full year with zero-amount months so the x-axis stays
// continuous even for sparse data, and so the legend always renders
// both series.
function buildSeries(year: number, groups: RevenueGroup[]): {
  month: string;
  booked: number;
  received: number;
  campaignCount: number;
}[] {
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const out: { month: string; booked: number; received: number; campaignCount: number }[] = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, '0')}`;
    const group = byKey.get(key);
    out.push({
      month: key,
      booked: group?.bookedAmount ?? 0,
      received: group?.receivedAmount ?? 0,
      campaignCount: group?.campaignCount ?? 0,
    });
  }
  return out;
}

export default function RevenueChart({ year, monthGroups, currency }: Props): ReactElement {
  const data = useMemo(() => buildSeries(year, monthGroups), [year, monthGroups]);

  const hasAnyData = data.some((d) => d.booked > 0 || d.received > 0);
  if (!hasAnyData) {
    return <p className="chart-empty">No revenue recorded for {year}.</p>;
  }

  // Recharts' default tooltip is fine; we just supply a value formatter
  // that respects the locale-aware currency string. Custom-component
  // tooltips fight with recharts' generic types; the formatter approach
  // gets us locale formatting without that cost.
  return (
    <div className="clicks-chart">
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ top: 16, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e3e6eb" />
          <XAxis dataKey="month" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} tickFormatter={(v: number) => abbreviate(v)} />
          <Tooltip
            formatter={(value, name) => [
              formatMoney(typeof value === 'number' ? value : Number(value) || 0, currency),
              String(name ?? ''),
            ]}
            labelFormatter={(label) => {
              const labelStr = typeof label === 'string' ? label : String(label ?? '');
              const row = data.find((d) => d.month === labelStr);
              const count = row?.campaignCount ?? 0;
              return `${labelStr} — ${count} campaign${count === 1 ? '' : 's'}`;
            }}
          />
          <Legend />
          <Line type="monotone" dataKey="booked" stroke="#0b66c2" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="received" stroke="#1a5524" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function abbreviate(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return String(v);
}
