import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApiFetch } from '../auth/useApiFetch';
import { getCampaign, getCampaignAnalytics } from '../api/campaigns';
import type {
  CampaignAnalyticsResponse,
  CampaignDetailResponse,
  CampaignLink,
} from '../api/types';
import ClicksChart from '../components/ClicksChart';

// Print-friendly campaign report. Renders outside the App shell so no
// nav, no sign-out button, no padding chrome shows up in the printed
// PDF. The "Print" action and any controls are hidden via print:hidden
// so the document is just the report when sent to paper or saved as
// PDF.
export default function CampaignReport(): ReactElement {
  const { campaignId } = useParams<{ campaignId: string }>();
  const apiFetch = useApiFetch();

  const [bundle, setBundle] = useState<CampaignDetailResponse | null>(null);
  const [analytics, setAnalytics] = useState<CampaignAnalyticsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);

  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;
    setLoadError(null);
    setAnalyticsError(null);

    getCampaign(apiFetch, campaignId)
      .then((res) => {
        if (!cancelled) setBundle(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });

    getCampaignAnalytics(apiFetch, campaignId)
      .then((res) => {
        if (!cancelled) setAnalytics(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setAnalyticsError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [apiFetch, campaignId]);

  if (loadError) {
    return (
      <main className="max-w-3xl mx-auto p-8">
        <h1 className="text-2xl font-semibold">Campaign not found</h1>
        <p className="form-error">{loadError}</p>
        <Link to="/campaigns" className="btn-link">
          Back to campaigns
        </Link>
      </main>
    );
  }

  if (!bundle) {
    return (
      <main className="max-w-3xl mx-auto p-8 text-muted-foreground">Loading report...</main>
    );
  }

  const { campaign, links } = bundle;

  return (
    <main className="report-page max-w-4xl mx-auto p-4 sm:p-8 print:p-0 bg-surface text-foreground">
      <div className="flex items-center justify-between gap-4 mb-8 print:hidden">
        <Link to={`/campaigns/${campaign.campaign_id}`} className="btn-link">
          ← Back to campaign
        </Link>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>
          Print to PDF
        </button>
      </div>

      <header className="border-b border-border pb-5 mb-8 print:break-inside-avoid">
        <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">{campaign.name}</h1>
        <dl className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
          {campaign.sponsor && (
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Sponsor</dt>
              <dd className="text-foreground">{campaign.sponsor}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Dates</dt>
            <dd className="text-foreground">{formatDateRange(campaign.startDate, campaign.endDate)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Status</dt>
            <dd className="text-foreground capitalize">{campaign.status}</dd>
          </div>
        </dl>
      </header>

      <section className="mb-6 print:break-inside-avoid">
        <h2 className="text-lg font-semibold text-foreground mb-3">Summary</h2>
        {analyticsError && (
          <p className="form-error">Could not load analytics: {analyticsError}</p>
        )}
        {!analytics && !analyticsError && (
          <p className="text-muted-foreground">Loading analytics...</p>
        )}
        {analytics && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <Tile label="Total clicks" value={analytics.total_clicks.toLocaleString()} />
              <Tile label="Links tracked" value={String(analytics.link_count)} />
              <Tile
                label="First click"
                value={
                  pickEarliest(analytics.links.map((l) => l.first_click_at)) ?? '-'
                }
              />
              <Tile
                label="Last click"
                value={pickLatest(analytics.links.map((l) => l.last_click_at)) ?? '-'}
              />
            </div>
            {analytics.upstream_failures > 0 && (
              <p className="text-xs text-muted-foreground">
                Note: {analytics.upstream_failures} of {analytics.link_count} link analytics
                fetches failed and are excluded from totals above.
              </p>
            )}
          </>
        )}
      </section>

      {analytics && Object.keys(analytics.by_src).length > 0 && (
        <section className="mb-6 print:break-inside-avoid">
          <h2 className="text-lg font-semibold text-foreground mb-3">Clicks by source</h2>
          <BreakdownTable
            data={analytics.by_src}
            total={analytics.total_clicks}
            keyHeader="Source"
          />
        </section>
      )}

      {analytics && (
        <section className="mb-6 print:break-inside-avoid">
          <h2 className="text-lg font-semibold text-foreground mb-3">Daily clicks</h2>
          <div className="print:max-h-72">
            <ClicksChart byDay={analytics.by_day} />
          </div>
        </section>
      )}

      <section className="print:break-inside-auto">
        <h2 className="text-lg font-semibold text-foreground mb-3">Links</h2>
        {links.length === 0 ? (
          <p className="text-muted-foreground">No links registered for this campaign.</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Destination</th>
                <th>Short URL</th>
                <th className="text-right">Clicks</th>
                <th>First clicked</th>
                <th>Last clicked</th>
              </tr>
            </thead>
            <tbody>
              {sortedLinks(links, analytics).map(({ link, clicks, first, last }) => (
                <tr key={link.link_id} className="print:break-inside-avoid">
                  <td>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary-600 hover:underline"
                    >
                      {truncate(link.url, 60)}
                    </a>
                  </td>
                  <td className="font-mono text-xs">{link.short_url}</td>
                  <td className="text-right">{clicks?.toLocaleString() ?? '-'}</td>
                  <td className="text-muted-foreground">
                    {first ? first.slice(0, 10) : '-'}
                  </td>
                  <td className="text-muted-foreground">
                    {last ? last.slice(0, 10) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <footer className="mt-8 pt-4 border-t border-border text-xs text-muted-foreground">
        Generated from Booked on {new Date().toISOString().slice(0, 10)}.
      </footer>
    </main>
  );
}

function Tile({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="card card-body !py-3 print:shadow-none print:border print:border-border">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold text-foreground mt-1 block">{value}</span>
    </div>
  );
}

function BreakdownTable({
  data,
  total,
  keyHeader = 'Platform',
}: {
  data: Record<string, number>;
  total: number;
  keyHeader?: string;
}): ReactElement {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  return (
    <div className="overflow-x-auto">
    <table className="data-table">
      <thead>
        <tr>
          <th>{keyHeader}</th>
          <th className="text-right">Clicks</th>
          <th className="text-right">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, value]) => (
          <tr key={key} className="print:break-inside-avoid">
            <td>{key}</td>
            <td className="text-right">{value.toLocaleString()}</td>
            <td className="text-right text-muted-foreground">
              {total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '-'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

interface LinkWithStats {
  link: CampaignLink;
  clicks: number | undefined;
  first: string | null;
  last: string | null;
}

function sortedLinks(
  links: CampaignLink[],
  analytics: CampaignAnalyticsResponse | null,
): LinkWithStats[] {
  const statsByLink = new Map(
    analytics?.links.map(
      (l) => [l.link_id, { clicks: l.total_clicks, first: l.first_click_at, last: l.last_click_at }] as const,
    ) ?? [],
  );
  return links
    .map((link) => {
      const s = statsByLink.get(link.link_id);
      return {
        link,
        clicks: s?.clicks,
        first: s?.first ?? null,
        last: s?.last ?? null,
      };
    })
    .sort((a, b) => (b.clicks ?? 0) - (a.clicks ?? 0));
}

function pickEarliest(values: (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (!best || v < best) best = v;
  }
  return best ? best.slice(0, 10) : null;
}

function pickLatest(values: (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (!best || v > best) best = v;
  }
  return best ? best.slice(0, 10) : null;
}

function formatDateRange(startDate: string | null, endDate: string | null): string {
  if (!startDate && !endDate) return '-';
  if (startDate && endDate) return `${startDate} to ${endDate}`;
  return startDate ?? endDate ?? '-';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
