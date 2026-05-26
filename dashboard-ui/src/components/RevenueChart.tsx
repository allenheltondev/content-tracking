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
    return (
      <p className="rounded-md bg-muted text-muted-foreground text-sm text-center py-6">
        No revenue recorded for {year}.
      </p>
    );
  }

  return (
    <div className="card card-body">
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ top: 16, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border))" />
          <XAxis dataKey="month" tick={{ fontSize: 12, fill: 'rgb(var(--muted-foreground))' }} />
          <YAxis
            tick={{ fontSize: 12, fill: 'rgb(var(--muted-foreground))' }}
            tickFormatter={(v: number) => abbreviate(v)}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'rgb(var(--surface))',
              border: '1px solid rgb(var(--border))',
              borderRadius: 8,
              fontSize: 12,
            }}
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
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line
            type="monotone"
            dataKey="booked"
            stroke="rgb(var(--primary-600))"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="received"
            stroke="rgb(var(--success-600))"
            strokeWidth={2}
            dot={false}
          />
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
