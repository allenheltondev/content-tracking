import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApiFetch, ApiError, type ApiFetch } from '../auth/useApiFetch';
import {
  createLink,
  createSocialPost,
  deleteSocialPost,
  getCampaign,
  getCampaignAnalytics,
  getCampaignWebAnalytics,
  updateCampaign,
} from '../api/campaigns';
import type {
  Campaign,
  CampaignAnalyticsResponse,
  CampaignBrief,
  CampaignDraft,
  CampaignLink,
  CampaignStatus,
  CoreWebVitalsSection,
  CreateLinkRequest,
  CreateSocialPostRequest,
  Ga4Section,
  SocialPost,
  VendorPayload,
  WebAnalyticsResponse,
} from '../api/types';
import { createVendor } from '../api/vendors';
import ClicksChart from '../components/ClicksChart';
import RegisterLinkForm from '../components/RegisterLinkForm';
import RegisterSocialPostForm from '../components/RegisterSocialPostForm';
import CampaignBriefSection from '../components/CampaignBriefSection';
import CampaignDraftTab from '../components/CampaignDraftTab';
import Modal from '../components/Modal';
import VendorForm from '../components/VendorForm';
import VendorSelect from '../components/VendorSelect';

type CampaignTab = 'overview' | 'brief' | 'draft' | 'promotion' | 'analytics';

interface CampaignBundle {
  campaign: Campaign;
  links: CampaignLink[];
  social_posts: SocialPost[];
  brief: CampaignBrief | null;
  draft: CampaignDraft | null;
}

