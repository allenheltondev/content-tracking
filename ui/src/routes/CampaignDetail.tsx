import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import {
  createLink,
  createSocialPost,
  deleteSocialPost,
  getCampaign,
  getCampaignAnalytics,
  getCampaignWebAnalytics,
} from '../api/campaigns';
import type {
  Campaign,
  CampaignAnalyticsResponse,
  CampaignBrief,
  CampaignLink,
  CoreWebVitalsSection,
  CreateLinkRequest,
  CreateSocialPostRequest,
  Ga4Section,
  SocialPost,
  WebAnalyticsResponse,
} from '../api/types';
import ClicksChart from '../components/ClicksChart';
import RegisterLinkForm from '../components/RegisterLinkForm';
import RegisterSocialPostForm from '../components/RegisterSocialPostForm';
import CampaignBriefSection from '../components/CampaignBriefSection';

interface CampaignBundle {
  campaign: Campaign;
  links: CampaignLink[];
  social_posts: SocialPost[];
  brief: CampaignBrief | null;
}

export default function CampaignDetail(): ReactElement {
  const { campaignId } = useParams<{ campaignId: string }>();
  const apiFetch = useApiFetch();

  const [bundle, setBundle] = useState<CampaignBundle | null>(null);
  const [analytics, setAnalytics] = useState<CampaignAnalyticsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);

  const [webAnalytics, setWebAnalytics] = useState<WebAnalyticsResponse | null>(null);
  const [webAnalyticsError, setWebAnalyticsError] = useState<string | null>(null);
  const [webAnalyticsLoading, setWebAnalyticsLoading] = useState(false);

  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [lastCreated, setLastCreated] = useState<CampaignLink | null>(null);

  const [postBusy, setPostBusy] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

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

  // Web analytics (GA4 + Core Web Vitals) only make sense once we know the
  // campaign's blog URL, and the call is slow (it hits Google), so it runs
  // on its own after the campaign loads and only when a blogUrl is set.
  const blogUrl = bundle?.campaign.blog_url ?? null;
  useEffect(() => {
    if (!campaignId || !blogUrl) {
      setWebAnalytics(null);
      return;
    }
    let cancelled = false;
    setWebAnalyticsLoading(true);
    setWebAnalyticsError(null);
    getCampaignWebAnalytics(apiFetch, campaignId)
      .then((res) => {
        if (!cancelled) setWebAnalytics(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setWebAnalyticsError(err.message);
      })
      .finally(() => {
        if (!cancelled) setWebAnalyticsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, campaignId, blogUrl]);

  // Optimistically append a freshly minted link and rerun analytics. The
  // new link has zero clicks so the chart won't change, but link count and
  // tables should reflect it immediately. Shared by the Links form and the
  // brief's per-deliverable short-link creator.
  const appendLinkAndRefresh = useCallback(
    (link: CampaignLink): void => {
      setBundle((prev) => (prev ? { ...prev, links: [...prev.links, link] } : prev));
      if (!campaignId) return;
      getCampaignAnalytics(apiFetch, campaignId)
        .then((res) => setAnalytics(res))
        .catch((err: Error) => setAnalyticsError(err.message));
    },
    [apiFetch, campaignId],
  );

  const handleRegisterLink = async (payload: CreateLinkRequest): Promise<void> => {
    if (!campaignId) return;
    setLinkBusy(true);
    setLinkError(null);
    try {
      const link = await createLink(apiFetch, campaignId, payload);
      setLastCreated(link);
      appendLinkAndRefresh(link);
    } catch (err) {
      setLinkError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setLinkBusy(false);
    }
  };

  const handleTrackPost = async (payload: CreateSocialPostRequest): Promise<void> => {
    if (!campaignId) return;
    setPostBusy(true);
    setPostError(null);
    try {
      const post = await createSocialPost(apiFetch, campaignId, payload);
      setBundle((prev) =>
        prev ? { ...prev, social_posts: [...prev.social_posts, post] } : prev,
      );
    } catch (err) {
      setPostError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setPostBusy(false);
    }
  };

  const handleDeletePost = async (postId: string): Promise<void> => {
    if (!campaignId) return;
    setPostError(null);
    try {
      await deleteSocialPost(apiFetch, campaignId, postId);
      setBundle((prev) =>
        prev
          ? { ...prev, social_posts: prev.social_posts.filter((p) => p.post_id !== postId) }
          : prev,
      );
    } catch (err) {
      setPostError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  if (loadError) {
    return (
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold">Campaign not found</h1>
        <p className="form-error">{loadError}</p>
        <Link to="/campaigns" className="btn-link">
          Back to campaigns
        </Link>
      </section>
    );
  }

  if (!bundle) {
    return (
      <section>
        <h1 className="text-2xl font-semibold">Campaign</h1>
        <p className="text-muted-foreground">Loading...</p>
      </section>
    );
  }

  const { campaign, links, social_posts: socialPosts } = bundle;

  return (
    <section className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">{campaign.name}</h1>
          {campaign.sponsor && <p className="text-muted-foreground">{campaign.sponsor}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={`/campaigns/${campaign.campaign_id}/report`}
            target="_blank"
            rel="noreferrer"
            className="btn-secondary"
          >
            Sponsor report
          </Link>
          <span className={`status-pill status-${campaign.status}`}>{campaign.status}</span>
        </div>
      </header>

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Dates</dt>
          <dd className="text-sm text-foreground mt-0.5">
            {formatDateRange(campaign.startDate, campaign.endDate)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Created</dt>
          <dd className="text-sm text-foreground mt-0.5">{campaign.created_at.slice(0, 10)}</dd>
        </div>
        {campaign.payout && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Payout</dt>
            <dd className="text-sm text-foreground mt-0.5">
              {campaign.payout.amount} {campaign.payout.currency}
              {campaign.payout.paid ? ' (paid)' : ' (unpaid)'}
            </dd>
          </div>
        )}
        {campaign.blog_url && (
          <div className="col-span-2">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Blog post</dt>
            <dd className="text-sm mt-0.5">
              <a
                href={campaign.blog_url}
                target="_blank"
                rel="noreferrer"
                className="text-primary-600 hover:underline"
              >
                {truncate(campaign.blog_url, 70)}
              </a>
            </dd>
          </div>
        )}
      </dl>

      <CampaignBriefSection
        apiFetch={apiFetch}
        campaign={campaign}
        brief={bundle.brief}
        onBriefChange={(brief) => setBundle((prev) => (prev ? { ...prev, brief } : prev))}
        onCampaignChange={(updated) =>
          setBundle((prev) => (prev ? { ...prev, campaign: updated } : prev))
        }
        onLinkCreated={appendLinkAndRefresh}
      />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Analytics</h2>
        {analyticsError && (
          <p className="form-error">Could not load analytics: {analyticsError}</p>
        )}
        {!analytics && !analyticsError && <p className="text-muted-foreground">Loading analytics...</p>}
        {analytics && (
          <>
            {analytics.upstream_failures > 0 && (
              <p className="rounded-md border border-warning-200 bg-warning-50 text-warning-900 text-sm px-3 py-2">
                {analytics.upstream_failures} of {analytics.link_count} link analytics calls
                failed. Totals below exclude those.
              </p>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Tile label="Total clicks" value={analytics.total_clicks.toLocaleString()} />
              <Tile label="Links" value={String(analytics.link_count)} />
            </div>

            <h3 className="text-sm font-medium text-foreground mt-2">Clicks per day</h3>
            <ClicksChart byDay={analytics.by_day} />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Breakdown title="By role" data={analytics.by_role} />
              <Breakdown title="By platform" data={analytics.by_platform} />
            </div>
          </>
        )}
      </section>

      <WebAnalyticsSection
        blogUrl={campaign.blog_url}
        data={webAnalytics}
        loading={webAnalyticsLoading}
        error={webAnalyticsError}
      />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Links</h2>
        {links.length === 0 ? (
          <p className="text-muted-foreground">No links yet. Register one below.</p>
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
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary-600 hover:underline"
                      >
                        {truncate(link.url, 60)}
                      </a>
                    </td>
                    <td className="text-muted-foreground">{linkAnalytics?.total_clicks ?? '-'}</td>
                    <td className="text-muted-foreground">
                      {linkAnalytics?.last_click_at?.slice(0, 10) ?? '-'}
                    </td>
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

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-foreground">Social posts</h2>
          <p className="text-sm text-muted-foreground">
            Engagement is captured automatically by the Booked browser extension when you visit
            each post. <span className="font-medium text-foreground">Last fetched</span> shows the
            most recent capture.
          </p>
        </div>
        {postError && <p className="form-error">{postError}</p>}
        {socialPosts.length === 0 ? (
          <p className="text-muted-foreground">No social posts tracked yet. Add one below.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Post</th>
                <th>Engagement</th>
                <th>Last fetched</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {socialPosts.map((post) => (
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
                    {post.notes && (
                      <span className="block text-xs text-muted-foreground">{post.notes}</span>
                    )}
                  </td>
                  <td className="text-muted-foreground">{formatMetrics(post.analytics)}</td>
                  <td className="text-muted-foreground">{formatTimestamp(post.last_fetched)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn-link text-error-600"
                      onClick={() => void handleDeletePost(post.post_id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <RegisterSocialPostForm
          busy={postBusy}
          serverError={postError}
          onSubmit={(p) => void handleTrackPost(p)}
        />
      </section>
    </section>
  );
}

function formatMetrics(analytics: Record<string, number> | null): string {
  if (!analytics) return '—';
  const entries = Object.entries(analytics);
  if (entries.length === 0) return '—';
  return entries.map(([key, value]) => `${key}: ${value.toLocaleString()}`).join(' · ');
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? 'never' : d.toLocaleString();
}

function Tile({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="card card-body !py-3">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold text-foreground mt-1 block">{value}</span>
    </div>
  );
}

function Breakdown({ title, data }: { title: string; data: Record<string, number> }): ReactElement {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  return (
    <div className="card card-body">
      <h4 className="text-sm font-semibold text-foreground mb-2">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No data.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map(([key, value]) => (
            <li key={key} className="flex justify-between text-sm">
              <span className="text-muted-foreground">{key}</span>
              <span className="text-foreground font-medium">{value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WebAnalyticsSection({
  blogUrl,
  data,
  loading,
  error,
}: {
  blogUrl: string | null;
  data: WebAnalyticsResponse | null;
  loading: boolean;
  error: string | null;
}): ReactElement {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">Web analytics</h2>
      {!blogUrl ? (
        <p className="text-sm text-muted-foreground">
          Set a blog post URL on this campaign to pull GA4 traffic and Core Web Vitals.
        </p>
      ) : (
        <>
          {error && <p className="form-error">Could not load web analytics: {error}</p>}
          {loading && !data && <p className="text-muted-foreground">Loading web analytics...</p>}
          {data && (
            <>
              <Ga4Block ga4={data.ga4} />
              <CoreWebVitalsBlock cwv={data.core_web_vitals} />
            </>
          )}
        </>
      )}
    </section>
  );
}

function Ga4Block({ ga4 }: { ga4: Ga4Section }): ReactElement {
  if (!ga4.configured) {
    return <NotConnected label="Google Analytics 4" />;
  }
  if (ga4.error || !ga4.totals) {
    return (
      <div className="card card-body">
        <h3 className="text-sm font-semibold text-foreground mb-1">Google Analytics 4</h3>
        <p className="form-error">{ga4.error ?? 'No data returned.'}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">Google Analytics 4</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="Pageviews" value={ga4.totals.pageviews.toLocaleString()} />
        <Tile label="Users" value={ga4.totals.users.toLocaleString()} />
        <Tile label="Sessions" value={ga4.totals.sessions.toLocaleString()} />
        <Tile label="Engagement" value={formatPercent(ga4.totals.engagement_rate)} />
        <Tile label="Avg. session" value={formatDuration(ga4.totals.avg_session_duration)} />
        <Tile label="Bounce rate" value={formatPercent(ga4.totals.bounce_rate)} />
      </div>
      {ga4.by_day && Object.keys(ga4.by_day).length > 0 && (
        <>
          <h4 className="text-sm font-medium text-foreground mt-2">Pageviews per day</h4>
          <ClicksChart byDay={ga4.by_day} />
        </>
      )}
    </div>
  );
}

function CoreWebVitalsBlock({ cwv }: { cwv: CoreWebVitalsSection }): ReactElement {
  if (!cwv.configured) {
    return <NotConnected label="Core Web Vitals" />;
  }
  if (cwv.error || !cwv.metrics) {
    return (
      <div className="card card-body">
        <h3 className="text-sm font-semibold text-foreground mb-1">Core Web Vitals</h3>
        <p className="form-error">{cwv.error ?? 'No data returned.'}</p>
      </div>
    );
  }
  const sourceLabel =
    cwv.source === 'crux' ? 'real-user field data (CrUX)' : 'lab estimate (PageSpeed Insights)';
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-foreground">Core Web Vitals</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="LCP" value={formatMs(cwv.metrics.lcp_ms)} />
        <Tile label="CLS" value={formatCls(cwv.metrics.cls)} />
        <Tile label="INP" value={formatMs(cwv.metrics.inp_ms)} />
        <Tile label="FCP" value={formatMs(cwv.metrics.fcp_ms)} />
      </div>
      <p className="text-xs text-muted-foreground">
        Source: {sourceLabel}
        {typeof cwv.performance_score === 'number' &&
          ` · Performance score ${Math.round(cwv.performance_score * 100)}`}
      </p>
    </div>
  );
}

function NotConnected({ label }: { label: string }): ReactElement {
  return (
    <div className="card card-body">
      <h3 className="text-sm font-semibold text-foreground mb-1">{label}</h3>
      <p className="text-sm text-muted-foreground">
        Not connected.{' '}
        <Link to="/settings" className="text-primary-600 hover:underline">
          Connect it in Settings
        </Link>
        .
      </p>
    </div>
  );
}

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function formatCls(cls: number | null | undefined): string {
  return cls === null || cls === undefined ? '—' : cls.toFixed(3);
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '0s';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function CopyableShortUrl({ url }: { url: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <code className="bg-muted text-foreground rounded px-1.5 py-0.5 text-xs font-mono">{url}</code>
      <button
        type="button"
        className="btn-link"
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
