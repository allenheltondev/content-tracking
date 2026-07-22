import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { Line, LineChart, ResponsiveContainer } from 'recharts';
import type { Campaign, CampaignAnalyticsResponse, WebAnalyticsResponse } from '../../api/types';
import { formatDateRange } from '../../lib/format';

// Overview-tab executive summary: headline tiles, payout/timeline
// digests, and the clicks sparkline.

export function ExecutiveSummary({
  campaign,
  analytics,
  webAnalytics,
}: {
  campaign: Campaign;
  analytics: CampaignAnalyticsResponse | null;
  webAnalytics: WebAnalyticsResponse | null;
}): ReactElement {
  const timeline = computeTimeline(campaign);
  const totalClicks = analytics?.total_clicks ?? null;
  const clicksByDay = analytics?.by_day ?? null;

  // The third tile reflects the campaign's main deliverable: blog pageviews
  // (GA4) or video views (YouTube).
  const isYoutube = (campaign.deliverable_type ?? 'blog') === 'youtube';
  let viewsLabel: string;
  let viewsValue: number | null;
  let viewsSub: string;
  if (isYoutube) {
    viewsLabel = 'Views';
    viewsValue = webAnalytics?.youtube?.totals?.views ?? null;
    if (!campaign.youtube_url) viewsSub = 'No video URL';
    else if (!(webAnalytics?.youtube?.configured ?? false)) viewsSub = 'YouTube not connected';
    else viewsSub = 'YouTube';
  } else {
    viewsLabel = 'Pageviews';
    viewsValue = webAnalytics?.ga4?.totals?.pageviews ?? null;
    if (!campaign.blog_url) viewsSub = 'No blog URL';
    else if (!(webAnalytics?.ga4?.configured ?? false)) viewsSub = 'GA4 not connected';
    else viewsSub = 'GA4';
  }

  return (
    <section
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"
      aria-label="Campaign summary"
    >
      <SummaryTile label="Timeline" value={timeline.primary} sublabel={timeline.secondary} />
      <SummaryTile
        label="Clicks"
        value={totalClicks !== null ? totalClicks.toLocaleString() : '—'}
        sublabel={
          totalClicks === null
            ? 'Loading…'
            : `${analytics?.link_count ?? 0} link${analytics?.link_count === 1 ? '' : 's'}`
        }
        sparkline={clicksByDay && totalClicks ? <Sparkline byDay={clicksByDay} /> : null}
      />
      <SummaryTile
        label={viewsLabel}
        value={viewsValue !== null ? viewsValue.toLocaleString() : '—'}
        sublabel={viewsSub}
      />
      <SummaryTile
        label="Payout"
        value={formatPayoutShort(campaign.payout)}
        sublabel={campaign.payout ? null : 'No payout set'}
        pill={
          campaign.payout ? (
            <span
              className={`status-pill ${
                campaign.payout.paid
                  ? 'bg-success-100 text-success-800'
                  : 'bg-warning-100 text-warning-800'
              }`}
            >
              {campaign.payout.paid ? 'Paid' : 'Unpaid'}
            </span>
          ) : null
        }
      />
    </section>
  );
}

function SummaryTile({
  label,
  value,
  sublabel,
  pill,
  sparkline,
}: {
  label: string;
  value: string;
  sublabel?: string | null;
  pill?: ReactElement | null;
  sparkline?: ReactElement | null;
}): ReactElement {
  return (
    <div className="card card-body !px-4 !py-3 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
          {label}
        </span>
        {pill}
      </div>
      <div className="flex items-end justify-between gap-3">
        <span className="text-2xl font-semibold text-foreground leading-none">{value}</span>
        {sparkline && <div className="w-24 h-8 shrink-0">{sparkline}</div>}
      </div>
      {sublabel && <span className="text-xs text-muted-foreground truncate">{sublabel}</span>}
    </div>
  );
}

function Sparkline({ byDay }: { byDay: Record<string, number> }): ReactElement | null {
  const data = useMemo(() => {
    const entries = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) return [];
    if (entries.length === 1) return entries.map(([date, clicks]) => ({ date, clicks }));
    const first = new Date(entries[0][0] + 'T00:00:00Z');
    const last = new Date(entries[entries.length - 1][0] + 'T00:00:00Z');
    const map = new Map(entries);
    const dense: { date: string; clicks: number }[] = [];
    for (let d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      dense.push({ date: iso, clicks: map.get(iso) ?? 0 });
    }
    return dense;
  }, [byDay]);

  if (data.length < 2) return null;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <Line
          type="monotone"
          dataKey="clicks"
          stroke="rgb(var(--primary-600))"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function computeTimeline(campaign: Campaign): { primary: string; secondary: string | null } {
  const { startDate, endDate, status } = campaign;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = startDate ? new Date(startDate + 'T00:00:00') : null;
  const end = endDate ? new Date(endDate + 'T00:00:00') : null;
  const range = formatDateRange(startDate, endDate);
  const dayMs = 86_400_000;

  if (status === 'completed') {
    return { primary: 'Completed', secondary: range !== '-' ? range : null };
  }

  if (start && end) {
    if (today < start) {
      const days = Math.ceil((start.getTime() - today.getTime()) / dayMs);
      return { primary: `Starts in ${days}d`, secondary: range };
    }
    if (today > end) {
      const days = Math.ceil((today.getTime() - end.getTime()) / dayMs);
      return { primary: `Ended ${days}d ago`, secondary: range };
    }
    const days = Math.ceil((end.getTime() - today.getTime()) / dayMs);
    return { primary: `${days}d left`, secondary: range };
  }

  if (start) {
    if (today < start) {
      const days = Math.ceil((start.getTime() - today.getTime()) / dayMs);
      return { primary: `Starts in ${days}d`, secondary: `From ${startDate}` };
    }
    const days = Math.ceil((today.getTime() - start.getTime()) / dayMs) + 1;
    return { primary: `Day ${days}`, secondary: `From ${startDate}` };
  }

  if (end) {
    if (today > end) {
      const days = Math.ceil((today.getTime() - end.getTime()) / dayMs);
      return { primary: `Ended ${days}d ago`, secondary: `Until ${endDate}` };
    }
    const days = Math.ceil((end.getTime() - today.getTime()) / dayMs);
    return { primary: `${days}d left`, secondary: `Until ${endDate}` };
  }

  return { primary: 'Not scheduled', secondary: null };
}

function formatPayoutShort(payout: Campaign['payout']): string {
  if (!payout) return '—';
  const amount = payout.amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return `${amount} ${payout.currency}`;
}
