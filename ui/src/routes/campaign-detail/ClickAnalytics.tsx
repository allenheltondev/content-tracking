import type { ReactElement } from 'react';
import type { Campaign, CampaignAnalyticsResponse } from '../../api/types';
import Tile from '../../components/Tile';
import { fmtPercentWhole, formatDate, truncate } from '../../lib/format';

// Click analytics for the Analytics tab: summary tiles, per-dimension
// breakdowns, the per-link table, and the served-path diagnostic.


// Surfaces which analytics path the server took and flags the common
// "minted before the campaign got tagged" trap: setting link_tracking_id
// on a campaign whose links were already minted means newsletter-service
// returns nothing for that tag, even if the per-code clicks are real.
export function AnalyticsDiagnostic({
  campaign,
  localLinkCount,
  analytics,
}: {
  campaign: Campaign;
  localLinkCount: number;
  analytics: CampaignAnalyticsResponse;
}): ReactElement | null {
  const hasTrackingId = Boolean(campaign.link_tracking_id);
  const mode = hasTrackingId ? 'rollup' : 'fan-out';
  const mintedBeforeTag =
    hasTrackingId && localLinkCount > 0 && analytics.link_count < localLinkCount;

  if (mintedBeforeTag) {
    return (
      <div className="rounded-md border border-warning-200 bg-warning-50 text-warning-900 text-sm px-3 py-2 space-y-1">
        <p>
          <strong>Heads up:</strong> {localLinkCount} link
          {localLinkCount === 1 ? '' : 's'} registered locally, but only{' '}
          {analytics.link_count} tagged with <code>{campaign.link_tracking_id}</code> upstream.
        </p>
        <p>
          Links minted before the campaign got a tracking ID aren't retagged. Re-register them, or
          clear the tracking ID to fall back to per-link click lookups.
        </p>
      </div>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Source: {mode} ({analytics.link_count} link{analytics.link_count === 1 ? '' : 's'})
    </p>
  );
}

export function ClickSummaryTiles({
  analytics,
}: {
  analytics: CampaignAnalyticsResponse;
}): ReactElement {
  const first = pickEarliest(analytics.links.map((l) => l.first_click_at));
  const last = pickLatest(analytics.links.map((l) => l.last_click_at));
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <Tile label="Total clicks" value={analytics.total_clicks.toLocaleString()} />
      <Tile
        label="Links"
        value={String(analytics.link_count)}
        sublabel={
          analytics.upstream_failures > 0
            ? `${analytics.upstream_failures} failed upstream`
            : null
        }
      />
      <Tile
        label="First click"
        value={first ? formatRelative(first) : '—'}
        sublabel={first ? formatDate(first) : null}
      />
      <Tile
        label="Last click"
        value={last ? formatRelative(last) : '—'}
        sublabel={last ? formatDate(last) : null}
      />
    </div>
  );
}

export function ClickBreakdowns({
  analytics,
}: {
  analytics: CampaignAnalyticsResponse;
}): ReactElement | null {
  if (Object.keys(analytics.by_src).length === 0) return null;
  return (
    <Breakdown
      title="By source"
      counts={analytics.by_src}
      total={analytics.total_clicks}
      emptyLabel="No tagged sources"
    />
  );
}

function Breakdown({
  title,
  counts,
  total,
  formatKey,
  emptyLabel = 'No data',
}: {
  title: string;
  counts: Record<string, number>;
  total: number;
  formatKey?: (key: string) => string;
  emptyLabel?: string;
}): ReactElement {
  const rows = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <div className="card card-body !py-3 space-y-2">
      <h4 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
        {title}
      </h4>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map(([key, n]) => {
            const pct = total > 0 ? n / total : 0;
            return (
              <li key={key} className="space-y-0.5">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-foreground truncate">
                    {formatKey ? formatKey(key) : key}
                  </span>
                  <span className="text-muted-foreground shrink-0">
                    {n.toLocaleString()}
                    <span className="ml-1 text-xs">({fmtPercentWhole(pct)})</span>
                  </span>
                </div>
                <div className="h-1.5 rounded bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary-600"
                    style={{ width: `${Math.max(2, Math.round(pct * 100))}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ClickLinkTable({
  analytics,
}: {
  analytics: CampaignAnalyticsResponse;
}): ReactElement | null {
  if (analytics.links.length === 0) return null;
  const rows = [...analytics.links].sort(
    (a, b) => (b.total_clicks ?? 0) - (a.total_clicks ?? 0),
  );
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-foreground mt-2">Per-link clicks</h3>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Destination</th>
              <th className="text-right">Clicks</th>
              <th>First clicked</th>
              <th>Last clicked</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.code}>
                <td>
                  {l.url ? (
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary-600 hover:underline"
                    >
                      {truncate(l.url, 60)}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="text-right tabular-nums">
                  {l.error ? (
                    <span className="text-error-600" title={l.error}>
                      error
                    </span>
                  ) : (
                    l.total_clicks.toLocaleString()
                  )}
                </td>
                <td className="text-muted-foreground" title={l.first_click_at ?? ''}>
                  {l.first_click_at ? formatDate(l.first_click_at) : '—'}
                </td>
                <td className="text-muted-foreground" title={l.last_click_at ?? ''}>
                  {l.last_click_at ? formatRelative(l.last_click_at) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function pickEarliest(values: (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (!best || v < best) best = v;
  }
  return best;
}

function pickLatest(values: (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (!best || v > best) best = v;
  }
  return best;
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  let phrase: string;
  if (sec < 60) phrase = `${sec}s`;
  else if (min < 60) phrase = `${min}m`;
  else if (hr < 48) phrase = `${hr}h`;
  else if (day < 30) phrase = `${day}d`;
  else return d.toLocaleDateString();
  return future ? `in ${phrase}` : `${phrase} ago`;
}