export default function CampaignDetail(): ReactElement {
  const { campaignId } = useParams<{ campaignId: string }>();
  const apiFetch = useApiFetch();

  const [bundle, setBundle] = useState<CampaignBundle | null>(null);
  const [analytics, setAnalytics] = useState<CampaignAnalyticsResponse | null>(null);
  const [analyticsFetchedAt, setAnalyticsFetchedAt] = useState<Date | null>(null);
  const [analyticsRefreshing, setAnalyticsRefreshing] = useState(false);
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

  const [showLinkForm, setShowLinkForm] = useState(false);
  const [showPostForm, setShowPostForm] = useState(false);

  const [activeTab, setActiveTab] = useState<CampaignTab>('overview');

  // Campaign metadata + links. Cheap; fires on mount.
  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;
    setLoadError(null);
    getCampaign(apiFetch, campaignId)
      .then((res) => {
        if (!cancelled) setBundle(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, campaignId]);

  // Analytics. Whether the server takes the per-link fan-out path or the
  // one-shot newsletter-service campaignId rollup depends on the campaign's
  // link_tracking_id, so this re-runs whenever that value changes (e.g.,
  // the user just added one via the inline editor).
  const linkTrackingId = bundle?.campaign.link_tracking_id ?? null;
  const campaignLoaded = bundle !== null;
  useEffect(() => {
    if (!campaignId || !campaignLoaded) return;
    let cancelled = false;
    setAnalyticsError(null);
    getCampaignAnalytics(apiFetch, campaignId)
      .then((res) => {
        if (!cancelled) {
          setAnalytics(res);
          setAnalyticsFetchedAt(new Date());
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setAnalyticsError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, campaignId, campaignLoaded, linkTrackingId]);

  const refreshAnalytics = useCallback(async (): Promise<void> => {
    if (!campaignId) return;
    setAnalyticsRefreshing(true);
    setAnalyticsError(null);
    try {
      const res = await getCampaignAnalytics(apiFetch, campaignId);
      setAnalytics(res);
      setAnalyticsFetchedAt(new Date());
    } catch (err) {
      setAnalyticsError((err as Error).message);
    } finally {
      setAnalyticsRefreshing(false);
    }
  }, [apiFetch, campaignId]);

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
  //
  // The server adopts a "main" role link's destination URL as the
  // campaign's blog_url when blog_url is unset, so mirror that here so
  // the Overview tab updates without a refetch.
  const appendLinkAndRefresh = useCallback(
    (link: CampaignLink): void => {
      setBundle((prev) => {
        if (!prev) return prev;
        const next = { ...prev, links: [...prev.links, link] };
        if (link.role === 'main' && !prev.campaign.blog_url) {
          next.campaign = { ...prev.campaign, blog_url: link.url };
        }
        return next;
      });
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
      setShowLinkForm(false);
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
      setShowPostForm(false);
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

  const onCampaignChange = (updated: Campaign): void =>
    setBundle((prev) => (prev ? { ...prev, campaign: updated } : prev));

  return (
    <section className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1 flex-1 min-w-0">
          <NameEditor apiFetch={apiFetch} campaign={campaign} onCampaignChange={onCampaignChange} />
          <VendorEditor
            apiFetch={apiFetch}
            campaign={campaign}
            onCampaignChange={onCampaignChange}
          />
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

      <nav className="border-b border-border flex gap-1" aria-label="Campaign sections">
        <TabButton
          label="Overview"
          active={activeTab === 'overview'}
          onClick={() => setActiveTab('overview')}
        />
        <TabButton
          label="Brief"
          active={activeTab === 'brief'}
          onClick={() => setActiveTab('brief')}
        />
        <TabButton
          label="Draft"
          active={activeTab === 'draft'}
          onClick={() => setActiveTab('draft')}
        />
        <TabButton
          label="Promotion"
          active={activeTab === 'promotion'}
          onClick={() => setActiveTab('promotion')}
        />
        <TabButton
          label="Analytics"
          active={activeTab === 'analytics'}
          onClick={() => setActiveTab('analytics')}
        />
      </nav>

      {activeTab === 'overview' && (
        <>
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Status</dt>
              <dd className="text-sm mt-0.5">
                <StatusEditor
                  apiFetch={apiFetch}
                  campaign={campaign}
                  onCampaignChange={onCampaignChange}
                />
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Dates</dt>
              <dd className="text-sm mt-0.5">
                <DateRangeEditor
                  apiFetch={apiFetch}
                  campaign={campaign}
                  onCampaignChange={onCampaignChange}
                />
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Created</dt>
              <dd className="text-sm text-foreground mt-0.5">{campaign.created_at.slice(0, 10)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Payout</dt>
              <dd className="text-sm mt-0.5">
                <PayoutEditor
                  apiFetch={apiFetch}
                  campaign={campaign}
                  onCampaignChange={onCampaignChange}
                />
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Blog post</dt>
              <dd className="text-sm mt-0.5">
                <BlogUrlEditor
                  apiFetch={apiFetch}
                  campaign={campaign}
                  onCampaignChange={onCampaignChange}
                />
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Link tracking ID</dt>
              <dd className="text-sm mt-0.5">
                <LinkTrackingIdEditor
                  apiFetch={apiFetch}
                  campaign={campaign}
                  onCampaignChange={onCampaignChange}
                />
              </dd>
            </div>
          </dl>
        </>
      )}

      {activeTab === 'promotion' && (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-foreground">Links</h2>
              {!showLinkForm && (
                <button
                  type="button"
                  className="btn-secondary py-1 px-2 text-sm"
                  onClick={() => setShowLinkForm(true)}
                  aria-label="Register a new link"
                >
                  + Add link
                </button>
              )}
            </div>
            {links.length === 0 ? (
              <p className="text-muted-foreground">No links yet. Click + Add link to register one.</p>
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
                        <td className="text-muted-foreground">
                          {linkAnalytics?.total_clicks ?? '-'}
                        </td>
                        <td className="text-muted-foreground">
                          {linkAnalytics?.last_click_at?.slice(0, 10) ?? '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {showLinkForm && (
              <RegisterLinkForm
                busy={linkBusy}
                serverError={linkError}
                lastCreated={lastCreated}
                onCancel={() => {
                  setShowLinkForm(false);
                  setLinkError(null);
                }}
                onSubmit={(p) => void handleRegisterLink(p)}
              />
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-foreground">Social posts</h2>
                <p className="text-sm text-muted-foreground">
                  Engagement is captured automatically by the Booked browser extension when you
                  visit each post.{' '}
                  <span className="font-medium text-foreground">Last fetched</span> shows the most
                  recent capture.
                </p>
              </div>
              {!showPostForm && (
                <button
                  type="button"
                  className="btn-secondary py-1 px-2 text-sm shrink-0"
                  onClick={() => setShowPostForm(true)}
                  aria-label="Track a new social post"
                >
                  + Add post
                </button>
              )}
            </div>
            {postError && <p className="form-error">{postError}</p>}
            {socialPosts.length === 0 ? (
              <p className="text-muted-foreground">
                No social posts tracked yet. Click + Add post to start tracking one.
              </p>
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
                      <td className="text-muted-foreground">
                        {formatTimestamp(post.last_fetched)}
                      </td>
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
            {showPostForm && (
              <RegisterSocialPostForm
                busy={postBusy}
                serverError={postError}
                onCancel={() => {
                  setShowPostForm(false);
                  setPostError(null);
                }}
                onSubmit={(p) => void handleTrackPost(p)}
              />
            )}
          </section>
        </>
      )}

      {activeTab === 'brief' && (
        <CampaignBriefSection
          apiFetch={apiFetch}
          campaign={campaign}
          brief={bundle.brief}
          onBriefChange={(brief) => setBundle((prev) => (prev ? { ...prev, brief } : prev))}
          onCampaignChange={onCampaignChange}
          onLinkCreated={appendLinkAndRefresh}
        />
      )}

      {activeTab === 'analytics' && (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-foreground">Analytics</h2>
              <div className="flex items-center gap-3">
                {analyticsFetchedAt && (
                  <span className="text-xs text-muted-foreground">
                    Updated {analyticsFetchedAt.toLocaleTimeString()}
                  </span>
                )}
                <button
                  type="button"
                  className="btn-secondary py-1 px-2 text-sm"
                  onClick={() => void refreshAnalytics()}
                  disabled={analyticsRefreshing}
                >
                  {analyticsRefreshing ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
            </div>
            {analyticsError && (
              <p className="form-error">Could not load analytics: {analyticsError}</p>
            )}
            {!analytics && !analyticsError && (
              <p className="text-muted-foreground">Loading analytics...</p>
            )}
            {analytics && (
              <>
                <AnalyticsDiagnostic
                  campaign={campaign}
                  localLinkCount={links.length}
                  analytics={analytics}
                />
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
        </>
      )}

      {activeTab === 'draft' && (
        <CampaignDraftTab
          apiFetch={apiFetch}
          campaign={campaign}
          brief={bundle.brief}
          draft={bundle.draft}
          onDraftChange={(draft) => setBundle((prev) => (prev ? { ...prev, draft } : prev))}
        />
      )}
    </section>
  );
}

function TabButton({
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
      aria-current={active ? 'page' : undefined}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-primary-600 text-primary-700'
          : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
      }`}
    >
      {label}
    </button>
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

// Surfaces which analytics path the server took and flags the common
// "minted before the campaign got tagged" trap: setting link_tracking_id
// on a campaign whose links were already minted means newsletter-service
// returns nothing for that tag, even if the per-code clicks are real.
function AnalyticsDiagnostic({
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

interface EditScaffoldProps {
  editing: boolean;
  busy: boolean;
  error: string | null;
  hasValue: boolean;
  display: ReactElement;
  form: ReactElement;
  onStart: () => void;
  onCancel: () => void;
  onSave: () => void;
  emptyLabel?: string;
}

function EditScaffold({
  editing,
  busy,
  error,
  hasValue,
  display,
  form,
  onStart,
  onCancel,
  onSave,
  emptyLabel = 'Not set',
}: EditScaffoldProps): ReactElement {
  if (!editing) {
    return (
      <span className="inline-flex items-center gap-2 flex-wrap">
        {hasValue ? display : <span className="text-muted-foreground italic">{emptyLabel}</span>}
        <button type="button" className="btn-link" onClick={onStart}>
          {hasValue ? 'Edit' : 'Add'}
        </button>
      </span>
    );
  }
  return (
    <div className="space-y-2">
      {form}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-primary py-1 text-sm"
          onClick={onSave}
          disabled={busy}
        >
          {busy ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          className="btn-secondary py-1 text-sm"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

interface FieldEditorProps {
  apiFetch: ApiFetch;
  campaign: Campaign;
  onCampaignChange: (campaign: Campaign) => void;
}

function NameEditor({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(campaign.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = (): void => {
    setValue(campaign.name);
    setError(null);
    setEditing(true);
  };
  const cancel = (): void => {
    setEditing(false);
    setError(null);
  };
  const save = async (): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setError('Name is required.');
      return;
    }
    if (trimmed === campaign.name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, { name: trimmed });
      onCampaignChange(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EditScaffold
      editing={editing}
      busy={busy}
      error={error}
      hasValue
      onStart={start}
      onCancel={cancel}
      onSave={() => void save()}
      display={<h1 className="text-2xl font-semibold text-foreground">{campaign.name}</h1>}
      form={
        <input
          type="text"
          className="input text-lg"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') cancel();
          }}
        />
      }
    />
  );
}

// Links the campaign to a vendor record. Picking from the dropdown saves
// immediately; "+ Create new vendor…" opens an inline modal and links the
// freshly created vendor on save. Campaigns predating a vendor record may
// still carry a free-text `sponsor` — we show it until a vendor is linked.
function VendorEditor({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const save = async (vendorId: string): Promise<void> => {
    if (!vendorId || vendorId === campaign.vendor_id) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, {
        vendor_id: vendorId,
      });
      onCampaignChange(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async (payload: VendorPayload): Promise<void> => {
    setCreateBusy(true);
    setCreateError(null);
    try {
      const vendor = await createVendor(apiFetch, payload);
      setRefreshSignal((n) => n + 1);
      setModalOpen(false);
      await save(vendor.vendor_id);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setCreateBusy(false);
    }
  };

  const hasVendor = Boolean(campaign.vendor_id);

  return (
    <>
      {!editing ? (
        <span className="inline-flex items-center gap-2 flex-wrap">
          {hasVendor ? (
            <Link
              to={`/vendors/${campaign.vendor_id}`}
              className="text-primary-600 hover:underline"
            >
              {campaign.sponsor ?? campaign.vendor_id}
            </Link>
          ) : campaign.sponsor ? (
            <span className="text-muted-foreground">{campaign.sponsor}</span>
          ) : (
            <span className="text-muted-foreground italic">No vendor</span>
          )}
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              setError(null);
              setEditing(true);
            }}
          >
            {hasVendor ? 'Change' : campaign.sponsor ? 'Link vendor' : 'Add'}
          </button>
        </span>
      ) : (
        <div className="space-y-2 max-w-sm">
          <VendorSelect
            value={campaign.vendor_id ?? ''}
            onChange={(id) => void save(id)}
            onCreateNew={() => setModalOpen(true)}
            disabled={busy}
            refreshSignal={refreshSignal}
            autoFocus
            ariaLabel="Select vendor"
          />
          <div className="flex items-center gap-2">
            {busy && <span className="text-xs text-muted-foreground">Saving…</span>}
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>
      )}

      <Modal
        open={modalOpen}
        title="Create vendor"
        onClose={() => {
          if (!createBusy) {
            setModalOpen(false);
            setCreateError(null);
          }
        }}
      >
        <VendorForm
          busy={createBusy}
          serverError={createError}
          submitLabel="Create vendor"
          onSubmit={(p) => void handleCreate(p)}
          onCancel={() => {
            setModalOpen(false);
            setCreateError(null);
          }}
        />
      </Modal>
    </>
  );
}

function DateRangeEditor({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(campaign.startDate ?? '');
  const [end, setEnd] = useState(campaign.endDate ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = (): void => {
    setStart(campaign.startDate ?? '');
    setEnd(campaign.endDate ?? '');
    setError(null);
    setEditing(true);
  };
  const cancel = (): void => {
    setEditing(false);
    setError(null);
  };
  const save = async (): Promise<void> => {
    const sameStart = start === (campaign.startDate ?? '');
    const sameEnd = end === (campaign.endDate ?? '');
    if (sameStart && sameEnd) {
      setEditing(false);
      return;
    }
    if (start && end && end < start) {
      setError('End date must be on or after start date.');
      return;
    }
    const payload: { startDate?: string; endDate?: string } = {};
    if (start) payload.startDate = start;
    if (end) payload.endDate = end;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, payload);
      onCampaignChange(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hasDates = Boolean(campaign.startDate || campaign.endDate);
  return (
    <EditScaffold
      editing={editing}
      busy={busy}
      error={error}
      hasValue={hasDates}
      emptyLabel="No dates"
      onStart={begin}
      onCancel={cancel}
      onSave={() => void save()}
      display={
        <span className="text-foreground">
          {formatDateRange(campaign.startDate, campaign.endDate)}
        </span>
      }
      form={
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="date"
            className="input py-1 text-sm w-auto"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            disabled={busy}
            aria-label="Start date"
          />
          <span className="text-muted-foreground">→</span>
          <input
            type="date"
            className="input py-1 text-sm w-auto"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            disabled={busy}
            aria-label="End date"
          />
        </div>
      }
    />
  );
}

function BlogUrlEditor({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(campaign.blog_url ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = (): void => {
    setValue(campaign.blog_url ?? '');
    setError(null);
    setEditing(true);
  };
  const cancel = (): void => {
    setEditing(false);
    setError(null);
  };
  const save = async (): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed === (campaign.blog_url ?? '')) {
      setEditing(false);
      return;
    }
    if (trimmed.length === 0) {
      setError('Enter a URL, or cancel to leave the field unchanged.');
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      setError('URL must start with http:// or https://');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, { blog_url: trimmed });
      onCampaignChange(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EditScaffold
      editing={editing}
      busy={busy}
      error={error}
      hasValue={Boolean(campaign.blog_url)}
      emptyLabel="No blog post linked"
      onStart={start}
      onCancel={cancel}
      onSave={() => void save()}
      display={
        <a
          href={campaign.blog_url ?? '#'}
          target="_blank"
          rel="noreferrer"
          className="text-primary-600 hover:underline break-all"
        >
          {campaign.blog_url ? truncate(campaign.blog_url, 70) : ''}
        </a>
      }
      form={
        <input
          type="url"
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://blog.example.com/my-post"
          disabled={busy}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') cancel();
          }}
        />
      }
    />
  );
}

function PayoutEditor({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(
    campaign.payout?.amount !== undefined ? String(campaign.payout.amount) : '',
  );
  const [currency, setCurrency] = useState(campaign.payout?.currency ?? 'USD');
  const [paid, setPaid] = useState(campaign.payout?.paid ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = (): void => {
    setAmount(campaign.payout?.amount !== undefined ? String(campaign.payout.amount) : '');
    setCurrency(campaign.payout?.currency ?? 'USD');
    setPaid(campaign.payout?.paid ?? false);
    setError(null);
    setEditing(true);
  };
  const cancel = (): void => {
    setEditing(false);
    setError(null);
  };
  const save = async (): Promise<void> => {
    const trimmedAmount = amount.trim();
    if (trimmedAmount.length === 0) {
      setError('Enter a payout amount.');
      return;
    }
    const num = Number(trimmedAmount);
    if (!Number.isFinite(num) || num < 0) {
      setError('Amount must be a non-negative number.');
      return;
    }
    const trimmedCurrency = currency.toUpperCase().trim();
    if (!/^[A-Z]{3}$/.test(trimmedCurrency)) {
      setError('Currency must be a 3-letter ISO 4217 code (e.g., USD).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, {
        payout: { amount: num, currency: trimmedCurrency, paid },
      });
      onCampaignChange(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EditScaffold
      editing={editing}
      busy={busy}
      error={error}
      hasValue={Boolean(campaign.payout)}
      emptyLabel="No payout"
      onStart={start}
      onCancel={cancel}
      onSave={() => void save()}
      display={
        <span className="text-foreground">
          {campaign.payout?.amount} {campaign.payout?.currency}
          {campaign.payout?.paid ? ' (paid)' : ' (unpaid)'}
        </span>
      }
      form={
        <div className="grid grid-cols-3 gap-2">
          <input
            type="number"
            min={0}
            step="0.01"
            className="input py-1 text-sm"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount"
            disabled={busy}
            autoFocus
            aria-label="Payout amount"
          />
          <input
            type="text"
            maxLength={3}
            className="input py-1 text-sm uppercase"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            placeholder="USD"
            disabled={busy}
            aria-label="Payout currency"
          />
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="rounded border-border text-primary-600 focus:ring-primary-500"
              checked={paid}
              onChange={(e) => setPaid(e.target.checked)}
              disabled={busy}
            />
            Paid
          </label>
        </div>
      }
    />
  );
}

function StatusEditor({
  apiFetch,
  campaign,
  onCampaignChange,
}: {
  apiFetch: ApiFetch;
  campaign: Campaign;
  onCampaignChange: (campaign: Campaign) => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: CampaignStatus): Promise<void> => {
    if (next === campaign.status) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, { status: next });
      onCampaignChange(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <select
        className="input w-40 py-1 text-sm"
        value={campaign.status}
        onChange={(e) => void save(e.target.value as CampaignStatus)}
        disabled={busy}
        aria-label="Campaign status"
      >
        <option value="draft">draft</option>
        <option value="active">active</option>
        <option value="completed">completed</option>
      </select>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

function LinkTrackingIdEditor({
  apiFetch,
  campaign,
  onCampaignChange,
}: {
  apiFetch: ApiFetch;
  campaign: Campaign;
  onCampaignChange: (campaign: Campaign) => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(campaign.link_tracking_id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEdit = (): void => {
    setValue(campaign.link_tracking_id ?? '');
    setError(null);
    setEditing(true);
  };

  const cancel = (): void => {
    setEditing(false);
    setError(null);
  };

  const save = async (): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed === (campaign.link_tracking_id ?? '')) {
      setEditing(false);
      return;
    }
    if (trimmed.length === 0) {
      setError('Enter a value, or cancel to keep the field empty.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, {
        link_tracking_id: trimmed,
      });
      onCampaignChange(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-2">
        {campaign.link_tracking_id ? (
          <code className="bg-muted rounded px-1.5 py-0.5 text-xs font-mono">
            {campaign.link_tracking_id}
          </code>
        ) : (
          <span className="text-muted-foreground italic">Not set</span>
        )}
        <button type="button" className="btn-link" onClick={startEdit}>
          {campaign.link_tracking_id ? 'Edit' : 'Add'}
        </button>
      </span>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input
          type="text"
          className="input w-64 py-1 text-sm font-mono"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="acme-q2-launch"
          disabled={busy}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') cancel();
          }}
        />
        <button type="button" className="btn-primary py-1 text-sm" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving...' : 'Save'}
        </button>
        <button type="button" className="btn-secondary py-1 text-sm" onClick={cancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      <p className="text-xs text-muted-foreground">
        Tags every short link minted for this campaign so the newsletter service can group analytics
        by campaign. Existing links minted before this is set won't be retroactively tagged.
      </p>
    </div>
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
