import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import {
  createLink,
  getCampaign,
  getCampaignAnalytics,
} from '../api/campaigns';
import type {
  Campaign,
  CampaignAnalyticsResponse,
  CampaignLink,
  CreateLinkRequest,
} from '../api/types';
import ClicksChart from '../components/ClicksChart';
import RegisterLinkForm from '../components/RegisterLinkForm';

interface LocationState {
  fromBriefId?: string;
}

interface CampaignBundle {
  campaign: Campaign;
  links: CampaignLink[];
}

export default function CampaignDetail(): ReactElement {
  const { campaignId } = useParams<{ campaignId: string }>();
  const location = useLocation();
  const apiFetch = useApiFetch();
  const state = (location.state ?? {}) as LocationState;

  const [bundle, setBundle] = useState<CampaignBundle | null>(null);
  const [analytics, setAnalytics] = useState<CampaignAnalyticsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);

  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [lastCreated, setLastCreated] = useState<CampaignLink | null>(null);

  // Two parallel fetches: campaign metadata + links is cheap, analytics
  // fans out to newsletter-service per link and is slower. Render each
  // section as soon as its data lands.
  const loadAll = useCallback((): { cancel: () => void } => {
    if (!campaignId) return { cancel: () => undefined };
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

    return {
      cancel: () => {
        cancelled = true;
      },
    };
  }, [apiFetch, campaignId]);

  useEffect(() => {
    const { cancel } = loadAll();
    return cancel;
  }, [loadAll]);

  const handleRegisterLink = async (payload: CreateLinkRequest): Promise<void> => {
    if (!campaignId) return;
    setLinkBusy(true);
    setLinkError(null);
    try {
      const link = await createLink(apiFetch, campaignId, payload);
      setLastCreated(link);
      // Optimistically append to the links list and rerun analytics. The
      // new link has zero clicks so the chart won't change, but link
      // count and tables should reflect it immediately.
      setBundle((prev) => (prev ? { ...prev, links: [...prev.links, link] } : prev));
      getCampaignAnalytics(apiFetch, campaignId)
        .then((res) => setAnalytics(res))
        .catch((err: Error) => setAnalyticsError(err.message));
    } catch (err) {
      setLinkError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setLinkBusy(false);
    }
  };

  if (loadError) {
    return (
      <section className="campaign-detail">
        <h1>Campaign not found</h1>
        <p className="form-error">{loadError}</p>
        <Link to="/campaigns">Back to campaigns</Link>
      </section>
    );
  }

  if (!bundle) {
    return (
      <section className="campaign-detail">
        <h1>Campaign</h1>
        <p>Loading...</p>
      </section>
    );
  }

  const { campaign, links } = bundle;

  return (
    <section className="campaign-detail">
      <header className="page-header">
        <div>
          <h1>
            {campaign.name}
            {state.fromBriefId && <span className="from-brief-badge">From brief</span>}
          </h1>
          {campaign.sponsor && <p className="page-subtitle">{campaign.sponsor}</p>}
          {state.fromBriefId && (
            <p className="page-subtitle">
              <Link to={`/briefs/${state.fromBriefId}`}>View source brief</Link>
            </p>
          )}
        </div>
        <span className={`status-pill status-${campaign.status}`}>{campaign.status}</span>
      </header>

      <dl className="metadata-grid">
        <div>
          <dt>Dates</dt>
          <dd>{formatDateRange(campaign.startDate, campaign.endDate)}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{campaign.created_at.slice(0, 10)}</dd>
        </div>
        {campaign.payout && (
          <div>
            <dt>Payout</dt>
            <dd>
              {campaign.payout.amount} {campaign.payout.currency}
              {campaign.payout.paid ? ' (paid)' : ' (unpaid)'}
            </dd>
          </div>
        )}
      </dl>

      <section className="analytics-section">
        <h2>Analytics</h2>
        {analyticsError && (
          <p className="form-error">Could not load analytics: {analyticsError}</p>
        )}
        {!analytics && !analyticsError && <p>Loading analytics...</p>}
        {analytics && (
          <>
            {analytics.upstream_failures > 0 && (
              <p className="form-warning">
                {analytics.upstream_failures} of {analytics.link_count} link analytics calls
                failed. Totals below exclude those.
              </p>
            )}
            <div className="analytics-tiles">
              <div className="tile">
                <span className="tile-label">Total clicks</span>
                <span className="tile-value">{analytics.total_clicks.toLocaleString()}</span>
              </div>
              <div className="tile">
                <span className="tile-label">Links</span>
                <span className="tile-value">{analytics.link_count}</span>
              </div>
            </div>

            <h3>Clicks per day</h3>
            <ClicksChart byDay={analytics.by_day} />

            <div className="breakdown-row">
              <Breakdown title="By role" data={analytics.by_role} />
              <Breakdown title="By platform" data={analytics.by_platform} />
            </div>
          </>
        )}
      </section>

      <section className="links-section">
        <h2>Links</h2>
        {links.length === 0 ? (
          <p>No links yet. Register one below.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Platform</th>
                <th>Short URL</th>
                <th>Destination</th>
                <th>Clicks</th>
                <th>Last clicked</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => {
                const linkAnalytics = analytics?.links.find((l) => l.link_id === link.link_id);
                return (
                  <tr key={link.link_id}>
                    <td>{link.role}</td>
                    <td>{link.platform}</td>
                    <td>
                      <CopyableShortUrl url={link.short_url} />
                    </td>
                    <td>
                      <a href={link.url} target="_blank" rel="noreferrer">
                        {truncate(link.url, 60)}
                      </a>
                    </td>
                    <td>{linkAnalytics?.total_clicks ?? '-'}</td>
                    <td>{linkAnalytics?.last_click_at?.slice(0, 10) ?? '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <RegisterLinkForm
          busy={linkBusy}
          serverError={linkError}
          lastCreated={lastCreated}
          onSubmit={(p) => void handleRegisterLink(p)}
        />
      </section>
    </section>
  );
}

function Breakdown({ title, data }: { title: string; data: Record<string, number> }): ReactElement {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  return (
    <div className="breakdown">
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="kv-empty">No data.</p>
      ) : (
        <ul>
          {rows.map(([key, value]) => (
            <li key={key}>
              <span>{key}</span>
              <span>{value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CopyableShortUrl({ url }: { url: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <span className="short-url-cell">
      <code>{url}</code>
      <button
        type="button"
        className="link-button"
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

function formatDateRange(startDate: string | null, endDate: string | null): string {
  if (!startDate && !endDate) return '-';
  if (startDate && endDate) return `${startDate} → ${endDate}`;
  return startDate ?? endDate ?? '-';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
