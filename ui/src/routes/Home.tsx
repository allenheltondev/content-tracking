import type { ReactElement, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApiFetch } from '../auth/useApiFetch';
import { listCampaigns } from '../api/campaigns';
import { listVendors } from '../api/vendors';
import { getRevenue } from '../api/revenue';
import { listContent } from '../api/content';
import type { Campaign, ContentSummary, RevenueResponse, Vendor } from '../api/types';
import RevenueChart from '../components/RevenueChart';

const CURRENT_YEAR = new Date().getUTCFullYear();

interface DashboardData {
  content: ContentSummary[];
  campaigns: Campaign[];
  vendorMap: Map<string, Vendor>;
  thisYear: RevenueResponse;
  lastYear: RevenueResponse | null;
}

export default function Home(): ReactElement {
  const apiFetch = useApiFetch();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData(null);

    Promise.all([
      // Content leads the dashboard; the rest enriches the sponsorship view.
      listContent(apiFetch, {}).catch(() => ({ content: [] as ContentSummary[], nextStartKey: null })),
      listCampaigns(apiFetch, { limit: 200 }),
      getRevenue(apiFetch, { year: CURRENT_YEAR, grouping: 'month' }),
      // Best-effort: names enrich the lists, last year only drives a delta.
      listVendors(apiFetch, { limit: 500 }).catch(() => ({ vendors: [] as Vendor[] })),
      getRevenue(apiFetch, { year: CURRENT_YEAR - 1 }).catch(() => null),
    ])
      .then(([contentRes, campaignsRes, thisYear, vendorsRes, lastYear]) => {
        if (cancelled) return;
        setData({
          content: contentRes.content,
          campaigns: campaignsRes.campaigns,
          vendorMap: new Map(vendorsRes.vendors.map((v) => [v.vendor_id, v])),
          thisYear,
          lastYear,
        });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  const partnerName = useMemo(() => {
    return (c: Campaign): string => {
      if (c.vendor_id) {
        const v = data?.vendorMap.get(c.vendor_id);
        if (v) return v.name;
      }
      return c.sponsor ?? 'Unknown partner';
    };
  }, [data]);

  const deadlines = useMemo(() => {
    if (!data) return [];
    return data.campaigns
      .filter((c) => c.status !== 'completed' && c.endDate)
      .map((c) => ({ campaign: c, days: daysUntil(c.endDate as string) }))
      .sort((a, b) => a.days - b.days)
      .slice(0, 6);
  }, [data]);

  const recentGigs = useMemo(() => {
    if (!data) return [];
    return data.campaigns
      .map((c) => ({ campaign: c, when: gigDate(c) }))
      .sort((a, b) => b.when.localeCompare(a.when))
      .slice(0, 6);
  }, [data]);

  const activeCount = useMemo(
    () => data?.campaigns.filter((c) => c.status === 'active').length ?? 0,
    [data],
  );

  const recentContent = useMemo(() => {
    if (!data) return [];
    return [...data.content]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 6);
  }, [data]);

  if (error) {
    return (
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold text-foreground">Dashboard</h1>
        <p className="form-error">Could not load your dashboard: {error}</p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="space-y-6">
        <h1 className="text-3xl font-semibold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground">Loading...</p>
      </section>
    );
  }

  const { thisYear, lastYear } = data;
  const currency = thisYear.currency;
  const outstanding = thisYear.booked.amount - thisYear.received.amount;
  const bookedDelta =
    lastYear && lastYear.booked.amount > 0
      ? ((thisYear.booked.amount - lastYear.booked.amount) / lastYear.booked.amount) * 100
      : null;

  const noData =
    data.content.length === 0 &&
    data.campaigns.length === 0 &&
    thisYear.total.amount === 0 &&
    (!lastYear || lastYear.total.amount === 0);

  if (noData) {
    return (
      <section className="space-y-6">
        <DashboardHeader />
        <div className="card card-body text-center py-16 space-y-4">
          <p className="text-muted-foreground">
            No content yet. Create your first piece — then attach a sponsorship if a brand
            comes along.
          </p>
          <Link to="/content" className="btn btn-primary inline-flex w-auto mx-auto">
            Create your first piece
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-8">
      <DashboardHeader />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label={`Booked in ${CURRENT_YEAR}`}
          value={formatMoney(thisYear.booked.amount, currency)}
          sub={
            bookedDelta !== null ? (
              <DeltaBadge pct={bookedDelta} />
            ) : (
              <span className="text-muted-foreground">
                {thisYear.booked.campaignCount} campaign
                {thisYear.booked.campaignCount === 1 ? '' : 's'}
              </span>
            )
          }
        />
        <StatCard
          label={`Received in ${CURRENT_YEAR}`}
          value={formatMoney(thisYear.received.amount, currency)}
          sub={
            <span className="text-muted-foreground">
              {thisYear.booked.amount > 0
                ? `${Math.round((thisYear.received.amount / thisYear.booked.amount) * 100)}% of booked`
                : 'Paid to date'}
            </span>
          }
        />
        <StatCard
          label="Outstanding"
          value={formatMoney(outstanding, currency)}
          accent={outstanding > 0 ? 'warning' : 'success'}
          sub={
            <span className="text-muted-foreground">
              {outstanding > 0 ? 'Awaiting payment' : 'All caught up'}
            </span>
          }
        />
        <StatCard
          label="Active campaigns"
          value={String(activeCount)}
          sub={
            <Link to="/campaigns" className="text-primary-600 hover:underline">
              View all
            </Link>
          }
        />
      </div>

      <PanelCard
        title="Recent content"
        action={<Link to="/content" className="btn-link">All content</Link>}
      >
        {recentContent.length === 0 ? (
          <EmptyRow message="No content yet. Create your first piece to get started." />
        ) : (
          <ul className="divide-y divide-border">
            {recentContent.map((c) => (
              <li key={c.content_id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      to={`/content/${c.content_id}`}
                      className="text-sm font-medium text-foreground hover:text-primary-600 hover:underline truncate block"
                    >
                      {c.title}
                    </Link>
                    <p className="text-xs text-muted-foreground truncate">
                      {[c.type, c.status].filter(Boolean).join(' · ')} · {formatShortDate(c.created_at)}
                    </p>
                  </div>
                  <span
                    className={`status-pill shrink-0 ${
                      c.campaign_id
                        ? 'bg-primary-100 text-primary-700'
                        : 'bg-secondary-100 text-secondary-700'
                    }`}
                  >
                    {c.campaign_id ? 'Sponsored' : 'Owned'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PanelCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <PanelCard
          title="Upcoming deadlines"
          action={<Link to="/campaigns" className="btn-link">All campaigns</Link>}
        >
          {deadlines.length === 0 ? (
            <EmptyRow message="No open deadlines. Nice and clear." />
          ) : (
            <ul className="divide-y divide-border">
              {deadlines.map(({ campaign, days }) => {
                const meta = deadlineMeta(days);
                return (
                  <li key={campaign.campaign_id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          to={`/campaigns/${campaign.campaign_id}`}
                          className="text-sm font-medium text-foreground hover:text-primary-600 hover:underline truncate block"
                        >
                          {campaign.name}
                        </Link>
                        <p className="text-xs text-muted-foreground truncate">
                          {partnerName(campaign)} · due {formatShortDate(campaign.endDate as string)}
                        </p>
                      </div>
                      <span className={`status-pill shrink-0 ${meta.className}`}>{meta.label}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </PanelCard>

        <PanelCard
          title="Recent gigs"
          action={<Link to="/revenue" className="btn-link">Revenue</Link>}
        >
          {recentGigs.length === 0 ? (
            <EmptyRow message="No gigs recorded yet." />
          ) : (
            <ul className="divide-y divide-border">
              {recentGigs.map(({ campaign, when }) => (
                <li key={campaign.campaign_id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        to={`/campaigns/${campaign.campaign_id}`}
                        className="text-sm font-medium text-foreground hover:text-primary-600 hover:underline truncate block"
                      >
                        {campaign.name}
                      </Link>
                      <p className="text-xs text-muted-foreground truncate">
                        {partnerName(campaign)} · {formatShortDate(when)}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-semibold text-foreground">
                        {campaign.payout
                          ? formatMoney(campaign.payout.amount, campaign.payout.currency)
                          : '—'}
                      </div>
                      {campaign.payout && (
                        <div className="text-xs">
                          {campaign.payout.paid ? (
                            <span className="text-success-700">Paid</span>
                          ) : (
                            <span className="text-warning-700">Unpaid</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </PanelCard>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Revenue trend · {CURRENT_YEAR}</h2>
        <RevenueChart year={CURRENT_YEAR} monthGroups={thisYear.groups} currency={currency} />
      </section>
    </section>
  );
}

function DashboardHeader(): ReactElement {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground">
          Your latest content, plus any sponsorships and how the year is tracking.
        </p>
      </div>
      <Link to="/content" className="btn btn-primary w-auto">
        New content
      </Link>
    </header>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  accent?: 'warning' | 'success';
}): ReactElement {
  const valueColor =
    accent === 'warning'
      ? 'text-warning-700'
      : accent === 'success'
        ? 'text-success-700'
        : 'text-foreground';
  return (
    <div className="card card-body !py-4">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={`text-2xl font-semibold mt-1 block ${valueColor}`}>{value}</span>
      {sub && <span className="text-xs mt-1 block">{sub}</span>}
    </div>
  );
}

function PanelCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="card">
      <div className="card-header flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {action}
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}

function DeltaBadge({ pct }: { pct: number }): ReactElement {
  const rounded = Math.round(pct);
  const up = rounded >= 0;
  return (
    <span className={up ? 'text-success-700' : 'text-error-600'}>
      {up ? '▲' : '▼'} {Math.abs(rounded)}% vs {CURRENT_YEAR - 1}
    </span>
  );
}

function EmptyRow({ message }: { message: string }): ReactElement {
  return <p className="text-sm text-muted-foreground py-2">{message}</p>;
}

function deadlineMeta(days: number): { label: string; className: string } {
  if (days < 0) {
    return { label: `${Math.abs(days)}d overdue`, className: 'bg-error-100 text-error-700' };
  }
  if (days === 0) return { label: 'Due today', className: 'bg-warning-100 text-warning-800' };
  if (days === 1) return { label: 'Tomorrow', className: 'bg-warning-100 text-warning-800' };
  if (days <= 7) return { label: `${days}d left`, className: 'bg-warning-100 text-warning-800' };
  return { label: `${days}d left`, className: 'bg-secondary-100 text-secondary-700' };
}

// Whole-day difference between a YYYY-MM-DD date and today, in UTC.
// Positive = future, negative = past.
function daysUntil(dateStr: string): number {
  const target = Date.parse(`${dateStr.slice(0, 10)}T00:00:00Z`);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / 86_400_000);
}

// The date a gig is anchored to for "recent" ordering: when it wrapped,
// else when it started, else when the record was created.
function gigDate(c: Campaign): string {
  return c.endDate ?? c.startDate ?? c.created_at.slice(0, 10);
}

function formatShortDate(iso: string): string {
  const value = iso.length <= 10 ? `${iso}T00:00:00Z` : iso;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
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
